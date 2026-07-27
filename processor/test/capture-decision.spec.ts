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

describe('retry order carrying a released hold beside a live one', () => {
  // Reproduces staging order CT-274026110700 (2026-07-27): the declined attempt's
  // hold was cancelled and the retry created a new one. Taking the first gift-card
  // payment found the CANCELLED one, refused to burn it, and left the live hold
  // uncaptured, so no points were ever collected.
  const released = {
    id: 'gift-released',
    paymentMethodInfo: { method: 'qantasburn' },
    amountPlanned: { centAmount: 42000, currencyCode: 'AUD' },
    transactions: [
      { type: 'Authorization', state: 'Success', interactionId: 'QF:1927346096:aaa:42000:AUD' },
      { type: 'CancelAuthorization', state: 'Success' },
    ],
  };
  const live = {
    id: 'gift-live',
    paymentMethodInfo: { method: 'qantasburn' },
    amountPlanned: { centAmount: 42000, currencyCode: 'AUD' },
    transactions: [{ type: 'Authorization', state: 'Success', interactionId: 'QF:1927346096:bbb:42000:AUD' }],
  };
  const card = {
    id: 'card-1',
    paymentMethodInfo: { method: 'creditcard' },
    amountPlanned: { centAmount: 2900, currencyCode: 'AUD' },
    transactions: [{ type: 'Authorization', state: 'Success' }],
  };

  test('captures the LIVE hold even when the released one comes first', () => {
    const d = decideCapture([released, live, card] as never);
    expect(d.giftCardPaymentId).toBe('gift-live');
    expect(d.shouldCapture).toBe(true);
  });

  test('order of the payments does not change the outcome', () => {
    const d = decideCapture([card, live, released] as never);
    expect(d.giftCardPaymentId).toBe('gift-live');
    expect(d.shouldCapture).toBe(true);
  });

  test('still refuses when every hold has been released', () => {
    const d = decideCapture([released, card] as never);
    expect(d.released).toBe(true);
    expect(d.shouldCapture).toBe(false);
  });

  test('refuses when no hold is capturable (one released, one already burned)', () => {
    const burned = { ...live, transactions: [...live.transactions, { type: 'Charge', state: 'Success' }] };
    const d = decideCapture([released, burned, card] as never);
    // Nothing is capturable, so it falls back to naming the first gift-card payment
    // purely so the "no capture triggered" log is not blank. The decision is what matters.
    expect(d.shouldCapture).toBe(false);
  });

  test('captures a live hold sitting after one that was already burned', () => {
    const burned = {
      ...live,
      id: 'gift-burned',
      transactions: [...live.transactions, { type: 'Charge', state: 'Success' }],
    };
    const d = decideCapture([burned, { ...live, id: 'gift-second' }, card] as never);
    expect(d.giftCardPaymentId).toBe('gift-second');
    expect(d.shouldCapture).toBe(true);
  });
});
