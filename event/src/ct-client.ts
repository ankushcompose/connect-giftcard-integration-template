import { config } from './config';
import { PaymentLike } from './capture-decision';
import { fetchAccessToken } from './ct-token';

/**
 * Minimal server-to-server commercetools client for the event app: a cached
 * client-credentials token, an order-payments read, and the Checkout Payment
 * Intents capture call. Kept as plain fetch (no session SDK) because the event
 * runs outside any customer session.
 */

let cachedToken: { value: string; expiresAt: number } | null = null;

const getAccessToken = async (): Promise<string> => {
  const now = Date.now();
  if (cachedToken && cachedToken.expiresAt > now + 60_000) {
    return cachedToken.value;
  }
  const { accessToken, expiresInMs } = await fetchAccessToken();
  cachedToken = { value: accessToken, expiresAt: now + expiresInMs };
  return accessToken;
};

/** Load the order's payments (expanded) so the caller can inspect each leg. */
export const getOrderPayments = async (orderId: string): Promise<PaymentLike[]> => {
  const token = await getAccessToken();
  const url = `${config.apiUrl}/${config.projectKey}/orders/${encodeURIComponent(orderId)}?expand=paymentInfo.payments[*]`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) {
    throw new Error(`get order failed: HTTP ${res.status}`);
  }
  const order = (await res.json()) as {
    paymentInfo?: { payments?: Array<{ obj?: PaymentLike }> };
  };
  return (order.paymentInfo?.payments ?? []).map((ref) => ref.obj).filter((p): p is PaymentLike => Boolean(p));
};

/**
 * Result of a capture request:
 *  - 'approved' : the connector captured (the Qantas burn succeeded)
 *  - 'rejected' : a PERMANENT business decline (burn failed, interlock refusal,
 *                 missing reservation, or a 4xx like a scope/validation error) —
 *                 do NOT retry; surface it for investigation
 *  - 'retry'    : a TRANSIENT transport/5xx error — safe to redeliver
 */
export type CaptureOutcome = 'approved' | 'rejected' | 'retry';

/**
 * Trigger the gift-card capture via the Checkout Payment Intents API. commercetools
 * forwards this to the connector's `capturePayment` operation, which performs the
 * real Qantas burn. The Payment Intents route returns HTTP 200 with a business
 * `{ outcome }` even when the capture is REJECTED, so we branch on that body — not
 * on the HTTP status — to avoid mistaking a declined burn for success.
 */
export const capturePayment = async (
  paymentId: string,
  amount: { centAmount: number; currencyCode: string },
  merchantReference?: string,
): Promise<CaptureOutcome> => {
  const token = await getAccessToken();
  const url = `${config.checkoutUrl}/${config.projectKey}/payment-intents/${encodeURIComponent(paymentId)}`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        actions: [{ action: 'capturePayment', amount, ...(merchantReference ? { merchantReference } : {}) }],
      }),
    });
  } catch {
    return 'retry'; // network error → transient
  }
  if (res.status >= 500) {
    return 'retry'; // commercetools/transport 5xx → transient
  }
  if (!res.ok) {
    return 'rejected'; // permanent 4xx (scope/validation) → don't redeliver forever
  }
  const body = (await res.json().catch(() => null)) as { outcome?: string } | null;
  return body?.outcome === 'approved' ? 'approved' : 'rejected';
};
