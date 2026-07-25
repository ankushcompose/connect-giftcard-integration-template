import { describe, test, expect } from '@jest/globals';
import { computeCoverableAmount } from '../src/services/coverable-amount';

const AUD = (centAmount: number) => ({ centAmount, currencyCode: 'AUD' });

describe('computeCoverableAmount — Qantas Points exclude delivery', () => {
  test('no shipping on the cart → coverable equals the full payable', () => {
    expect(computeCoverableAmount({}, AUD(60000))).toEqual(AUD(60000));
  });

  test('single-shipping mode → subtracts shippingInfo.price', () => {
    const cart = { shippingInfo: { price: { centAmount: 5000 } } };
    // $600 payable − $50 delivery = $550 coverable by points.
    expect(computeCoverableAmount(cart, AUD(60000))).toEqual(AUD(55000));
  });

  test('multi-shipping mode → subtracts the sum of every shipment price', () => {
    const cart = {
      shipping: [
        { shippingInfo: { price: { centAmount: 3000 } } },
        { shippingInfo: { price: { centAmount: 2000 } } },
      ],
    };
    expect(computeCoverableAmount(cart, AUD(60000))).toEqual(AUD(55000));
  });

  test('shipping equal to payable → clamps to 0', () => {
    const cart = { shippingInfo: { price: { centAmount: 60000 } } };
    expect(computeCoverableAmount(cart, AUD(60000))).toEqual(AUD(0));
  });

  test('shipping strictly greater than payable → clamps to 0 (never negative)', () => {
    const cart = { shippingInfo: { price: { centAmount: 70000 } } };
    expect(computeCoverableAmount(cart, AUD(60000))).toEqual(AUD(0));
  });

  test('preserves the payable currency', () => {
    const cart = { shippingInfo: { price: { centAmount: 1000 } } };
    expect(computeCoverableAmount(cart, { centAmount: 5000, currencyCode: 'NZD' })).toEqual({
      centAmount: 4000,
      currencyCode: 'NZD',
    });
  });

  test('delivery modelled as a custom line item → subtracts it (real fw-fed cart)', () => {
    // $3,999 product + $29 delivery = $4,028 payable → coverable = $3,999.
    const cart = {
      customLineItems: [
        { slug: 'crown-posture-mattress-0', totalPrice: { centAmount: 399900 } },
        { slug: 'delivery-and-charges', totalPrice: { centAmount: 2900 } },
      ],
    };
    expect(computeCoverableAmount(cart, AUD(402800))).toEqual(AUD(399900));
  });

  test('product custom line items are NOT subtracted — only delivery-and-charges is', () => {
    const cart = {
      customLineItems: [
        { slug: 'mattress-0', totalPrice: { centAmount: 300000 } },
        { slug: 'pillow-1', totalPrice: { centAmount: 9900 } },
        { slug: 'delivery-and-charges', totalPrice: { centAmount: 5900 } },
      ],
    };
    // payable $3,158 − $59 delivery = $3,099 coverable (products only).
    expect(computeCoverableAmount(cart, AUD(315800))).toEqual(AUD(309900));
  });

  test('collapsed "order-total" cart (no delivery line) → coverable equals payable', () => {
    // Degenerate fallback: itemisation failed, delivery cannot be separated.
    const cart = { customLineItems: [{ slug: 'order-total', totalPrice: { centAmount: 402800 } }] };
    expect(computeCoverableAmount(cart, AUD(402800))).toEqual(AUD(402800));
  });

  test('subtracts BOTH native shipping and a delivery custom line item', () => {
    const cart = {
      shippingInfo: { price: { centAmount: 1000 } },
      customLineItems: [{ slug: 'delivery-and-charges', totalPrice: { centAmount: 2000 } }],
    };
    expect(computeCoverableAmount(cart, AUD(60000))).toEqual(AUD(57000));
  });

  test('reads the delivery line total (totalPrice), not its unit money', () => {
    // qty 2: unit money 1000, line total 2000 — the code must subtract 2000, not 1000.
    const cart = {
      customLineItems: [
        { slug: 'delivery-and-charges', money: { centAmount: 1000 }, quantity: 2, totalPrice: { centAmount: 2000 } },
      ],
    };
    expect(computeCoverableAmount(cart, AUD(60000))).toEqual(AUD(58000));
  });

  test('a product whose slug merely starts with the delivery slug is NOT excluded (exact match)', () => {
    // A product named "Delivery and charges" slugifies to "delivery-and-charges-0"
    // (name + "-" + index), which is NOT the exact delivery slug, so it stays coverable.
    const cart = {
      customLineItems: [
        { slug: 'delivery-and-charges-0', totalPrice: { centAmount: 10000 } },
        { slug: 'delivery-and-charges', totalPrice: { centAmount: 2900 } },
      ],
    };
    expect(computeCoverableAmount(cart, AUD(12900))).toEqual(AUD(10000));
  });
});
