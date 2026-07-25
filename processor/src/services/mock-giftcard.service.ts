import {
  CommercetoolsCartService,
  CommercetoolsPaymentService,
  healthCheckCommercetoolsPermissions,
  statusHandler,
  CommercetoolsOrderService,
  ErrorGeneral,
} from '@commercetools/connect-payments-sdk';
import {
  CancelPaymentRequest,
  CapturePaymentRequest,
  PaymentProviderModificationResponse,
  StatusResponse,
  RefundPaymentRequest,
  ReversePaymentRequest,
} from './types/operation.type';
import { PaymentModificationStatus } from '../dtos/operations/payment-intents.dto';
import { RedeemRequestDTO } from '../dtos/mock-giftcards.dto';
import { getConfig } from '../config/config';
import { appLogger, paymentSDK } from '../payment-sdk';
import { AbstractGiftCardService } from './abstract-giftcard.service';
import { QantasAPI } from '../clients/qantas-giftcard.client';
import {
  MockClientBalanceResponse,
  MockClientRedeemRequest,
  MockClientRedeemResponse,
  GiftCardCodeType,
} from '../clients/types/mock-giftcard.client.type';
import { getCartIdFromContext, getPaymentInterfaceFromContext } from '../libs/fastify/context/context';
import { BalanceResponseSchemaDTO, RedeemResponseDTO } from '../dtos/mock-giftcards.dto';
import { MockCustomError } from '../errors/mock-api.error';
import { BalanceConverter } from './converters/balance-converter';
import { RedemptionConverter } from './converters/redemption-converter';
import { computeCoverableAmount } from './coverable-amount';

import packageJSON from '../../package.json';
import { log } from '../libs/logger';

/**
 * MockGiftCardService acts as a sample service class to integrate with commercetools composable platform and external gift card service provider. Since no actual communication with external gift card service provider in this connector template, further customization is required if SDK APIs are provided by gift card service provider.
 */
export type MockGiftCardServiceOptions = {
  ctCartService: CommercetoolsCartService;
  ctPaymentService: CommercetoolsPaymentService;
  ctOrderService: CommercetoolsOrderService;
};

export class MockGiftCardService extends AbstractGiftCardService {
  private balanceConverter: BalanceConverter;
  private redemptionConverter: RedemptionConverter;

  constructor(opts: MockGiftCardServiceOptions) {
    super(opts.ctCartService, opts.ctPaymentService, opts.ctOrderService);

    this.balanceConverter = new BalanceConverter();
    this.redemptionConverter = new RedemptionConverter();
  }

  /**
   * Get status
   *
   * @remarks
   * Implementation to provide mocking status of external systems
   *
   * @returns Promise with mocking data containing a list of status from different external systems
   */
  async status(): Promise<StatusResponse> {
    const handler = await statusHandler({
      timeout: getConfig().healthCheckTimeout,
      log: appLogger,
      checks: [
        healthCheckCommercetoolsPermissions({
          requiredPermissions: [
            'manage_payments',
            'view_sessions',
            'view_api_clients',
            'manage_orders',
            'introspect_oauth_tokens',
            'manage_checkout_payment_intents',
          ],
          ctAuthorizationService: paymentSDK.ctAuthorizationService,
          projectKey: getConfig().projectKey,
        }),
        async () => {
          try {
            const healthcheckResult = await QantasAPI().healthcheck();
            return {
              name: 'Qantas Points gateway',
              status: 'UP',
              details: {
                healthcheckResult,
              },
            };
          } catch (e) {
            return {
              name: 'Qantas Points gateway',
              status: 'DOWN',
              message: `Not able to communicate with the Qantas Points gateway`,
              details: {
                // TODO do not expose the error
                error: e,
              },
            };
          }
        },
      ],
      metadataFn: async () => ({
        name: packageJSON.name,
        description: packageJSON.description,
      }),
    })();

    return handler.body;
  }

