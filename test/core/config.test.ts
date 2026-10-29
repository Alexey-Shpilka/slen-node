import { afterEach, describe, expect, it, vi } from 'vitest';
import { apiBase, DEFAULT_BASE_URL, resolveConfig, type SlenOptions } from '../../src/config.js';
import { NOOP_LOGGER, type SlenLogger } from '../../src/logger.js';
import { Slen } from '../../src/slen.js';

describe('resolveConfig()', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('applies the defaults of the table of options', () => {
    const config = resolveConfig({ apiKey: 'sl_live_key' });

    expect(config).toEqual({
      apiKey: 'sl_live_key',
      baseUrl: DEFAULT_BASE_URL,
      timeoutMs: 65_000,
      retries: 2,
      headers: {},
      logger: NOOP_LOGGER,
      fetch: globalThis.fetch,
      webhookSecret: null,
      webhookToleranceSeconds: 300,
    });
    expect(DEFAULT_BASE_URL).toBe('https://api.slen.ai');
    expect(apiBase(config)).toBe('https://api.slen.ai/api');
  });

  it('takes what the options say', () => {
    const fetch = (async () => new Response('{}')) as typeof globalThis.fetch;
    const logger: SlenLogger = console;
    const config = resolveConfig({
      apiKey: 'sl_live_key',
      baseUrl: 'https://api.test//',
      timeoutMs: 1_500,
      retries: 0,
      headers: { 'X-Trace': 't-1' },
      logger,
      fetch,
      webhookSecret: 'whsec_1',
      webhookToleranceSeconds: 60,
    });

    expect(config).toEqual({
      apiKey: 'sl_live_key',
      baseUrl: 'https://api.test',
      timeoutMs: 1_500,
      retries: 0,
      headers: { 'X-Trace': 't-1' },
      logger,
      fetch,
      webhookSecret: 'whsec_1',
      webhookToleranceSeconds: 60,
    });
  });

  it('reads the key from SLEN_API_KEY when the options have none, and the option first', () => {
    vi.stubEnv('SLEN_API_KEY', 'sl_live_from_env');

    expect(resolveConfig({}).apiKey).toBe('sl_live_from_env');
    expect(resolveConfig({ apiKey: 'sl_live_option' }).apiKey).toBe('sl_live_option');
  });

  it('never reads the address from the environment', () => {
    vi.stubEnv('SLEN_BASE_URL', 'https://api.test');

    expect(resolveConfig({ apiKey: 'sl_live_key' }).baseUrl).toBe(DEFAULT_BASE_URL);
  });

  it.each([undefined, '', '   '])('refuses to be built without a key (%j)', (apiKey) => {
    vi.stubEnv('SLEN_API_KEY', undefined);

    expect(() => resolveConfig(apiKey === undefined ? {} : { apiKey })).toThrow(
      new TypeError('Slen: an apiKey is required (pass `apiKey` or set SLEN_API_KEY).'),
    );
  });

  it.each([
    ['timeoutMs', 0],
    ['timeoutMs', -1],
    ['timeoutMs', Number.NaN],
    ['retries', -1],
    ['retries', 1.5],
    ['webhookToleranceSeconds', 0],
    ['webhookToleranceSeconds', 2.5],
  ] as const)('refuses %s = %s with a RangeError', (name, value) => {
    expect(() => resolveConfig({ apiKey: 'sl_live_key', [name]: value } as SlenOptions)).toThrow(RangeError);
  });

  it('lets a timeout be switched off with Infinity', () => {
    expect(resolveConfig({ apiKey: 'sl_live_key', timeoutMs: Number.POSITIVE_INFINITY }).timeoutMs).toBe(Number.POSITIVE_INFINITY);
  });

  it('reads an empty webhook secret as none', () => {
    expect(resolveConfig({ apiKey: 'sl_live_key', webhookSecret: '' }).webhookSecret).toBeNull();
    expect(resolveConfig({ apiKey: 'sl_live_key', webhookSecret: '  ' }).webhookSecret).toBeNull();
  });

  it('refuses a runtime without fetch', () => {
    vi.stubGlobal('fetch', undefined);

    try {
      expect(() => resolveConfig({ apiKey: 'sl_live_key' })).toThrow(new TypeError('Slen: this runtime has no fetch; pass one as the `fetch` option.'));
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('is frozen, and so are its headers: a copy of the option, not the option', () => {
    const headers = { 'X-Trace': 't-1' };
    const config = resolveConfig({ apiKey: 'sl_live_key', headers });

    headers['X-Trace'] = 't-2';

    expect(config.headers).toEqual({ 'X-Trace': 't-1' });
    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.isFrozen(config.headers)).toBe(true);
  });
});

describe('new Slen()', () => {
  it('checks its options and touches no network', () => {
    let calls = 0;
    const fetch = (async () => {
      calls += 1;

      return new Response('{}');
    }) as typeof globalThis.fetch;

    new Slen({ apiKey: 'sl_live_key', fetch });

    expect(calls).toBe(0);
    expect(() => new Slen({ apiKey: 'sl_live_key', retries: -1, fetch })).toThrow(RangeError);
  });

  it('keeps the key out of what printing or serializing the client shows', () => {
    const slen = new Slen({ apiKey: 'sl_live_SECRET_KEY', fetch: (async () => new Response('{}')) as typeof fetch });

    expect(JSON.stringify(slen)).not.toContain('SECRET');
    // The modules are its only own properties, and they hold their settings in private fields.
    expect(Object.keys(slen).sort()).toEqual(['customers', 'executions', 'operations', 'webhooks']);

    for (const module of Object.values(slen)) {
      expect(Object.keys(module as object)).toEqual([]);
    }
  });
});
