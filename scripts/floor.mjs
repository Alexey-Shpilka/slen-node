/**
 * The built package on the oldest Node `engines` allows.
 *
 *   npm run build && node scripts/floor.mjs
 *
 * The suite cannot run on the floor — its toolchain (vite) needs a newer
 * Node than the package does — so `engines` would
 * be a promise nothing checks. This is the check: what ships (`dist/`, both
 * module systems) is loaded on that Node and taken through the paths that lean
 * on the runtime rather than on the language — Web Crypto for keys and span
 * ids, `fetch` and its `Response` (a 204 too), `AbortController` for the
 * attempt clock, HMAC for webhooks. No network: `FakeFetch` is part of the package.
 *
 * It is the counterpart of `php -l` on PHP 8.3 in the PHP SDK, and CI runs it
 * on the exact floor (`typescript-floor` in `.github/workflows/ci.yml`).
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { roots } from './paths.mjs';

const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const RUN = {
  execution_id: '74438200973594700',
  status: 'queued',
  operation: 'floor',
  output: null,
  error: null,
  error_code: null,
  error_message: null,
  cost: { estimated: null, actual: null },
  cache: { hit: false, cached_at: null },
  replayed: false,
  waiting_on: { node_key: 'start', type: 'async_dispatch', resume_at: null },
  trace_url: '/v1/executions/74438200973594700',
  retry_after_seconds: 1,
};

// The package's entry point: the HTTP chain on the runtime's own `fetch`, `AbortController` and
// timers — a retry after a 503, the journal, a timed-out attempt of a copy with its own logger — and
// the modules: a run handed to a worker, a wait on it, its spans out through OTLP, a customer's page,
// every page of a loop (an async generator), the id of a response on an answer, and a delete answered 204.
async function exercise(sdk) {
  const http = new sdk.FakeFetch();
  const collector = new sdk.FakeFetch();
  const journal = [];
  const spans = [];
  const write = (event) => journal.push(event);
  const slen = new sdk.Slen({
    apiKey: 'sl_live_floor',
    baseUrl: 'https://floor.example',
    fetch: http.fetch,
    logger: { debug: write, info: write, warn: write, error: write },
    timeoutMs: 100,
    retries: 1,
    spanRecorder: { record: (span) => spans.push(span) },
    otlp: { endpoint: 'http://collector.example', fetch: collector.fetch, flushIntervalMs: 0 },
  });

  http.push({ status: 503, headers: { 'Retry-After': '0' }, body: {} });
  http.push({ body: { app: 'slen', mysql: 'ok' }, headers: { 'X-Request-Id': 'req-floor-health' } });
  http.push({ status: 202, body: { data: RUN } });
  http.push({ body: { data: { ...RUN, status: 'completed', waiting_on: null, retry_after_seconds: undefined } } });
  http.push({ body: { data: [], meta: { limit: 50, next_cursor: null } } });
  http.push({ body: { data: [{ external_user_id: 'floor-a' }], meta: { limit: 1, next_cursor: 'c1' } } });
  http.push({ body: { data: [{ external_user_id: 'floor-b' }], meta: { limit: 1, next_cursor: null } } });
  http.push({ status: 204 });
  http.push({ delayMs: 2_000, body: {} });

  const health = await slen.health();
  assert.equal(health.app, 'slen');
  assert.equal(health._request_id, 'req-floor-health');
  assert.deepEqual(Object.keys(health), ['app', 'mysql']);
  assert.equal(http.last().url, 'https://floor.example/api/health');
  assert.equal(http.last().headers['user-agent'], `slen-sdk-node/${manifest.version} node/${process.versions.node}`);
  assert.deepEqual(journal, ['slen.request', 'slen.retry', 'slen.request', 'slen.response']);

  const queued = await slen.operations.executeAsync('floor', { messages: [] }, { customer: 'floor-user' });
  assert.equal(queued.status, 'queued');
  assert.match(http.last().headers['idempotency-key'], UUID_V4);
  assert.deepEqual(http.last().body.context, { user_id: 'floor-user' });

  const done = await slen.executions.wait(queued.execution_id, { timeoutSeconds: 5 });
  assert.equal(done.status, 'completed');
  assert.deepEqual(
    spans.map((span) => [span.operation, span.status, span.operationCode]),
    [
      ['operations.execute_async', 'queued', 'floor'],
      ['executions.wait', 'completed', 'floor'],
    ],
  );

  assert.deepEqual(await slen.customers.list(), { data: [], meta: { limit: 50, next_cursor: null } });
  assert.equal(http.last().url, 'https://floor.example/api/v1/customers?view=customers&limit=50');

  const everyone = [];
  for await (const customer of slen.customers.listAll({ limit: 1 })) {
    everyone.push(customer.external_user_id);
  }
  assert.deepEqual(everyone, ['floor-a', 'floor-b']);
  assert.equal(http.last().url, 'https://floor.example/api/v1/customers?view=customers&cursor=c1&limit=1');

  assert.equal(await slen.customers.delete('floor-user'), undefined);

  const written = journal.length;
  const ofTheRequest = [];
  const keep = (event) => ofTheRequest.push(event);
  const copy = slen.withLogger({ debug: keep, info: keep, warn: keep, error: keep });

  await assert.rejects(copy.health({ retries: 0 }), (error) => error instanceof sdk.TimeoutError && error.code === null);
  assert.deepEqual(ofTheRequest, ['slen.request', 'slen.failed']);
  assert.equal(journal.length, written);
  await copy.flush();

  const exported = collector.requests.flatMap((request) => request.body.resourceSpans[0].scopeSpans[0].spans);
  assert.equal(exported.length, 2);
  assert.match(exported[0].traceId, /^[0-9a-f]{32}$/);
}

// Web Crypto's HMAC on this runtime: every vector the backend signed, as text and as bytes.
async function exerciseWebhooks(sdk) {
  const vectors = JSON.parse(readFileSync(new URL('webhook-vectors.json', roots().CONTRACT), 'utf8'));

  for (const vector of vectors.cases) {
    const options = { secret: vectors.secret, now: new Date(vector.now * 1_000), toleranceSeconds: vectors.tolerance_seconds };

    assert.equal(await sdk.webhooks.verify(vector.payload, vector.header, options), vector.valid, vector.name);
    assert.equal(await sdk.webhooks.verify(new TextEncoder().encode(vector.payload), vector.header, options), vector.valid, vector.name);

    if (vector.valid && vector.event !== null) {
      const event = await sdk.webhooks.constructEvent(vector.payload, vector.header, options);
      assert.deepEqual({ id: event.id, type: event.type }, vector.event, vector.name);
    }
  }
}

const require = createRequire(import.meta.url);
const builds = {
  esm: await import('../dist/esm/index.js'),
  cjs: require('../dist/cjs/index.js'),
};

for (const [name, sdk] of Object.entries(builds)) {
  assert.match(sdk.generateIdempotencyKey(), UUID_V4);
  await exercise(sdk);
  await exerciseWebhooks(sdk);
  console.log(`dist/${name}: ok`);
}

console.log(`@slen/sdk runs on Node ${process.versions.node} (engines: node ${manifest.engines.node})`);
