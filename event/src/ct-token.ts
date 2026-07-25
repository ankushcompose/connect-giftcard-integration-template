import { config } from './config';

export interface AccessToken {
  accessToken: string;
  expiresInMs: number;
}

/** Fetch a commercetools client-credentials token (server-to-server, no session). */
export const fetchAccessToken = async (): Promise<AccessToken> => {
  const basic = Buffer.from(`${config.clientId}:${config.clientSecret}`).toString('base64');
  const res = await fetch(`${config.authUrl}/oauth/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });
  if (!res.ok) {
    throw new Error(`commercetools auth failed: HTTP ${res.status}`);
  }
  const body = (await res.json()) as { access_token: string; expires_in: number };
  return { accessToken: body.access_token, expiresInMs: body.expires_in * 1000 };
};
