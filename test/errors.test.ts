import { describe, expect, it } from 'vitest';
import * as errors from '../src/errors.js';
import {
  ConcurrencyLimitError,
  ConnectionError,
  FlowRuntimeError,
  InvalidRequestError,
  OperationLimitExceededError,
  OperationUncertainError,
  ProviderError,
  RateLimitError,
  ServiceUnavailableError,
  SlenError,
  SpendRefusedError,
  TimeoutError,
} from '../src/errors.js';
import { errorFromResponse, MAPPED_ERROR_CODES } from '../src/http/error-mapper.js';
import { Slen } from '../src/slen.js';
import { FakeFetch } from '../src/testing/index.js';
import { CONTRACT as CONTRACT_DIRECTORY } from './paths.js';

/**
 * One wire code is one type in every SDK. The table is not written here: it is
 * read from `contract/error-codes.json`, the copy of the contract the PHP SDK
 * builds its cases from as well — so the two tables cannot drift apart without
 * one of the suites going red.
 */
interface ErrorContract {
  /** A type is the class `{Type}Error` here; `Slen` is the root. */
  types: Record<string, { extends: string }>;
  codes: Record<string, { status: number; type: string }>;
  fallback: { by_status: Record<string, string>; server_error: string; otherwise: string };
  /** The codes the SDKs raise themselves, and which SDK raises each. */
  local: Record<string, { type: string; sdks: string[]; raised: string }>;
}

// The package has no `@types/node`, so the one member of `node:fs` used here is
// described structurally and the module is loaded through a specifier the
// compiler does not try to resolve (as in `timeout.test.ts`).
interface NodeFs {
  readFileSync(path: URL, encoding: 'utf8'): string;
}

const NODE_FS: string = 'node:fs';
const { readFileSync } = (await import(NODE_FS)) as NodeFs;

function readContract(): ErrorContract {
  try {
    return JSON.parse(
      readFileSync(new URL('error-codes.json', CONTRACT_DIRECTORY), 'utf8'),
    ) as ErrorContract;
  } catch (cause) {
    throw new Error(
      'contract/error-codes.json could not be read where test/paths.ts says it is.',
      { cause },
    );
  }
}

const CONTRACT = readContract();

type ErrorClass = new (...args: never[]) => SlenError;

const EXPORTED: Record<string, unknown> = { ...errors };

function classOf(type: string): ErrorClass {
  const found = EXPORTED[`${type}Error`];

  if (typeof found !== 'function') {
    throw new Error(`The contract names the type "${type}", and errors.ts exports no ${type}Error.`);
  }

  return found as ErrorClass;
}

/** The exact class of what was thrown — `toBeInstanceOf` would accept a subclass. */
function typeOf(error: unknown): unknown {
  return (Object.getPrototypeOf(error) as { constructor: unknown }).constructor;
}

const CODES = Object.entries(CONTRACT.codes).map(([code, entry]) => [code, entry.status, entry.type] as const);

// A status no entry of the contract uses and no fallback rule names.
const NEUTRAL_STATUS = 418;

const FALLBACKS: Array<readonly [number, string]> = [
  ...Object.entries(CONTRACT.fallback.by_status).map(([status, type]) => [Number(status), type] as const),
  ...[500, 502, 503, 504, 599].map((status) => [status, CONTRACT.fallback.server_error] as const),
  ...[400, 404, 409, 419, 422].map((status) => [status, CONTRACT.fallback.otherwise] as const),
];

/** The client on a `FakeFetch`, one attempt per call: a 429 or a 503 comes back as it is. */
function harness(): { client: Slen; http: FakeFetch } {
  const http = new FakeFetch();

  return { client: new Slen({ apiKey: 'sl_live_key', baseUrl: 'https://sdk.example', fetch: http.fetch, retries: 0 }), http };
}

/** What a run of an operation rejects with when the server refuses it so. */
function execute(client: Slen): Promise<unknown> {
  return client.operations.execute('support.reply', { question: 'hello' }, { idempotencyKey: 'ticket-42' }).catch((error: unknown) => error);
}

async function refuse(code: string, status: number): Promise<unknown> {
  const { client, http } = harness();
  http.push({ status, body: { error: { code, message: `refused: ${code}`, details: { budget_id: '9' } } } });

  return execute(client);
}

