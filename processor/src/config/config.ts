export const config = {
  // Required by Payment SDK
  projectKey: process.env.CTP_PROJECT_KEY || 'projectKey',
  clientId: process.env.CTP_CLIENT_ID || 'xxx',
  clientSecret: process.env.CTP_CLIENT_SECRET || 'xxx',
  jwksUrl: process.env.CTP_JWKS_URL || 'https://mc-api.europe-west1.gcp.commercetools.com/.well-known/jwks.json',
  jwtIssuer: process.env.CTP_JWT_ISSUER || 'https://mc-api.europe-west1.gcp.commercetools.com',
  authUrl: process.env.CTP_AUTH_URL || 'https://auth.europe-west1.gcp.commercetools.com',
  apiUrl: process.env.CTP_API_URL || 'https://api.europe-west1.gcp.commercetools.com',
  sessionUrl: process.env.CTP_SESSION_URL || 'https://session.europe-west1.gcp.commercetools.com/',
  checkoutUrl: process.env.CTP_CHECKOUT_URL || 'https://checkout.europe-west1.gcp.commercetools.com',
  healthCheckTimeout: parseInt(process.env.HEALTH_CHECK_TIMEOUT || '5000'),

  mockConnectorCurrency: process.env.MOCK_CONNECTOR_CURRENCY || '',

  // Qantas Points POS gateway (real burn). Env selects staging vs live; the token
  // (Basic auth) + partner-forward header are SECURED config, read only server-side.
  qantasEnv: (process.env.QANTAS_ENV === 'production' ? 'live' : 'stg') as 'stg' | 'live',
  // SAFETY INTERLOCK (FOR0001-416): a Qantas burn is IRREVERSIBLE and has no
  // wired refund/void, and commercetools sequences the card and gift-card
  // payments asynchronously — so the current flow cannot guarantee the burn only
  // happens after the card clears. Real customer points must therefore NOT be
  // burnable until the deferred "take points after the card is authorised" flow
  // is built and verified. This flag defaults to false (fail-closed): on live,
  // the burn is refused unless someone deliberately sets it, which is the
  // conscious "the safe flow now exists" switch. Staging (QANTAS_ENV≠production)
  // is unaffected and keeps working for testing with test points.
  qantasAllowLiveBurn: process.env.QANTAS_ALLOW_LIVE_BURN === 'true',
  // DEFERRED BURN (FOR0001-416): when true, redeem only RESERVES the points and
  // the irreversible burn is moved to capturePayment(), which commercetools
  // invokes only AFTER the card is authorised — i.e. "take points only after the
  // card clears". Default false keeps the current (proven on staging) behaviour,
  // so the demo is unaffected until this is deliberately switched on to test.
  qantasDeferredBurn: process.env.QANTAS_DEFERRED_BURN === 'true',
  qantasPosGatewayToken: process.env.QANTAS_POS_GATEWAY_TOKEN || '',
  qantasForwardHeader: process.env.QANTAS_FORWARD_HEADER || '',
  qantasTerminalId: process.env.QANTAS_TERMINAL_ID || 'fw-web',
  // PUBLIC Qantas widget identifiers (the browser needs them to render the
  // "Use Qantas Points" sign-in button). Not secret — safe to hand to the UI.
  qantasClientId: process.env.QANTAS_CLIENT_ID || '',
  qantasClientName: process.env.QANTAS_CLIENT_NAME || '',

  // Required by logger
  loggerLevel: process.env.LOGGER_LEVEL || 'info',
};

export const getConfig = () => {
  return config;
};
