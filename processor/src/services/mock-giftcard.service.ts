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
  }> {
    const cfg = getConfig();
    const ctCart = await this.ctCartService.getCart({ id: getCartIdFromContext() });
    const amountPlanned = await this.ctCartService.getPaymentAmount({ cart: ctCart });
    return {
      clientId: cfg.qantasClientId,
      clientName: cfg.qantasClientName,
      env: cfg.qantasEnv,
      amount: { centAmount: amountPlanned.centAmount, currencyCode: amountPlanned.currencyCode },
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

    const ctPayment = await this.ctPaymentService.createPayment({
      amountPlanned: redeemAmount,
      paymentMethodInfo: {
        paymentInterface: getPaymentInterfaceFromContext() || 'mock-giftcard-provider',
        method: 'giftcard',
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

    const response: MockClientRedeemResponse = await QantasAPI().redeem(request);

    const updatedPayment = await this.ctPaymentService.updatePayment({
      id: ctPayment.id,
      pspReference: response.redemptionReference,
      transaction: {
        type: 'Charge',
        amount: ctPayment.amountPlanned,
        interactionId: response.redemptionReference,
        state: this.redemptionConverter.convertMockClientResultCode(response.resultCode),
      },
    });
    return this.redemptionConverter.convert({ redemptionResult: response, createPaymentResult: updatedPayment });
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