describe('the error contract (contract/error-codes.json)', () => {
  it.each(CODES)('maps %s (%i) to %s', async (code, status, type) => {
    const error = await refuse(code, status);

    expect(typeOf(error)).toBe(classOf(type));
    expect((error as SlenError).code).toBe(code);
    expect((error as SlenError).status).toBe(status);
    expect((error as SlenError).details).toEqual({ budget_id: '9' });
  });

  // A code in the table wins over the status: `provider_rate_limit` is a
  // provider failure although it travels as 429.
  it.each(CODES)('maps %s to its type whatever the status', async (code, _status, type) => {
    expect(typeOf(await refuse(code, NEUTRAL_STATUS))).toBe(classOf(type));
  });

  it.each(FALLBACKS)('falls back by status for a code outside the table: %i → %s', async (status, type) => {
    const error = await refuse('some_future_code', status);

    expect(typeOf(error)).toBe(classOf(type));
    expect((error as SlenError).code).toBe('some_future_code');
  });

  // The wire is not ours to trust: a code that happens to be the name of
  // something every object inherits is a code outside the table like any other.
  it.each(['constructor', 'toString', 'valueOf', 'hasOwnProperty', '__proto__'])(
    'falls back by status for a code named like an object member: %s',
    (code) => {
      const error = errorFromResponse(500, { error: { code, message: 'boom' } }, null);

      expect(typeOf(error)).toBe(classOf(CONTRACT.fallback.server_error));
      expect(error.code).toBe(code);
      expect(error.message).toBe('boom');
    },
  );

  // Both directions: a code the contract lists and the table does not would
  // fail above only when the fallback happens to disagree, and a code the
  // table maps on its own would not fail at all.
  it('maps exactly the codes of the contract', () => {
    expect([...MAPPED_ERROR_CODES].sort()).toEqual(Object.keys(CONTRACT.codes).sort());
  });

  it.each(Object.entries(CONTRACT.types))('puts %s where the contract puts it', (type, entry) => {
    expect(Object.getPrototypeOf(classOf(type))).toBe(classOf(entry.extends));
  });

  // The codes the SDKs raise themselves are part of the contract too: each
  // travels in a type of the hierarchy, and none of them is a wire code.
  it.each(Object.entries(CONTRACT.local).filter(([, entry]) => entry.sdks.includes('typescript')))(
    'gives the local code %s a type of the hierarchy',
    (code, entry) => {
      expect(Object.keys(CONTRACT.types)).toContain(entry.type);
      expect(typeof classOf(entry.type)).toBe('function');
      expect(Object.keys(CONTRACT.codes)).not.toContain(code);
    },
  );
});

