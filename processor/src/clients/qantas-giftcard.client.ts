import { randomUUID } from 'crypto';
import { getConfig } from '../config/config';
import { log } from '../libs/logger';
import {
  MockClientBalanceResponse,
  MockClientRedeemRequest,
  MockClientRedeemResponse,
  MockClientRollbackResponse,
  MockClientStatusResponse,
  GiftCardCodeType,
} from './types/mock-giftcard.client.type';

/**
 * QantasGiftCardClient talks to the Qantas Points POS gateway to BURN a member's
 * reserved points, replacing the mock gift-card client. It implements the same
 * method surface the gift-card service expects (healthcheck/balance/redeem/
 * rollback) and returns the same response shapes, so the service + converters
 * are reused unchanged.
 *
 * Qantas has no "gift-card code": a member signs in and reserves a points quote
 * in the browser (the enabler's Qantas widget). That reservation is carried into
 * this connector as the gift-card "code", encoded as:
 *
 *     QF:<memberNumber>:<quoteRef>:<centAmount>:<currency>
 *
 * `balance()` reports the reserved value from the code (the browser can't be
 * trusted, so this is provisional). `redeem()` performs the AUTHORITATIVE burn on
 * the POS gateway and re-checks the dollar value Qantas ACTUALLY deducted against
 * the amount commercetools is charging — a tampered code can inflate the reported
 * balance but can NEVER make an under-covered burn look successful (fail-closed).
 *
 * SECURITY: the POS-gateway Basic token + the Loyalty-Partner-Forward header are
 * read only here (server-side, from the connector's SECURED configuration) and
 * never leave the processor.
 */

const POS_GATEWAY_HOST: Record<'stg' | 'live', string> = {
  stg: 'https://api.services-stg.qantasloyalty.com',
  live: 'https://api.services.qantasloyalty.com',
};

// Qantas Frequent Flyer numbers are numeric; quoteRef is a GUID. Both are
// validated before the member number is interpolated into the upstream path
// (anti-injection) and the quote is forwarded.
const MEMBER_PATTERN = /^\d{5,15}$/;
const QUOTE_PATTERN = /^[0-9a-fA-F-]{10,64}$/;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;

const QANTAS_CODE_PREFIX = 'QF';

interface ParsedQantasCode {
  memberNumber: string;
  quoteRef: string;
  centAmount: number;
  currencyCode: string;
}

const parseQantasCode = (code: string): ParsedQantasCode | null => {
  const parts = (code ?? '').trim().split(':');
  if (parts.length !== 5 || parts[0] !== QANTAS_CODE_PREFIX) {
    return null;
  }
  const [, memberNumber, quoteRef, centAmountRaw, currencyCode] = parts;
  const centAmount = Number(centAmountRaw);
  if (
    !MEMBER_PATTERN.test(memberNumber) ||
    !QUOTE_PATTERN.test(quoteRef) ||
    !Number.isInteger(centAmount) ||
    centAmount <= 0 ||
    !CURRENCY_PATTERN.test(currencyCode)
  ) {
    return null;
  }
  return { memberNumber, quoteRef, centAmount, currencyCode };
};

export class QantasGiftCardClient {
  private currency: string;
  private host: string;
  private token: string;
  private forwardHeader: string;
  private terminalId: string;
  private env: 'stg' | 'live';
  private allowLiveBurn: boolean;
  private deferredBurn: boolean;

  public constructor(opts: { currency: string }) {
    const cfg = getConfig();
    this.currency = opts.currency;
    this.host = POS_GATEWAY_HOST[cfg.qantasEnv];
    this.token = cfg.qantasPosGatewayToken;
    this.forwardHeader = cfg.qantasForwardHeader;
    this.terminalId = cfg.qantasTerminalId;
    this.env = cfg.qantasEnv;
    this.allowLiveBurn = cfg.qantasAllowLiveBurn;
    this.deferredBurn = cfg.qantasDeferredBurn;
  }

  /**
   * SAFETY INTERLOCK (FOR0001-416): true unless a REAL customer-points burn is
   * currently permitted. A burn is irreversible with no wired refund, so a live
   * burn is allowed ONLY when BOTH switches are on: QANTAS_ALLOW_LIVE_BURN (the
   * deliberate go-live decision) AND QANTAS_DEFERRED_BURN (the safe "burn only
   * after the card clears" ordering). This coupling means flipping the go-live
   * switch alone can never re-enable the unsafe burn-before-card path. Staging is
   * always allowed (test points, no real value at risk).
   */
  private liveBurnBlocked(): boolean {
    return this.env === 'live' && !(this.allowLiveBurn && this.deferredBurn);
  }

  public async healthcheck(): Promise<MockClientStatusResponse> {
    // The gateway has no unauthenticated ping; "configured" is the health signal
    // (a real burn is exercised only at redeem time, fail-closed).
    if (!this.token || !this.forwardHeader) {
      throw new Error('Qantas Points gateway is not configured.');
    }
    return { status: 'OK' };
  }

  public async balance(code: string): Promise<MockClientBalanceResponse> {
    // Defense in depth: on live, before the safe flow exists, don't even let a
    // member reserve real points — the widget treats this as unusable and asks
    // for another payment method, so no real reservation/burn is ever attempted.
    if (this.liveBurnBlocked()) {
      return {
        message: 'Qantas Points are not available yet.',
        code: GiftCardCodeType.NOT_FOUND,
      };
    }
    const parsed = parseQantasCode(code);
    if (!parsed) {
      return {
        message: 'The Qantas Points reference is invalid.',
        code: GiftCardCodeType.NOT_FOUND,
      };
    }
    if (parsed.currencyCode !== this.currency) {
      return {
        message: 'cart and Qantas Points currency do not match',
        code: GiftCardCodeType.CURRENCY_NOT_MATCH,
      };
    }
    // Provisional value from the reserved quote; the burn at redeem is
    // authoritative and re-checked server-side.
    return {
      message: 'Qantas Points reserved.',
      code: GiftCardCodeType.VALID,
      amount: { centAmount: parsed.centAmount, currencyCode: parsed.currencyCode },
    };
  }

