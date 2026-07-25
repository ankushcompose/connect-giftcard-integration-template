import { config, SUBSCRIPTION_KEY } from '../config';
import { fetchAccessToken } from '../ct-token';

/**
 * Post-deploy: create (idempotently) the commercetools Subscription that delivers
 * `CheckoutPaymentAuthorized` events to this event app's Connect-managed queue.
 * The destination coordinates are injected by the platform (CONNECT_* env vars).
 */

// This connector deploys to GCP commercetools regions, so the Connect-managed
// queue is Google Cloud Pub/Sub and the event decoder only understands the Pub/Sub
// push envelope. We therefore support only that destination. (An AWS/SNS region
// would additionally need an SNS envelope decoder in capture-decision.ts before
// enabling an SNS destination here, otherwise events would silently fail to decode.)
const buildDestination = (): Record<string, unknown> | null => {
  if (config.subscriptionDestination === 'GoogleCloudPubSub') {
    return { type: 'GoogleCloudPubSub', topic: config.gcpTopicName, projectId: config.gcpProjectId };
  }
  return null;
};

const deleteExisting = async (accessToken: string): Promise<void> => {
  const lookup = await fetch(`${config.apiUrl}/${config.projectKey}/subscriptions/key=${SUBSCRIPTION_KEY}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (lookup.status === 404) {
    return;
  }
  if (!lookup.ok) {
    throw new Error(`subscription lookup failed: HTTP ${lookup.status}`);
  }
  const existing = (await lookup.json()) as { version: number };
  const del = await fetch(
    `${config.apiUrl}/${config.projectKey}/subscriptions/key=${SUBSCRIPTION_KEY}?version=${existing.version}`,
    { method: 'DELETE', headers: { Authorization: `Bearer ${accessToken}` } },
  );
  if (!del.ok) {
    throw new Error(`subscription delete failed: HTTP ${del.status}`);
  }
};

const postDeploy = async (): Promise<void> => {
  const destination = buildDestination();
  if (!destination) {
    process.stdout.write(
      `[qantas-event] no supported subscription destination ("${config.subscriptionDestination}") — skipping\n`,
    );
    return;
  }
  const { accessToken } = await fetchAccessToken();
  await deleteExisting(accessToken); // makes redeploys idempotent
  const res = await fetch(`${config.apiUrl}/${config.projectKey}/subscriptions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      key: SUBSCRIPTION_KEY,
      destination,
      events: [{ resourceTypeId: 'checkout', types: ['CheckoutPaymentAuthorized'] }],
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`subscription create failed: HTTP ${res.status} ${text.slice(0, 200)}`);
  }
  process.stdout.write(`[qantas-event] subscription "${SUBSCRIPTION_KEY}" created for CheckoutPaymentAuthorized\n`);
};

const run = async (): Promise<void> => {
  try {
    await postDeploy();
  } catch (error) {
    if (error instanceof Error) {
      process.stderr.write(`Post-deploy failed: ${error.message}\n`);
    }
    process.exitCode = 1;
  }
};

run();
