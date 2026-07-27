import { Payment } from '@commercetools/connect-payments-sdk';

/**
 * Helpers for the DEFERRED BURN flow (FOR0001-416), kept pure so they are unit
 * testable without the commercetools payment service.
 *
 * The gift-card reservation (the `QF:<member>:<quote>:<cents>:<currency>` code)
 * is stashed as the `interactionId` of the reserve-time Authorization so that
 * capturePayment() can recover it and perform the real burn AFTER the card is
 * authorised.
 *
 * POC CONCESSION: this places the Qantas member number in the commercetools
 * Payment record. That record is access-controlled (needs manage_payments) but
 * NOT encrypted. Before real member burns, hold the reservation in an encrypted
 * custom field or a server-side store keyed by an opaque id instead.
 */

export const RESERVATION_TX_TYPE = 'Authorization';

/**
 * Recover the reservation code stashed on the payment at reserve time. Returns
 * null when no Authorization carries a code (fail-closed at the call site).
 */
export const extractReservationCode = (payment: Payment): string | null => {
  const auth = (payment.transactions ?? []).find(
    (t) => t.type === RESERVATION_TX_TYPE && typeof t.interactionId === 'string' && t.interactionId.length > 0,
  );
  return auth?.interactionId ?? null;
};

/**
 * True when the points have already been burned (a successful Charge exists), so
 * an at-least-once capture delivery does not burn a second time (idempotency).
 */
export const alreadyCaptured = (payment: Payment): boolean =>
  (payment.transactions ?? []).some((t) => t.type === 'Charge' && t.state === 'Success');

/**
 * How an automated reversal must be answered for a gift-card payment.
 *
 * commercetools triggers a reversal on every OTHER payment when one leg fails —
 * so a declined card asks this connector to give the points back. Under deferred
 * burn the answer depends on whether the burn actually ran:
 *
 *  - `release-reservation` — points were only HELD (no successful Charge). Nothing
 *    left the member's account, so the hold is simply released. Recording a failed
 *    Refund here (the pre-deferred-burn behaviour, from when applying points always
 *    spent them immediately) would claim we owe the member points on EVERY declined
 *    split payment, burying the genuine failures that need manual reconciliation.
 *  - `refund-burned-points` — a real burn completed. Qantas offers no refund/void
 *    contract, so this still fails closed and is flagged for manual reconciliation.
 *
 * Works unchanged in immediate-burn mode: redeem() writes a successful Charge there,
 * so every reversal correctly takes the `refund-burned-points` path.
 */
export type ReversalPlan = 'release-reservation' | 'refund-burned-points';

export const planReversal = (payment: Payment): ReversalPlan =>
  alreadyCaptured(payment) ? 'refund-burned-points' : 'release-reservation';

/** Payment method this connector writes on its gift-card payments. */
export const GIFT_CARD_METHOD = 'qantasburn';

/** A redemption already held on the cart, recovered so the browser can show it. */
export interface HeldRedemption {
  /** commercetools Payment holding the reservation (used for idempotent redeem). */
  paymentId: string;
  code: string;
  centAmount: number;
  currencyCode: string;
}

/**
 * Find a Qantas redemption already applied to this cart.
 *
 * The browser widget keeps "applied" in memory only, so when the payment step is
 * rebuilt (e.g. after a declined card, where the storefront reopens the SAME cart)
 * it restarts blank even though the redemption is still attached. This lets the
 * enabler restore the applied state instead of asking the member to sign in again.
 *
 * Only a DEFERRED (held, not yet burned) reservation qualifies:
 *  - a successful Authorization must exist, and
 *  - its interactionId must be a `QF:` reservation code. In immediate-burn mode the
 *    Authorization carries the Qantas transaction NUMBER instead, and those points
 *    are already spent — re-presenting them as re-applyable would be wrong.
 *  - a successful Charge means the burn already ran, so it is not re-applyable.
 */
export const findHeldRedemption = (payments: Payment[]): HeldRedemption | null => {
  for (const payment of payments) {
    if (payment.paymentMethodInfo?.method !== GIFT_CARD_METHOD) continue;
    if (alreadyCaptured(payment)) continue;
    const authorised = (payment.transactions ?? []).some((t) => t.type === 'Authorization' && t.state === 'Success');
    if (!authorised) continue;
    const code = extractReservationCode(payment);
    if (!code || !code.startsWith('QF:')) continue;
    return {
      paymentId: payment.id,
      code,
      centAmount: payment.amountPlanned.centAmount,
      currencyCode: payment.amountPlanned.currencyCode,
    };
  }
  return null;
};
