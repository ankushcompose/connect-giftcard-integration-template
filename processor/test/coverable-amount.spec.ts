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
});
