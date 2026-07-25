/**
 * Configuration for the `event` application — the deferred-burn CAPTURE trigger.
 * It listens for commercetools `CheckoutPaymentAuthorized` events and, once the
 * card leg is authorised, tells commercetools to capture the gift-card payment
 * (which runs the real Qantas burn in the processor).
 *
 * The client id/secret here must belong to a commercetools API client with:
 *   manage_subscriptions, manage_checkout_payment_intents, view_orders,
 *   view_payments  (see connect.yaml).
 */
export const config = {
  projectKey: process.env.CTP_PROJECT_KEY || 'projectKey',
  clientId: process.env.CTP_CLIENT_ID || 'xxx',
  clientSecret: process.env.CTP_CLIENT_SECRET || 'xxx',
  authUrl: process.env.CTP_AUTH_URL || 'https://auth.europe-west1.gcp.commercetools.com',
  apiUrl: process.env.CTP_API_URL || 'https://api.europe-west1.gcp.commercetools.com',
  checkoutUrl: process.env.CTP_CHECKOUT_URL || 'https://checkout.europe-west1.gcp.commercetools.com',
  loggerLevel: process.env.LOGGER_LEVEL || 'info',

  // Mirrors the processor flag: only act on events when the deferred-burn flow is
  // on. Off → the event app acknowledges and does nothing (in immediate mode the
  // gift card is already charged, so there is never anything to capture anyway).
  deferredBurn: process.env.QANTAS_DEFERRED_BURN === 'true',

  // Connect-injected destination coordinates for the managed queue (set by the
  // platform for event applications). Read in the post-deploy Subscription setup.
  // GCP Pub/Sub only — see buildDestination in connectors/post-deploy.ts.
  subscriptionDestination: process.env.CONNECT_SUBSCRIPTION_DESTINATION || '',
  gcpTopicName: process.env.CONNECT_GCP_TOPIC_NAME || '',
  gcpProjectId: process.env.CONNECT_GCP_PROJECT_ID || '',
};

export const SUBSCRIPTION_KEY = 'qantas-giftcard-capture-on-payment-authorized';
