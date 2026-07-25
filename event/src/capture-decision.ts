/**
 * Pure, dependency-free decision logic for the deferred-burn CAPTURE trigger
 * (FOR0001-416), used by the `event` application. Kept free of the commercetools
 * SDK and any running-app state so it can be unit-tested directly. The tests live
 * in `processor/test/capture-decision.spec.ts` (test-only import of this file —
 * the processor's own build never includes it), reusing that app's working jest
 * setup since the event app is built by the platform, not locally.
 *
 * Flow: commercetools fires a `CheckoutPaymentAuthorized` event when a payment on
 * the order is authorised. The event app decodes it, loads the order's payments,
 * and only triggers the gift-card capture (the real Qantas burn, done in the
 * processor) once the CARD leg is confirmed authorised — i.e. "take points only
 * after the card clears".
 */

// Minimal shapes — only the fields we read (the real objects carry more).
export interface CheckoutEventNotification {
  notificationType?: string;
  type?: string;
  data?: {
    payment?: { id?: string };
    transactionId?: string;
    cart?: { id?: string };
    order?: { id?: string };
    projectKey?: string;
  };
}

export interface TransactionLike {
  type?: string;
  state?: string;
}

export interface PaymentLike {
  id?: string;
  paymentMethodInfo?: { method?: string; paymentInterface?: string };
  amountPlanned?: { centAmount?: number; currencyCode?: string };
  transactions?: TransactionLike[];
}

/** The gift-card payment method our connector records at reserve time. */
export const QANTAS_GIFTCARD_METHOD = 'qantasburn';

export interface CaptureDecision {
  giftCardPaymentId: string | null;
  captureAmount: { centAmount: number; currencyCode: string } | null;
  cardAuthorized: boolean;
  alreadyCaptured: boolean;
  shouldCapture: boolean;
}

/**
 * Decode the Google Pub/Sub push envelope into the commercetools notification.
 * The real notification is base64-encoded in `message.data`. Returns null for a
 * missing/malformed envelope so the caller can acknowledge-and-drop it.
 */
export const decodePubSubEvent = (body: unknown): CheckoutEventNotification | null => {
  const data = (body as { message?: { data?: string } })?.message?.data;
  if (typeof data !== 'string' || data.length === 0) {
    return null;
  }
  try {
    return JSON.parse(Buffer.from(data, 'base64').toString('utf8').trim()) as CheckoutEventNotification;
  } catch {
    return null;
  }
};

/** True only for the Checkout "payment authorised" event we act on. */
export const isPaymentAuthorizedEvent = (n: CheckoutEventNotification | null): boolean =>
  n?.notificationType === 'Event' && n?.type === 'CheckoutPaymentAuthorized';

/** Find our gift-card (Qantas Burn) payment among the order's payments. */
export const findGiftCardPayment = (payments: PaymentLike[]): PaymentLike | null =>
  payments.find((p) => p.paymentMethodInfo?.method === QANTAS_GIFTCARD_METHOD) ?? null;

/**
 * The sibling CARD leg is authorised when SOME non-gift-card payment carries an
 * Authorization:Success transaction. Fail-closed: no such transaction found →
 * false → do not capture (never burn before the card clears).
 */
export const isCardLegAuthorized = (payments: PaymentLike[], giftCardPaymentId: string | null): boolean =>
  payments.some(
    (p) =>
      p.id !== giftCardPaymentId &&
      p.paymentMethodInfo?.method !== QANTAS_GIFTCARD_METHOD &&
      (p.transactions ?? []).some((t) => t.type === 'Authorization' && t.state === 'Success'),
  );

/** True once a successful Charge exists on the gift-card payment (idempotency). */
const isCaptured = (giftCard: PaymentLike | null): boolean =>
  Boolean(giftCard) && (giftCard!.transactions ?? []).some((t) => t.type === 'Charge' && t.state === 'Success');

/**
 * Decide whether to trigger the gift-card capture for this order. Capture only
 * when: a gift-card payment exists, the card leg is authorised, and the gift card
 * has not already been captured (guards against at-least-once event delivery).
 */
export const decideCapture = (payments: PaymentLike[]): CaptureDecision => {
  const giftCard = findGiftCardPayment(payments);
  const giftCardPaymentId = giftCard?.id ?? null;
  const planned = giftCard?.amountPlanned;
  const captureAmount =
    typeof planned?.centAmount === 'number' && planned.currencyCode
      ? { centAmount: planned.centAmount, currencyCode: planned.currencyCode }
      : null;
  const cardAuthorized = isCardLegAuthorized(payments, giftCardPaymentId);
  const alreadyCaptured = isCaptured(giftCard);
  return {
    giftCardPaymentId,
    captureAmount,
    cardAuthorized,
    alreadyCaptured,
    shouldCapture: Boolean(giftCardPaymentId) && Boolean(captureAmount) && cardAuthorized && !alreadyCaptured,
  };
};
