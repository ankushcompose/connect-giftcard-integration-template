/**
 * Slug of the storefront's delivery custom line item. The fw-fed checkout models
 * delivery NOT as native commercetools shipping but as a custom line item named
 * "Delivery & other charges" (see fw-fed lib/ct/checkout.ts `buildCustomLineItems`,
 * slug `delivery-and-charges`) on a `taxMode: Disabled` cart. Points must never
 * cover it, so it is excluded here alongside any native shipping. This slug is the
 * integration contract between that storefront and this connector; a production
 * build that instead used a native CT shipping method would need only the
 * `shippingInfo`/`shipping[]` terms below.
 */
const DELIVERY_LINE_SLUG = 'delivery-and-charges';

/** Minimal shape of a commercetools cart's delivery-bearing fields. */
type CartLike = {
  shippingInfo?: { price?: { centAmount?: number } };
  shipping?: Array<{ shippingInfo?: { price?: { centAmount?: number } } }>;
  customLineItems?: Array<{ slug?: string; totalPrice?: { centAmount?: number } }>;
};

type Money = { centAmount: number; currencyCode: string };

/**
 * The amount Qantas Points may cover, EXCLUDING delivery. The delivery fee is
 * always paid by another method (card), so points can cover at most the payable
 * amount minus every delivery cost on the cart — whether modelled as native
 * shipping (`shippingInfo` single mode + `shipping[]` multi mode) or as the
 * storefront's `delivery-and-charges` custom line item. Never returns a negative
 * amount (a cart whose delivery exceeds the payable → 0 coverable).
 */
export const computeCoverableAmount = (cart: CartLike, amountPlanned: Money): Money => {
  const nativeShippingCents =
    (cart.shippingInfo?.price?.centAmount ?? 0) +
    (cart.shipping?.reduce((sum, s) => sum + (s.shippingInfo?.price?.centAmount ?? 0), 0) ?? 0);

  const deliveryLineCents = (cart.customLineItems ?? [])
    .filter((li) => li.slug === DELIVERY_LINE_SLUG)
    .reduce((sum, li) => sum + (li.totalPrice?.centAmount ?? 0), 0);

  return {
    centAmount: Math.max(0, amountPlanned.centAmount - nativeShippingCents - deliveryLineCents),
    currencyCode: amountPlanned.currencyCode,
  };
};
