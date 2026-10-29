import { afterEach, describe, expect, it, vi } from 'vitest';
import { generateIdempotencyKey, idempotencyKeyForJob } from '../src/idempotency.js';
import { OtlpSpanRecorder } from '../src/observability/otlp.js';
import type { SlenSpan } from '../src/observability/span.js';
import { Slen } from '../src/slen.js';
import { FakeFetch } from '../src/testing/index.js';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('the key of a background job', () => {
  // A retried job sends its run again under the same key, and the server answers with the first run.
  it('is one key for the whole job, the same on every attempt', () => {
    expect(idempotencyKeyForJob('3f0c1d7e', 'support.answer')).toBe('job:3f0c1d7e:support.answer');
    expect(idempotencyKeyForJob('3f0c1d7e', 'support.answer')).toBe(idempotencyKeyForJob('3f0c1d7e', 'support.answer'));
  });

  it('fits the 190 characters the server takes, under the longest operation code', () => {
    expect(idempotencyKeyForJob('3f0c1d7e-5b1a-4c8e-9d2f-7a6b5c4d3e2f', 'o'.repeat(120)).length).toBeLessThanOrEqual(190);
  });

  it.each([
    ['', 'support.answer'],
    ['3f0c1d7e', ' '],
  ])('refuses a job id %j or an operation %j that is empty', (jobId, operation) => {
    expect(() => idempotencyKeyForJob(jobId, operation)).toThrow(TypeError);
  });
});

describe('a generated key', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('is a v4 UUID, and a new one every time', () => {
    const first = generateIdempotencyKey();

    expect(first).toMatch(UUID_V4);
    expect(generateIdempotencyKey()).not.toBe(first);
  });

  it('is built from getRandomValues on a runtime whose Web Crypto has no randomUUID', () => {
    const platform = globalThis.crypto;

    vi.stubGlobal('crypto', {
      getRandomValues: (array: Uint8Array): Uint8Array => platform.getRandomValues(array),
    });

    const first = generateIdempotencyKey();

    expect(first).toMatch(UUID_V4);
    expect(generateIdempotencyKey()).not.toBe(first);
  });
});

// Below the floor (Node 20.3) there is no global Web Crypto: such a runtime fails, but says what it is missing.
describe('a runtime without Web Crypto', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const SPAN: SlenSpan = {
    operation: 'operations.execute',
    outcome: 'ok',
    status: 'completed',
    durationMs: 12,
    executionId: '74438200973594700',
    operationCode: 'support.answer',
    estimated: '0.02700000',
    actual: null,
    errorCode: null,
    cacheHit: false,
  };

  it('names what is missing instead of a TypeError about undefined', () => {
    vi.stubGlobal('crypto', undefined);

    let thrown: unknown;

    try {
      generateIdempotencyKey();
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect(thrown).not.toBeInstanceOf(TypeError);
    expect((thrown as Error).message).toContain('Web Crypto');
    expect((thrown as Error).message).toContain('Node 20.3');
  });

  it('refuses a run that needs a key with that same message, before anything is sent', async () => {
    const http = new FakeFetch();
    const slen = new Slen({ apiKey: 'sl_live_key', fetch: http.fetch });

    vi.stubGlobal('crypto', undefined);

    await expect(slen.operations.execute('support.answer', { messages: [] })).rejects.toThrow(/Web Crypto.*Node 20\.3/s);
    expect(http.requests).toEqual([]);
  });

  it('drops an OTLP span it cannot give an id to, and says so to onError — not to the call it describes', async () => {
    const collector = new FakeFetch();
    const dropped: Array<{ message: string; spans: number }> = [];
    const recorder = new OtlpSpanRecorder({
      endpoint: 'http://collector:4318',
      flushIntervalMs: 0,
      fetch: collector.fetch,
      onError: (error, spans) => {
        dropped.push({ message: error.message, spans });
      },
    });

    vi.stubGlobal('crypto', undefined);

    expect(() => {
      recorder.record(SPAN);
    }).not.toThrow();
    await recorder.flush();

    expect(dropped).toEqual([{ message: expect.stringContaining('Web Crypto') as string, spans: 1 }]);
    expect(collector.requests).toEqual([]);
  });
});

describe('the declared runtime floor', () => {
  interface NodeFs {
    readFileSync(path: URL, encoding: 'utf8'): string;
  }

  // No `@types/node` in this package: the module is loaded through a specifier
  // the compiler does not try to resolve (as in `errors.test.ts`).
  const NODE_FS: string = 'node:fs';

  it('is Node 20.3 — a line that has a global Web Crypto', async () => {
    const { readFileSync } = (await import(NODE_FS)) as NodeFs;
    const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      engines: { node: string };
    };

    // The message of `webCrypto()`, the README and the `typescript-floor` CI job name it too.
    expect(manifest.engines.node).toBe('>=20.3');
  });
});
