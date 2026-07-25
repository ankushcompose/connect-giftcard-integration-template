import { decodePubSubEvent, isPaymentAuthorizedEvent, decideCapture } from './capture-decision';
import { getOrderPayments, capturePayment } from './ct-client';
import { config } from './config';
import { log } from './logger';

/**
 * Handle one delivered event. Returns the HTTP status the /event route replies
 * with. commercetools acknowledges on 2xx and redelivers otherwise (at-least-once),
 * so: acknowledge-and-drop (2xx) for anything not actionable, and 5xx only for a
 * transient failure we want retried.
 *
 * Safety: the real, irreversible burn is triggered ONLY when the sibling CARD leg
 * is authorised (decideCapture gates on that) — "take points only after the card
 * clears". The capture is idempotent (decideCapture skips an already-charged gift
 * card, and the processor's capture is itself idempotent).
 */
export const handlePubSubEvent = async (body: unknown): Promise<number> => {
  if (!config.deferredBurn) {
    return 204; // deferred burn off → nothing to do; ack & drop
  }

  const notification = decodePubSubEvent(body);
  if (!isPaymentAuthorizedEvent(notification)) {
    return 204; // malformed, or not a CheckoutPaymentAuthorized event — ack & drop
  }

  const orderId = notification?.data?.order?.id;
  if (!orderId) {
    log.info('[qantas-event] payment-authorized event without an order id — acknowledged');
    return 204;
  }

  const payments = await getOrderPayments(orderId); // throws on transient CT error → 5xx retry
  const decision = decideCapture(payments);
  if (!decision.shouldCapture || !decision.giftCardPaymentId || !decision.captureAmount) {
    log.info('[qantas-event] no capture triggered', {
      orderId,
      giftCardPaymentId: decision.giftCardPaymentId,
      cardAuthorized: decision.cardAuthorized,
      alreadyCaptured: decision.alreadyCaptured,
      hasAmount: Boolean(decision.captureAmount),
    });
    return 204;
  }

  const outcome = await capturePayment(decision.giftCardPaymentId, decision.captureAmount, orderId);

  if (outcome === 'retry') {
    log.error('[qantas-event] capture failed transiently — will retry', {
      orderId,
      paymentId: decision.giftCardPaymentId,
    });
    return 500; // transient → allow redelivery
  }

  if (outcome === 'rejected') {
    // Permanent decline (burn failed / interlock refusal / bad request). Do NOT
    // redeliver forever — acknowledge, but log loudly so it is investigated: the
    // card is charged and the points were NOT taken.
    log.error('[qantas-event] capture was REJECTED — card charged but points NOT taken; investigate', {
      orderId,
      paymentId: decision.giftCardPaymentId,
    });
    return 204;
  }

  log.info('[qantas-event] capture approved — points burned after card authorisation', {
    orderId,
    paymentId: decision.giftCardPaymentId,
  });
  return 200;
};
