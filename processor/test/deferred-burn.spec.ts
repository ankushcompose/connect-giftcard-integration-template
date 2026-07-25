import { describe, test, expect } from '@jest/globals';
import { Payment } from '@commercetools/connect-payments-sdk';
import { extractReservationCode, alreadyCaptured } from '../src/services/deferred-burn';

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