  async balance(code: string): Promise<BalanceResponseSchemaDTO> {
    const ctCart = await this.ctCartService.getCart({
      id: getCartIdFromContext(),
    });
    const amountPlanned = await this.ctCartService.getPaymentAmount({ cart: ctCart });

    if (getConfig().mockConnectorCurrency !== amountPlanned.currencyCode) {
      throw new MockCustomError({
        message: 'cart and gift card currency do not match',
        code: 400,
        key: 'CurrencyNotMatch',
      });
    }

    const getBalanceResult: MockClientBalanceResponse = await QantasAPI().balance(code);

    return this.balanceConverter.convert(getBalanceResult);
  }

  /**
   * PUBLIC widget configuration for the browser "Use Qantas Points" sign-in:
   * the Qantas Client_ID/name + environment (all non-secret) plus the cart's
   * currently-payable amount, so the widget reserves a quote against the right
   * figure. The POS token / forward header are NEVER included (server-only).
   */
  async widgetConfig(): Promise<{
    clientId: string;
    clientName: string;
    env: string;
    amount: { centAmount: number; currencyCode: string };
    totalAmount: { centAmount: number; currencyCode: string };
  }> {
    const cfg = getConfig();
    const ctCart = await this.ctCartService.getCart({ id: getCartIdFromContext() });
    const amountPlanned = await this.ctCartService.getPaymentAmount({ cart: ctCart });
    // Points cover the goods only — delivery is always paid by card. The widget
    // reserves against the ex-delivery figure; the full total lets the checkout
    // UI show the correct "still to pay by card" amount (which includes delivery).
    const coverable = computeCoverableAmount(ctCart, amountPlanned);
    return {
      clientId: cfg.qantasClientId,
      clientName: cfg.qantasClientName,
      env: cfg.qantasEnv,
      amount: { centAmount: coverable.centAmount, currencyCode: coverable.currencyCode },
      totalAmount: { centAmount: amountPlanned.centAmount, currencyCode: amountPlanned.currencyCode },
    };
  }

