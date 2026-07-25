import { config, SUBSCRIPTION_KEY } from '../config';
import { fetchAccessToken } from '../ct-token';

/**
 * Pre-undeploy: remove the Subscription created at deploy time so an undeployed
 * connector leaves no dangling subscription behind.
 */
const preUndeploy = async (): Promise<void> => {
  const { accessToken } = await fetchAccessToken();
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
  process.stdout.write(`[qantas-event] subscription "${SUBSCRIPTION_KEY}" removed\n`);
};

const run = async (): Promise<void> => {
  try {
    await preUndeploy();
  } catch (error) {
    if (error instanceof Error) {
      process.stderr.write(`Pre-undeploy failed: ${error.message}\n`);
    }
    process.exitCode = 1;
  }
};

run();
