import { describe, test, expect } from '@jest/globals';
import { Payment } from '@commercetools/connect-payments-sdk';
import {
  reservationReleased,
  extractReservationCode,
  alreadyCaptured,
  planReversal,
  findHeldRedemption,
} from '../src/services/deferred-burn';

const CODE = 'QF:1900009653:ec3efcc4-b6d1-4953-b921-6fce2c3b461d:2000:AUD';

// Minimal Payment-shaped fixtures — only the fields the helpers read.
const payment = (transactions: unknown[]): Payment => ({ transactions }) as unknown as Payment;

describe('extractReservationCode', () => {
  test('returns the code stashed on the reserve-time Authorization', () => {
    const p = payment([{ type: 'Authorization', state: 'Success', interactionId: CODE }]);
    expect(extractReservationCode(p)).toBe(CODE);
  });

  test('returns null when there is no Authorization carrying a code', () => {
    const p = payment([{ type: 'Charge', state: 'Success', interactionId: '300000204909' }]);
    expect(extractReservationCode(p)).toBeNull();
  });

  test('returns null when the Authorization has no interactionId', () => {
    const p = payment([{ type: 'Authorization', state: 'Success' }]);
    expect(extractReservationCode(p)).toBeNull();
  });

  test('returns null for a payment with no transactions', () => {
    expect(extractReservationCode(payment([]))).toBeNull();
    expect(extractReservationCode({} as Payment)).toBeNull();
  });
});

describe('alreadyCaptured', () => {
  test('true only when a successful Charge exists (idempotency guard)', () => {
    expect(alreadyCaptured(payment([{ type: 'Charge', state: 'Success' }]))).toBe(true);
  });

  test('false for a reserved-but-not-captured payment', () => {
    expect(alreadyCaptured(payment([{ type: 'Authorization', state: 'Success', interactionId: CODE }]))).toBe(false);
  });

  test('false when a Charge exists but failed', () => {
    expect(alreadyCaptured(payment([{ type: 'Charge', state: 'Failure' }]))).toBe(false);
  });
});

describe('planReversal', () => {
  test('releases the hold when points were reserved but never burned', () => {
    const p = payment([{ type: 'Authorization', state: 'Success', interactionId: CODE }]);
    expect(planReversal(p)).toBe('release-reservation');
  });

  test('refunds (fail-closed) once a successful Charge proves the burn ran', () => {
    const p = payment([
      { type: 'Authorization', state: 'Success', interactionId: CODE },
      { type: 'Charge', state: 'Success', interactionId: '300000204909' },
    ]);
    expect(planReversal(p)).toBe('refund-burned-points');
  });

  test('a FAILED Charge is not a burn — the hold is still only released', () => {
    const p = payment([
      { type: 'Authorization', state: 'Success', interactionId: CODE },
      { type: 'Charge', state: 'Failure' },
    ]);
    expect(planReversal(p)).toBe('release-reservation');
  });

  test('a payment with no transactions releases rather than claiming a failed refund', () => {
    expect(planReversal(payment([]))).toBe('release-reservation');
  });
});

describe('findHeldRedemption', () => {
  const giftCard = (transactions: unknown[], centAmount = 42000): Payment =>
    ({
      id: 'pay-gift-1',
      paymentMethodInfo: { method: 'qantasburn' },
      amountPlanned: { centAmount, currencyCode: 'AUD' },
      transactions,
    }) as unknown as Payment;

  test('recovers a held reservation so the widget can show it as applied', () => {
    const held = findHeldRedemption([giftCard([{ type: 'Authorization', state: 'Success', interactionId: CODE }])]);
    expect(held).toEqual({ paymentId: 'pay-gift-1', code: CODE, centAmount: 42000, currencyCode: 'AUD' });
  });

  test('ignores a redemption whose burn already ran (not re-applyable)', () => {
    const p = giftCard([
      { type: 'Authorization', state: 'Success', interactionId: CODE },
      { type: 'Charge', state: 'Success' },
    ]);
    expect(findHeldRedemption([p])).toBeNull();
  });

  test('ignores an immediate-burn Authorization carrying a Qantas transaction number', () => {
    const p = giftCard([{ type: 'Authorization', state: 'Success', interactionId: '300000204909' }]);
    expect(findHeldRedemption([p])).toBeNull();
  });

  test('ignores a failed Authorization', () => {
    const p = giftCard([{ type: 'Authorization', state: 'Failure', interactionId: CODE }]);
    expect(findHeldRedemption([p])).toBeNull();
  });

  test('ignores non-gift-card payments (e.g. the declined card)', () => {
    const card = {
      paymentMethodInfo: { method: 'scheme' },
      amountPlanned: { centAmount: 2900, currencyCode: 'AUD' },
      transactions: [{ type: 'Authorization', state: 'Failure' }],
    } as unknown as Payment;
    expect(findHeldRedemption([card])).toBeNull();
  });

  test('picks the held redemption out of a mixed cart', () => {
    const card = {
      paymentMethodInfo: { method: 'scheme' },
      amountPlanned: { centAmount: 2900, currencyCode: 'AUD' },
      transactions: [{ type: 'Authorization', state: 'Failure' }],
    } as unknown as Payment;
    const held = findHeldRedemption([
      card,
      giftCard([{ type: 'Authorization', state: 'Success', interactionId: CODE }]),
    ]);
    expect(held?.code).toBe(CODE);
  });

  test('returns null for an empty cart', () => {
    expect(findHeldRedemption([])).toBeNull();
  });
});

describe('reservationReleased — the double-charge guard', () => {
  const gc = (transactions: unknown[]): Payment =>
    ({
      id: 'p1',
      paymentMethodInfo: { method: 'qantasburn' },
      amountPlanned: { centAmount: 42000, currencyCode: 'AUD' },
      transactions,
    }) as unknown as Payment;

  test('true once the hold has been cancelled', () => {
    expect(reservationReleased(gc([{ type: 'CancelAuthorization', state: 'Success' }]))).toBe(true);
  });

  test('false for a hold that is still live', () => {
    expect(reservationReleased(gc([{ type: 'Authorization', state: 'Success', interactionId: CODE }]))).toBe(false);
  });

  test('false when the cancel itself failed', () => {
    expect(reservationReleased(gc([{ type: 'CancelAuthorization', state: 'Failure' }]))).toBe(false);
  });

  // Live 2026-07-27: hold cancelled at 16:23, burned at 16:23 anyway, card took the
  // full $449 — the customer paid twice. A released hold must never be re-offered.
  test('a released hold is NOT restorable as applied', () => {
    const released = gc([
      { type: 'Authorization', state: 'Success', interactionId: CODE },
      { type: 'CancelAuthorization', state: 'Success' },
    ]);
    expect(findHeldRedemption([released])).toBeNull();
  });
});
