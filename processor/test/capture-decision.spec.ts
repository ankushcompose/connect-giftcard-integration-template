import { describe, test, expect } from '@jest/globals';
import {
  decodePubSubEvent,
  isPaymentAuthorizedEvent,
  findGiftCardPayment,
  isCardLegAuthorized,
  decideCapture,
  PaymentLike,
} from '../../event/src/capture-decision';

const b64 = (obj: unknown): string => Buffer.from(JSON.stringify(obj)).toString('base64');

const AUTH_EVENT = {
  notificationType: 'Event',
  type: 'CheckoutPaymentAuthorized',
  data: { order: { id: 'order-1' }, payment: { id: 'card-1' } },
};

const giftCard = (
  transactions: unknown[] = [],
  amountPlanned = { centAmount: 399900, currencyCode: 'AUD' },
): PaymentLike => ({
  id: 'gc-1',
  paymentMethodInfo: { method: 'qantasburn' },
  amountPlanned,
  transactions: transactions as PaymentLike['transactions'],
});
const cardAuthorized: PaymentLike = {
  id: 'card-1',
  paymentMethodInfo: { method: 'scheme' },
  transactions: [{ type: 'Authorization', state: 'Success' }],
};
const cardPending: PaymentLike = {
  id: 'card-1',
  paymentMethodInfo: { method: 'scheme' },
  transactions: [{ type: 'Authorization', state: 'Pending' }],
};

describe('decodePubSubEvent', () => {
  test('decodes the base64 Pub/Sub envelope into the notification', () => {
    expect(decodePubSubEvent({ message: { data: b64(AUTH_EVENT) } })?.type).toBe('CheckoutPaymentAuthorized');
  });

  test('returns null for a missing/empty envelope', () => {
    expect(decodePubSubEvent({})).toBeNull();
    expect(decodePubSubEvent({ message: { data: '' } })).toBeNull();
  });

  test('returns null for non-JSON data (acknowledge-and-drop)', () => {
    expect(decodePubSubEvent({ message: { data: Buffer.from('not-json').toString('base64') } })).toBeNull();
  });
});

describe('isPaymentAuthorizedEvent', () => {
  test('true only for a CheckoutPaymentAuthorized Event', () => {
    expect(isPaymentAuthorizedEvent(AUTH_EVENT)).toBe(true);
    expect(isPaymentAuthorizedEvent({ notificationType: 'Event', type: 'CheckoutPaymentRefunded' })).toBe(false);
    expect(isPaymentAuthorizedEvent({ notificationType: 'Message', type: 'CheckoutPaymentAuthorized' })).toBe(false);
    expect(isPaymentAuthorizedEvent(null)).toBe(false);
  });
});

describe('findGiftCardPayment', () => {
  test('finds the qantasburn payment', () => {
    expect(findGiftCardPayment([cardAuthorized, giftCard()])?.id).toBe('gc-1');
  });
  test('null when no gift-card payment present', () => {
    expect(findGiftCardPayment([cardAuthorized])).toBeNull();
  });
});

describe('isCardLegAuthorized', () => {
  test('true when a non-gift-card payment has Authorization:Success', () => {
    expect(isCardLegAuthorized([cardAuthorized, giftCard()], 'gc-1')).toBe(true);
  });
  test('false when the only card auth is still Pending (fail-closed)', () => {
    expect(isCardLegAuthorized([cardPending, giftCard()], 'gc-1')).toBe(false);
  });
  test("false when the only Authorization:Success is the gift card's own", () => {
    const gc = giftCard([{ type: 'Authorization', state: 'Success' }]);
    expect(isCardLegAuthorized([gc], 'gc-1')).toBe(false);
  });
});

describe('decideCapture', () => {
  test('captures once the card is authorised and the gift card is not yet charged', () => {
    const d = decideCapture([cardAuthorized, giftCard([{ type: 'Authorization', state: 'Success' }])]);
    expect(d).toMatchObject({
      giftCardPaymentId: 'gc-1',
      cardAuthorized: true,
      shouldCapture: true,
      captureAmount: { centAmount: 399900, currencyCode: 'AUD' },
    });
  });

  test('does NOT capture when the gift-card payment has no usable amount', () => {
    const gc: PaymentLike = {
      id: 'gc-1',
      paymentMethodInfo: { method: 'qantasburn' },
      transactions: [{ type: 'Authorization', state: 'Success' }],
    };
    const d = decideCapture([cardAuthorized, gc]);
    expect(d.captureAmount).toBeNull();
    expect(d.shouldCapture).toBe(false);
  });

  test('does NOT capture while the card is only pending', () => {
    expect(decideCapture([cardPending, giftCard()]).shouldCapture).toBe(false);
  });

  test('does NOT re-capture when a successful Charge already exists (idempotent)', () => {
    const gc = giftCard([
      { type: 'Authorization', state: 'Success' },
      { type: 'Charge', state: 'Success' },
    ]);
    const d = decideCapture([cardAuthorized, gc]);
    expect(d.alreadyCaptured).toBe(true);
    expect(d.shouldCapture).toBe(false);
  });

  test('does NOT capture when there is no gift-card payment on the order', () => {
    expect(decideCapture([cardAuthorized]).shouldCapture).toBe(false);
  });
});
