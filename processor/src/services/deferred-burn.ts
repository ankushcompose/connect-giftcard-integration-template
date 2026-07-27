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