  async redeem(opts: { data: RedeemRequestDTO }): Promise<RedeemResponseDTO> {
    const redeemCode = opts.data.code;
    const ctCart = await this.ctCartService.getCart({
      id: getCartIdFromContext(),
    });

    const amountPlanned = await this.ctCartService.getPaymentAmount({ cart: ctCart });
    const redeemAmount = opts.data.redeemAmount;

    if (getConfig().mockConnectorCurrency !== amountPlanned.currencyCode) {
      throw new MockCustomError({
        message: 'cart and gift card currency do not match',
        code: 400,
        key: GiftCardCodeType.CURRENCY_NOT_MATCH,
      });
    }

    // COVERAGE RULE (server-enforced, before any burn): Qantas Points cover the
    // goods only — the delivery fee is ALWAYS paid by another method (card). So
    // a redemption may cover up to the payable amount MINUS delivery, and no
    // more (points reaching the full ex-delivery amount is allowed). Placed
    // BEFORE the payment/burn side effects so no points are spent on a rejected
    // redemption (fail-closed).
    // LIMITATION: coverable = payable − delivery only when delivery is separable
    // on the cart. The fw-fed cart collapses to a single "order-total" custom
    // line item (no `delivery-and-charges` line) for an empty cart OR when a
    // cart-level discount drops the total below the itemised sum. In that case
    // delivery cannot be isolated, coverable == payable, and points COULD cover
    // delivery. The durable fix is a native CT shipping method (see
    // coverable-amount.ts) — until then, avoid whole-order discounts with points.
    const coverable = computeCoverableAmount(ctCart, amountPlanned);
    if (redeemAmount.centAmount <= 0 || redeemAmount.centAmount > coverable.centAmount) {
      throw new MockCustomError({
        message: 'Qantas Points cover the item total only; the delivery fee must be paid by another method.',
        code: 400,
        key: GiftCardCodeType.GENERIC_ERROR,
      });
    }

    const ctPayment = await this.ctPaymentService.createPayment({
      amountPlanned: redeemAmount,
      paymentMethodInfo: {
        paymentInterface: getPaymentInterfaceFromContext() || 'mock-giftcard-provider',
        method: 'qantasburn',
        name: { 'en-AU': 'Qantas Burn', en: 'Qantas Burn' },
      },
      ...(ctCart.customerId && {
        customer: {
          typeId: 'customer',
          id: ctCart.customerId,
        },
      }),
      ...(!ctCart.customerId &&
        ctCart.anonymousId && {
          anonymousId: ctCart.anonymousId,
        }),
    });

    await this.ctCartService.addPayment({
      resource: {
        id: ctCart.id,
        version: ctCart.version,
      },
      paymentId: ctPayment.id,
    });

    const request: MockClientRedeemRequest = {
      code: redeemCode,
      amount: redeemAmount,
    };

    // ORDERING OBSERVATION (staging-only, temporary, best-effort, READ-ONLY):
    // right before the burn, record the OTHER payments on the cart + their
    // transaction states, to learn whether the Adyen card is already authorized
    // when commercetools asks us to burn. This decides how to enforce "burn only
    // after the card is authorized" (FOR0001-416). Remove once confirmed.
    if (getConfig().qantasEnv !== 'live') {
      try {
        const freshCart = await this.ctCartService.getCart({ id: getCartIdFromContext() });
        const others = (freshCart.paymentInfo?.payments ?? []).filter((ref) => ref.id !== ctPayment.id);
        const observed = await Promise.all(
          others.map(async (ref) => {
            const other = await this.ctPaymentService.getPayment({ id: ref.id });
            return {
              method: other.paymentMethodInfo?.method,
              paymentInterface: other.paymentMethodInfo?.paymentInterface,
              transactions: (other.transactions ?? []).map((t) => `${t.type}:${t.state}`),
            };
          }),
        );
        log.info('[qantas] cart payments at burn time (ordering observation)', {
          otherPaymentCount: others.length,
          otherPayments: observed,
        });
      } catch (err) {
        log.warn('[qantas] ordering observation failed (non-fatal)', { error: String(err).slice(0, 120) });
      }
    }

    const response: MockClientRedeemResponse = await QantasAPI().redeem(request);

    const txState = this.redemptionConverter.convertMockClientResultCode(response.resultCode);
    // Record the two-phase lifecycle so the payment mirrors the card: an
    // Authorization (points reserved) then a Charge (the CAPTURE — the burn).
    // commercetools has no "Capture" transaction type; Charge IS the capture.
    // The Authorization is cosmetic bookkeeping AFTER the irreversible burn, so it
    // is best-effort: a transient CT error here must never reject a redeem whose
    // points are already spent. The Charge below is the load-bearing write (it
    // carries the pspReference and is what commercetools counts as paid).
    await this.ctPaymentService
      .updatePayment({
        id: ctPayment.id,
        transaction: {
          type: 'Authorization',
          amount: ctPayment.amountPlanned,
          interactionId: response.redemptionReference,
          state: txState,
        },
      })
      .catch((err) => {
        log.warn('[qantas] could not record Authorization transaction (non-fatal)', {
          error: String(err).slice(0, 120),
        });
      });
    const updatedPayment = await this.ctPaymentService.updatePayment({
      id: ctPayment.id,
      pspReference: response.redemptionReference,
      transaction: {
        type: 'Charge',
        amount: ctPayment.amountPlanned,
        interactionId: response.redemptionReference,
        state: txState,
      },
    });

    // Populate the payment's PSP status code + text. The payments SDK does not
    // expose `paymentStatus`, so set it directly — fire-and-forget (this connector
    // is a long-lived container, so a detached promise still completes). Keeping
    // token-refresh + CT-status latency OFF the redeem critical path, and it can
    // never fail the (already-completed) burn/order.
    void this.setPaymentInterfaceStatus(updatedPayment.id, updatedPayment.version, txState === 'Success').catch(
      (err) => {
        log.warn('[qantas] could not set payment status code (non-fatal)', {
          error: String(err).slice(0, 120),
        });
      },
    );

    return this.redemptionConverter.convert({ redemptionResult: response, createPaymentResult: updatedPayment });
  }

