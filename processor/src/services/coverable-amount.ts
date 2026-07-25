/** Minimal shape of a commercetools cart's shipping data (single + multi mode). */
type CartShipping = {
  shippingInfo?: { price?: { centAmount?: number } };
  shipping?: Array<{ shippingInfo?: { price?: { centAmount?: number } } }>;
};

type Money = { centAmount: number; currencyCode: string };

/**
 * The amount Qantas Points may cover, EXCLUDING delivery. The shipping fee is
 * always paid by another method (card), so points can cover at most the payable
 * amount minus every shipping cost on the cart. Handles both single-shipping
 * (`shippingInfo`) and multi-shipping (`shipping[]`) modes, and never returns a
 * negative amount (a cart whose shipping exceeds the payable → 0 coverable).
 */
export const computeCoverableAmount = (cart: CartShipping, amountPlanned: Money): Money => {
  const shippingCents =
    (cart.shippingInfo?.price?.centAmount ?? 0) +
    (cart.shipping?.reduce((sum, s) => sum + (s.shippingInfo?.price?.centAmount ?? 0), 0) ?? 0);

  return {
    centAmount: Math.max(0, amountPlanned.centAmount - shippingCents),
    currencyCode: amountPlanned.currencyCode,
  };
};
