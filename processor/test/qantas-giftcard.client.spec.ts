import { describe, test, expect, afterEach, jest } from '@jest/globals';

// config.ts reads process.env at module load, so each case sets env then
// re-requires the client through a fresh module registry.
const OLD_ENV = process.env;

const loadClient = (env: Record<string, string> = {}) => {
  jest.resetModules();
  process.env = { ...OLD_ENV, MOCK_CONNECTOR_CURRENCY: 'AUD', ...env };
  return require('../src/clients/qantas-giftcard.client') as typeof import('../src/clients/qantas-giftcard.client');
};

const CONFIGURED = {
  QANTAS_POS_GATEWAY_TOKEN: 'dummy-token',
  QANTAS_FORWARD_HEADER: 'B563A214-0807-44DF-A027-AAC5F4759F68',
};

const MEMBER = '1900009653';
const QUOTE = 'ec3efcc4-b6d1-4953-b921-6fce2c3b461d';
const VALID_CODE = `QF:${MEMBER}:${QUOTE}:2000:AUD`;
const AMOUNT = { centAmount: 2000, currencyCode: 'AUD' };

const stubFetch = (body: unknown, ok = true, status = 200) => {
  const fn = jest
    .fn<(input: string, init: RequestInit) => Promise<Response>>()
    .mockResolvedValue({
      ok,
      status,
      json: async () => body,
    } as unknown as Response);
  (global as { fetch: unknown }).fetch = fn;
  return fn;
};

afterEach(() => {
  process.env = OLD_ENV;
  jest.restoreAllMocks();
});

describe('QantasGiftCardClient.balance', () => {
  test('returns the reserved value for a valid code', async () => {
    const { QantasAPI } = loadClient(CONFIGURED);
    const res = await QantasAPI().balance(VALID_CODE);
    expect(res.code).toBe('Valid');
    expect(res.amount).toEqual({ centAmount: 2000, currencyCode: 'AUD' });
  });

  test('rejects a malformed reference as NotFound', async () => {
    const { QantasAPI } = loadClient(CONFIGURED);
    const res = await QantasAPI().balance('not-a-qantas-code');
    expect(res.code).toBe('NotFound');
  });

  test('rejects a currency that does not match the cart', async () => {
    const { QantasAPI } = loadClient(CONFIGURED);
    const res = await QantasAPI().balance(`QF:${MEMBER}:${QUOTE}:2000:USD`);
    expect(res.code).toBe('CurrencyNotMatch');
  });
});

describe('QantasGiftCardClient.redeem', () => {
  test('fails closed and never calls the gateway when unconfigured', async () => {
    const { QantasAPI } = loadClient({ QANTAS_POS_GATEWAY_TOKEN: '', QANTAS_FORWARD_HEADER: '' });
    const fetchSpy = stubFetch({});
    const res = await QantasAPI().redeem({ code: VALID_CODE, amount: AMOUNT });
    expect(res.resultCode).toBe('FAILURE');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test('fails closed on a non-2xx gateway response', async () => {
    const { QantasAPI } = loadClient(CONFIGURED);
    stubFetch({ message: 'Quote expired' }, false, 400);
    const res = await QantasAPI().redeem({ code: VALID_CODE, amount: AMOUNT });
    expect(res.resultCode).toBe('FAILURE');
  });

  test('fails closed on a 2xx with no transaction number', async () => {
    const { QantasAPI } = loadClient(CONFIGURED);
    stubFetch({ pointsBurned: 4000 });
    const res = await QantasAPI().redeem({ code: VALID_CODE, amount: AMOUNT });
    expect(res.resultCode).toBe('FAILURE');
  });

  test('fails closed when the burned value does not cover the charge', async () => {
    const { QantasAPI } = loadClient(CONFIGURED);
    // Qantas deducted only $10 but commercetools is charging $20 to the gift card.
    stubFetch({ transactionNumber: '300000204909', pointsValueInDollars: 10 });
    const res = await QantasAPI().redeem({ code: VALID_CODE, amount: AMOUNT });
    expect(res.resultCode).toBe('FAILURE');
  });

  test('succeeds on a covered 2xx burn and sends an authoritative request', async () => {
    const { QantasAPI } = loadClient(CONFIGURED);
    const fetchSpy = stubFetch({
      transactionNumber: '300000204909',
      pointsBurned: 4000,
      pointsValueInDollars: 20,
    });
    const res = await QantasAPI().redeem({ code: VALID_CODE, amount: AMOUNT });

    expect(res.resultCode).toBe('SUCCESS');
    expect(res.redemptionReference).toBe('300000204909');

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toContain(`/members/${MEMBER}/transactions`);
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Basic dummy-token');
    expect(headers['Loyalty-Partner-Forward']).toBe(CONFIGURED.QANTAS_FORWARD_HEADER);
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body.quoteRef).toBe(QUOTE);
    expect(body.terminalId).toBe('fw-web');
    expect(body.clientRef).toBeTruthy();
    expect(body.timestamp).toBeTruthy();
  });
});

describe('QantasGiftCardClient.rollback', () => {
  test('fails closed (Qantas refund not wired) so a false refund is never reported', async () => {
    const { QantasAPI } = loadClient(CONFIGURED);
    const res = await QantasAPI().rollback('300000204909');
    expect(res.result).toBe('FAILED');
  });
});
