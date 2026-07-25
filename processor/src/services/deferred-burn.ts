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