describe('error mapping', () => {
  // The two limits a budget puts on a call answer 402 like every
  // other budget refusal, and used to land outside the family — an
  // `instanceof SpendRefusedError` arm let them through.
  it('puts the whole 402 family under one arm', async () => {
    const family = [
      'budget_exceeded',
      'insufficient_credits',
      'overrun_stopped',
      'overrun_approval_required',
      'operation_limit_exceeded',
      'concurrency_limit_exceeded',
    ];

    for (const code of family) {
      expect(await refuse(code, 402), code).toBeInstanceOf(SpendRefusedError);
    }

    expect(await refuse('a_402_of_the_future', 402)).toBeInstanceOf(SpendRefusedError);
    expect(typeOf(await refuse('operation_limit_exceeded', 402))).toBe(OperationLimitExceededError);
    expect(typeOf(await refuse('concurrency_limit_exceeded', 402))).toBe(ConcurrencyLimitError);
  });

  // The key's own request rate is not money saying no: nothing was asked of a
  // budget. It has a type of its own, and so does a 429 nobody has a name for
  // yet; a provider's rate limit stays a provider failure.
  it('does not take a rate limit for a refusal of money', async () => {
    const limited = await refuse('rate_limit_exceeded', 429);

    expect(typeOf(limited)).toBe(RateLimitError);
    expect(limited).not.toBeInstanceOf(SpendRefusedError);
    expect(typeOf(await refuse('a_429_of_the_future', 429))).toBe(RateLimitError);
    expect(typeOf(await refuse('provider_rate_limit', 429))).toBe(ProviderError);
  });

  // "Nobody knows whether the money was spent" used to be caught as
  // a provider failure — the most dangerous answer as the safest.
  it('does not take an uncertain operation for a provider failure', async () => {
    const uncertain = await refuse('operation_uncertain', 504);

    expect(typeOf(uncertain)).toBe(OperationUncertainError);
    expect(uncertain).not.toBeInstanceOf(ProviderError);
    expect(uncertain).not.toBeInstanceOf(TimeoutError);
  });

  // Slen's own infrastructure and a flow that broke are not a provider's
  // failure either; before, each of these was a ProviderError by the fallback
  // for a 5xx.
  it.each([
    [503, 'ledger_unavailable', ServiceUnavailableError],
    [503, 'service_unavailable', ServiceUnavailableError],
    [500, 'unrouted_port', FlowRuntimeError],
    [500, 'step_limit_exceeded', FlowRuntimeError],
    [502, 'http_request_failed', FlowRuntimeError],
    [500, 'flow_runtime_error', FlowRuntimeError],
    // A 422 about the model's price list, not about a provider.
    [422, 'cost_calculation_failed', InvalidRequestError],
  ] as const)('gives a failure that is not the provider\'s its own type: %i %s', async (status, code, type) => {
    const error = await refuse(code, status);

    expect(typeOf(error)).toBe(type);
    expect(error).not.toBeInstanceOf(ProviderError);
  });

  // `provider_timeout` is the adapters' "the provider could not be reached":
  // the request never went out. A provider failure, not a timeout.
  it('takes a provider that could not be reached for a provider failure', async () => {
    expect(typeOf(await refuse('provider_timeout', 504))).toBe(ProviderError);
    expect(typeOf(await refuse('provider_unavailable', 502))).toBe(ProviderError);
    expect(typeOf(await refuse('execution_timeout', 504))).toBe(TimeoutError);
  });

  // The fallback for a 5xx is ProviderError too, and what lands in it is not a
  // provider's failure: the page of a proxy, a bare 500 — an answer that does
  // not say how far the call got. The class and the README
  // send the caller to the code to tell the two apart, so the fallback may
  // never borrow one: no code stays null. And the run that may have spent is
  // not sent a second time to find out.
  it.each([
    // What Laravel answers for an exception nothing renders.
    ['a bare 500', 500, { body: { message: 'Server Error' } }],
    ['the 502 page of a proxy', 502, { text: '<html><h1>502 Bad Gateway</h1></html>' }],
    ['the 504 page of a proxy', 504, { text: '<html><h1>504 Gateway Time-out</h1></html>' }],
    ['an envelope with no code in it', 503, { body: { error: { message: 'upstream is gone' } } }],
  ] as const)('leaves a server error nobody named without a code: %s', async (_name, status, answer) => {
    const { client, http } = harness();
    http.push({ status, ...answer });

    const error = (await execute(client)) as SlenError;

    expect(typeOf(error)).toBe(ProviderError);
    expect(error.code).toBeNull();
    expect(error.status).toBe(status);
    expect(http.requests).toHaveLength(1);
  });

  // The README tells a caller which ProviderError says "nothing was spent" for
  // the model call that failed: the one that carries a provider's code. That
  // list is the contract's — every code of the type `Provider` — so a code that joins or
  // leaves the type has to reach the row. And the row beside it, for everything
  // else that lands in the type, has to stay: it is the only place the caller
  // learns that the fallback is not safe.
  it('has the README trust a provider failure only under the provider codes of the contract', () => {
    const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
    const rows = readme.split('\n').filter((line) => line.startsWith('| `ProviderError` with '));

    expect(rows).toHaveLength(2);

    const [known, other] = rows as [string, string];
    const listed = [...(known.split('|')[1] ?? '').matchAll(/`([a-z]+(?:_[a-z]+)+)`/g)].map((match) => match[1]);
    const codes = Object.entries(CONTRACT.codes)
      .filter(([, entry]) => entry.type === 'Provider')
      .map(([code]) => code);

    expect([...new Set(listed)].sort()).toEqual([...codes].sort());
    expect(known).toContain('no —');
    expect(other).toContain('code === null');
    expect(other).toContain('**unknown.**');
    expect(other).toContain('`OperationUncertainError`');
  });

  // The rows of that table speak of one call. A flow is several: a walk that
  // throws answers with the envelope of the node that threw, so a 402 of a
  // second model node, or its `provider_error`, arrives after the first node
  // was paid for — as the very types the rows above call "no". The row of the
  // flow has to name them, or the table sends a caller to repeat a run under a
  // new key and pay for the first node twice.
  it('has the README take no error out of a flow for nothing spent', () => {
    const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
    // Not the row of the codes table, which begins with the same name.
    const rows = readme.split('\n').filter((line) => line.startsWith('| `FlowRuntimeError` — '));

    expect(rows).toHaveLength(1);

    const named = ['operations.execute()', '`ProviderError`', '`SpendRefusedError`', '`PolicyDeniedError`', 'were paid for'];

    for (const said of named) {
      expect(rows[0]).toContain(said);
    }
  });

  it('reads Laravel field validation, which carries no code', async () => {
    const { client, http } = harness();
    http.push({ status: 422, body: { message: 'The operation field is required.', errors: { operation: ['required'] } } });

    const error = (await execute(client)) as SlenError;

    expect(error).toBeInstanceOf(InvalidRequestError);
    expect(error.message).toBe('The operation field is required.');
    expect(error.details).toEqual({ errors: { operation: ['required'] } });
  });

  // A wire that failed used to be a TimeoutError with the code
  // `provider_timeout` — a wire code that means something else, on an error
  // no provider had anything to do with. It is a ConnectionError, and the
  // SDK's own failure carries no code and no status.
  it('turns a transport failure into a ConnectionError after the configured retries', async () => {
    let calls = 0;
    const client = new Slen({
      apiKey: 'sl_live_key',
      retries: 2,
      fetch: (async () => {
        calls += 1;

        throw new Error('socket hang up');
      }) as unknown as typeof fetch,
    });

    const error = (await client.executions.get('1').catch((thrown: unknown) => thrown)) as SlenError;

    expect(typeOf(error)).toBe(ConnectionError);
    expect(error).not.toBeInstanceOf(TimeoutError);
    expect(error.code).toBeNull();
    expect(error.status).toBeNull();
    expect(error.message).toContain('socket hang up');
    // The first attempt plus two retries: a replay is safe, the server dedups.
    expect(calls).toBe(3);
  });
});