  public async redeem(request: MockClientRedeemRequest): Promise<MockClientRedeemResponse> {
    const failure: MockClientRedeemResponse = {
      resultCode: 'FAILURE',
      code: request.code,
      amount: request.amount,
    };

    // SAFETY INTERLOCK (FOR0001-416): refuse to burn REAL customer points until
    // the deferred "burn only after the card clears" flow exists. Placed first,
    // before the gateway call, so no irreversible burn can ever run on live while
    // this is unresolved. Fail-closed → commercetools falls back to charging the
    // card, so the customer keeps their points and is never left stranded.
    if (this.liveBurnBlocked()) {
      log.error(
        '[qantas] redeem refused: live burn is disabled (safety interlock) — a live burn needs BOTH QANTAS_DEFERRED_BURN and QANTAS_ALLOW_LIVE_BURN set',
      );
      return failure;
    }

    if (!this.token || !this.forwardHeader) {
      // Fail-closed: never attempt a burn we can't authenticate.
      log.error('[qantas] redeem failed: POS gateway not configured (token/forward header missing)');
      return failure;
    }
    const parsed = parseQantasCode(request.code);
    if (!parsed) {
      log.error('[qantas] redeem failed: invalid reservation code format');
      return failure;
    }

    // terminalId + clientRef must be sent together (Qantas rule); the unique
    // clientRef is minted per completion for reconciliation.
    const url = `${this.host}/pos/api/member/v2/members/${parsed.memberNumber}/transactions`;

    let payload: Record<string, unknown> | null = null;
    try {
      const upstream = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Basic ${this.token}`,
          'Content-Type': 'application/json',
          'Cache-Control': 'no-cache',
          'Loyalty-Partner-Forward': this.forwardHeader,
        },
        body: JSON.stringify({
          quoteRef: parsed.quoteRef,
          timestamp: new Date().toISOString(),
          terminalId: this.terminalId,
          clientRef: randomUUID(),
        }),
      });
      payload = (await upstream.json().catch(() => null)) as Record<string, unknown> | null;
      if (!upstream.ok) {
        log.error('[qantas] redeem failed: POS gateway rejected the burn', {
          status: upstream.status,
          // Body only on staging (may echo member/quote detail) to pinpoint the cause.
          ...(this.env !== 'live' ? { body: JSON.stringify(payload)?.slice(0, 300) } : {}),
        });
        return failure;
      }
    } catch (err) {
      log.error('[qantas] redeem failed: POS gateway network error', {
        ...(this.env !== 'live' ? { error: String(err).slice(0, 200) } : {}),
      });
      return failure;
    }

    const transactionNumber = payload?.transactionNumber as string | undefined;
    if (!transactionNumber) {
      // A 2xx with no transaction number can't be reconciled — do not confirm.
      log.error('[qantas] redeem failed: gateway returned 2xx with no transactionNumber');
      return failure;
    }

    // Server-authoritative coverage check: the dollar value Qantas ACTUALLY
    // deducted must cover what commercetools is charging to this gift card.
    // The client-declared code balance is never trusted here (fail-closed).
    // Math.floor (not round) so a sub-cent shortfall can never pass the gate.
    const rawCovered = payload?.pointsValueInDollars;
    const coveredCents =
      typeof rawCovered === 'number' && Number.isFinite(rawCovered) ? Math.floor(rawCovered * 100) : null;
    if (coveredCents === null || coveredCents < request.amount.centAmount) {
      log.error('[qantas] redeem failed: burned value does not cover the charge', {
        coveredCents,
        requiredCents: request.amount.centAmount,
      });
      return failure;
    }

    // PHASE-2 MONEY GAPS (must resolve before real member burns are enabled):
    //  1. OVER-BURN: a Qantas quote is a FIXED whole-quote burn, but commercetools
    //     decides `request.amount` independently. If the reserved quote value
    //     exceeds `request.amount`, the full quote burns while only `request.amount`
    //     is credited — the difference in points is lost. The enabler (Phase 2)
    //     MUST reserve a quote whose value equals exactly what CT will charge, and
    //     this check should then enforce `coveredCents === request.amount.centAmount`.
    //  2. IRREVERSIBLE BURN BEFORE THE GATE: the burn above already happened, so any
    //     FAILURE returned after it (or an ambiguous 2xx with no transactionNumber)
    //     strands real points with no automated refund (rollback is not wired).
    //     Phase 2 needs authorize-then-capture / void-on-mismatch or a reconciliation
    //     job. This connector is fail-closed on the ORDER outcome, not yet on the
    //     money side effect.

    log.info('[qantas] redeem success', {
      requiredCents: request.amount.centAmount,
      coveredCents,
    });
    return {
      resultCode: 'SUCCESS',
      redemptionReference: transactionNumber,
      code: request.code,
      amount: request.amount,
    };
  }

  public async rollback(redemptionReference: string): Promise<MockClientRollbackResponse> {
    // Qantas Points refund/void is not wired yet (no refund contract integrated),
    // so this fails closed: it never reports a refund that did not happen. Until a
    // Qantas refund/void call is added here, points refunds must be handled
    // manually with Qantas using this transaction reference.
    void redemptionReference;
    return { result: 'FAILED' };
  }
}

export const QantasAPI = (): QantasGiftCardClient => {
  return new QantasGiftCardClient({
    currency: getConfig().mockConnectorCurrency,
  });
};