  /**
   * Set the payment's PSP status code + human-readable text directly on
   * commercetools — the payments SDK's `updatePayment` does not expose
   * `paymentStatus`. The formal "Payment state" is a separate workflow State
   * reference that requires payment states defined in the project, so it is
   * intentionally left for that project-level setup. Bounded by a short timeout
   * so it can never hang the redeem request.
   */
  private async setPaymentInterfaceStatus(paymentId: string, version: number, succeeded: boolean): Promise<void> {
    const cfg = getConfig();
    const token = await paymentSDK.ctAuthorizationService.getAccessToken();
    const res = await fetch(`${cfg.apiUrl}/${cfg.projectKey}/payments/${paymentId}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token.access_token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        version,
        actions: [
          { action: 'setStatusInterfaceCode', interfaceCode: succeeded ? 'SUCCESS' : 'FAILURE' },
          {
            action: 'setStatusInterfaceText',
            interfaceText: succeeded ? 'Qantas Points burned' : 'Qantas Points burn failed',
          },
        ],
      }),
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) {
      throw new Error(`setStatus HTTP ${res.status}`);
    }
  }

  /**
   * Capture payment
   *
   * @remarks
   * Implementation to provide the mocking data for payment capture in external PSPs
   *
   * @param request - contains the amount and {@link https://docs.commercetools.com/api/projects/payments | Payment } defined in composable commerce
   * @returns Promise with mocking data containing operation status and PSP reference
   */
  async capturePayment(request: CapturePaymentRequest): Promise<PaymentProviderModificationResponse> {
    throw new ErrorGeneral('operation not supported', {
      fields: {
        pspReference: request.payment.interfaceId,
      },
      privateMessage: "connector doesn't support capture operation",
    });
  }

  /**
   * Cancel payment
   *
   * @remarks
   * Implementation to provide the mocking data for payment cancel in external PSPs
   *
   * @param request - contains {@link https://docs.commercetools.com/api/projects/payments | Payment } defined in composable commerce
   * @returns Promise with mocking data containing operation status and PSP reference
   */
  async cancelPayment(request: CancelPaymentRequest): Promise<PaymentProviderModificationResponse> {
    throw new ErrorGeneral('operation not supported', {
      fields: {
        pspReference: request.payment.interfaceId,
      },
      privateMessage: "connector doesn't support cancel operation",
    });
  }

  async refundPayment(request: RefundPaymentRequest): Promise<PaymentProviderModificationResponse> {
    log.info(`Processing payment modification.`, {
      paymentId: request.payment.id,
      action: 'refundPayment',
    });

    const response = await this.handleRefunds({
      amount: request.amount,
      merchantReference: request.merchantReference,
      payment: request.payment,
    });

    log.info(`Payment modification completed.`, {
      paymentId: request.payment.id,
      action: 'refundPayment',
      result: response.outcome,
    });

    return response;
  }

  /**
   * Reverse payment
   *
   * @remarks
   * Abstract method to execute payment reversals in support of automated reversals to be triggered by checkout api. The actual invocation to PSPs should be implemented in subclasses
   *
   * @param request
   * @returns Promise with outcome containing operation status and PSP reference
   */
  async reversePayment(request: ReversePaymentRequest): Promise<PaymentProviderModificationResponse> {
    log.info(`Processing payment modification.`, {
      paymentId: request.payment.id,
      action: 'reversePayment',
    });

    const response = await this.handleRefunds({
      amount: request.payment.amountPlanned,
      merchantReference: request.merchantReference,
      payment: request.payment,
    });

    log.info(`Payment modification completed.`, {
      paymentId: request.payment.id,
      action: 'reversePayment',
      result: response.outcome,
    });

    return response;
  }

  private async handleRefunds(request: RefundPaymentRequest): Promise<PaymentProviderModificationResponse> {
    await this.ctPaymentService.updatePayment({
      id: request.payment.id,
      transaction: {
        type: 'Refund',
        amount: request.amount,
        state: 'Initial',
      },
    });

    const rollbackResult = await QantasAPI().rollback(request.payment.interfaceId || '');

    await this.ctPaymentService.updatePayment({
      id: request.payment.id,
      transaction: {
        type: 'Refund',
        amount: request.amount,
        interactionId: rollbackResult.id,
        // Only 'SUCCESS' is a real refund; any other value (incl. the truthy
        // string 'FAILED') must record a Failure so the ledger never claims a
        // refund that did not move money.
        state: rollbackResult.result === 'SUCCESS' ? 'Success' : 'Failure',
      },
    });

    return {
      outcome:
        rollbackResult.result === 'SUCCESS' ? PaymentModificationStatus.APPROVED : PaymentModificationStatus.REJECTED,
      pspReference: rollbackResult?.id || '',
    };
  }
}
