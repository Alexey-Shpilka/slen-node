# Slen TypeScript SDK

`@slen/sdk` runs your flows and reads how they ended, keeps your end customers and their credits, and checks the webhooks Slen sends you.

- **Zero runtime dependencies.** Built on `fetch` and Web Crypto: Node ≥ 20.3, Deno, Bun, workers.
- **ESM + CJS**, types included. `@opentelemetry/api` is an optional peer, never imported statically.
- Money and credits are decimal strings, never numbers; ids are strings. Answers keep the wire's field names (`execution_id`, `error_code`).

## Install

```bash
npm install @slen/sdk
```

## Compatibility

| | Versions | Held by |
|---|---|---|
| Node.js | 20.3 and newer | the suite on Node 22; the built package run on exactly 20.3.0 (`scripts/floor.mjs`) |
| Modules | ESM and CommonJS | both builds ship in `dist/` and are loaded by the floor |
| OpenTelemetry | `@opentelemetry/api` 1.7 and newer, optional | only `otelSpanRecorder()` needs it |

## The client

```ts
import { Slen } from '@slen/sdk';

const slen = new Slen({ apiKey: process.env.SLEN_API_KEY });
```

The key is the project's API key; left out, it is read from `SLEN_API_KEY`, and no other variable is read. The client talks to the hosted API. Building it checks the options and touches no network: a missing key is a `TypeError`, a timeout or a retry count out of range a `RangeError`.

| Option | Default | |
|---|---|---|
| `apiKey` | `SLEN_API_KEY` | the project's key, `sl_live_…` |
| `timeoutMs` | `65_000` | how long one attempt may take; `Infinity` switches the clock off |
| `retries` | `2` | attempts after the first when there is no answer, a 429 or a 503 |
| `logger` | none | the journal of the SDK — below |
| `spanRecorder`, `otlp` | none | where spans go — below |
| `webhookSecret`, `webhookToleranceSeconds` | none, `300` | for checking webhooks — below |
| `fetch`, `headers` | the runtime's `fetch`, none | the SDK's own headers win over yours |

**How a call is written.** What names the thing is positional — an operation, an external user id, an amount of credits — and everything else is one object of options in camelCase. Every call that goes to the API also takes `signal` (aborting it ends the call with the signal's reason), `timeoutMs` (a clock for each attempt of that call in place of the client's) and `retries` (how often that call is sent again, in place of the client's; `0` sends it once); a call that sends a body takes `idempotencyKey`. `executions.wait()` takes `signal` and a `timeoutSeconds` of its own, and gives each of its reads what is left of it. The options are named as the PHP SDK names its classes: `RequestOptions`, `ExecuteOptions`, `WaitOptions`, `CustomerListOptions`, `AccountOptions`, `BlockOptions`, `MovementOptions`, `EntryListOptions`, `PriceListOptions`, `VerifyOptions`, `WebhooksOptions`.

## Run a flow

A flow is run by the code of the operation it is bound to. A flow with a model node reads the conversation from `input.messages`.

```ts
const run = await slen.operations.execute(
  'support.reply',
  { messages: [{ role: 'user', content: 'Where is my order?' }] },
  { customer: 'user_8421', idempotencyKey: 'ticket-42:reply' },
);

run.status; // queued | waiting | running | completed | rejected | failed | uncertain

if (run.status === 'completed') {
  console.log(run.output);
}
```

- `customer` is the end customer the run is for, and pays in their credits (`context.user_id`); `creditType` names their account (`context.credit_type`). Anything else the flow reads goes in `context`; a `user_id` there that is not `customer` is refused before the wire.
- **The idempotency key is yours to choose**, derived from the unit of work (`ticket-42:reply`). The server runs a key once: a second request under it runs nothing and answers with that run as it is now (`replayed: true`). Without a key the SDK makes one up, which covers its own retries and nothing else. For a job of your own queue, `idempotencyKeyForJob(jobId, 'support.reply')` gives every attempt of the job the same key.
- **A refusal is an answer or an error, depending on the flow.** A `reject` node answers `200` with `status: 'rejected'` and its code in `error_code` (`isRejected(run)`); a refusal of the platform the flow did not route is thrown (below). `failed` and `uncertain` are runs that broke — read `error_code`, and `error_message` to show or log.
- `isCompleted(run)`, `isRejected(run)`, `isPending(run)` (`queued`, `waiting`, `running`) and `isFinished(run)` (anything else) read the status, as the methods of the same names do in PHP.
- The money of the run's model calls is held and settled inside the flow. `cost.estimated` is known when a model call was authorized; `cost.actual` arrives a minute or two after the run ended, so the answer of a run that has just finished carries `null` there.

`executeAsync()` takes the same arguments and answers at once with `status: 'queued'`, for a run that goes on in the background.

## Wait for a run

```ts
const queued = await slen.operations.executeAsync(
  'report.summarize',
  { messages: [{ role: 'user', content: 'Summarize the third-quarter report.' }] },
  { idempotencyKey: 'report-2026-q3:summary' },
);

const finished = await slen.executions.wait(queued.execution_id, {
  timeoutSeconds: 120,
  onPollError: (error, failuresInARow) => console.warn(error.code, failuresInARow),
});
```

`wait()` reads the run until it is over, at the pace the server asks for (`retry_after_seconds`; otherwise 1 s doubling up to 30 s). When the timeout is up it answers the last state it read, which may still be pending — that is not an error. A read that gets no answer, a 429 or a 5xx is told to `onPollError` and the wait goes on; any other failure is thrown at once. `timeoutSeconds` defaults to 300; `Infinity` waits without a ceiling and gives up after ten failed reads in a row. `signal` ends a wait.

`slen.executions.get(id)` reads the run once; `slen.executions.trace(id)` reads the nodes it walked and its events.

## End customers

A customer is your own user, named by your own opaque id (`external_user_id` — not an email address). Their credits sit in one account per credit type.

```ts
await slen.customers.create('user_8421');
await slen.customers.topUp('user_8421', '100.0000', { note: 'Invoice 7781', idempotencyKey: 'invoice-7781:topup' });

const customer = await slen.customers.get('user_8421');
const account = await slen.customers.charge('user_8421', '5.0000', { note: 'PDF export', idempotencyKey: 'export-991:charge' });
```

| Call | What it does |
|---|---|
| `list({ cursor, limit, search, status, creditType, lowBalance })` | customers with their accounts, a page at a time (`data`, `meta.next_cursor`) |
| `get(id)`, `create(id)` | one customer with every account; `create()` is idempotent and moves no credits |
| `updateAccount(id, creditType, { allowNegative, lowBalanceThreshold })` | the settings of one account; what is left out goes back to `false` and `'0'` |
| `block(id, { reason })`, `unblock(id)` | a blocked customer's new runs are refused (`CustomerBlockedError`); their balance can still be settled |
| `delete(id)` | a customer with no history; one with history is refused (409) — block them instead |
| `topUp(id, credits, options)`, `charge(id, credits, options)` | add credits; take them for a service of your own application. Above zero |
| `adjust(id, credits, options)` | an operator's correction, with a sign; not zero |
| `entries(id, { cursor, limit, creditType, entryType })` | the statement of the customer's accounts |
| `prices({ operationCode, creditType })` | what an operation costs in credits |

Credits are a decimal string of at most four places (`'5'`, `'5.25'`, `'-3.0000'`); anything else is refused before the wire. A movement takes `creditType` (default `'default'`), `note` and `idempotencyKey`; under the same key the server moves the credits once.

## Webhooks

```ts
import { webhooks } from '@slen/sdk';

// `request` is the Fetch API `Request` of your route handler.
const event = await webhooks.constructEvent(await request.text(), request.headers.get('slen-signature'), {
  secret: process.env.SLEN_WEBHOOK_SECRET ?? '',
});

if (event.type === 'execution.finished') {
  console.log(event.data.execution_id, event.data.status);
}
```

`constructEvent()` checks the `Slen-Signature` header against the raw body — exactly the bytes that arrived, as a string or a `Uint8Array` — and reads the event. A signature that does not hold is a `WebhookSignatureError` whose `reason` says which check refused it (`missing_header`, `malformed_header`, `outside_tolerance`, `no_matching_signature`): answer 400 and do nothing with the body. A signed body that is not an event is an `InvalidResponseError` (`webhook_payload_invalid`). `verify()` answers `true` or `false` and reads nothing.

`execution.finished`, `customer.balance_low`, `approval.requested` and `approval.decided` are typed: `event.type` narrows `event.data`. Every other event arrives with its `data` as it was sent. A receiver needs the endpoint's signing secret, not an API key: the client-free `webhooks` takes it in the options of the call (`secret`), and `slen.webhooks` uses the `webhookSecret` of the client unless the call names one. A signature older than `webhookToleranceSeconds` (300) is refused; `toleranceSeconds` and `now` of the options change that for one call. A secret that is empty, or none at all, is a `TypeError` before anything is checked.

## The journal

```ts
const slen = new Slen({ apiKey: process.env.SLEN_API_KEY, logger: console });
```

`logger` is `console` or any object with `debug`, `info`, `warn` and `error`. Each event is a name of `LOG_EVENTS` with a context of snake_case fields — the PHP SDK writes the same names with the same fields:

| Event | Level | When |
|---|---|---|
| `slen.request`, `slen.response` | debug | every attempt; the answer, with `status`, `duration_ms` and `request_id` |
| `slen.retry` | warn | an attempt that is repeated: `reason` `no_answer`, `rate_limited` or `unavailable`, `delay_ms` |
| `slen.refused` | info | a 4xx |
| `slen.unauthorized` | error | a 401, or a 403 about the key |
| `slen.failed` | error | a 5xx, an unreadable answer, or no answer after every attempt — with `error_type` |
| `slen.wait.poll`, `slen.wait.poll_failed` | debug, warn | the reads of a wait |
| `slen.webhook.rejected` | warn | a webhook refused, with `reason` |

A request is written by its route — `POST /v1/customers/{externalUserId}/charge`, never the values in it. The journal never carries the API key, the webhook secret, an idempotency key, a body, the server's error message, or a value of the path or the query. A logger that throws does not fail the call.

```ts
const slenOfThisRequest = slen.withLogger(requestLogger);
```

`withLogger()` answers a new client that writes to another logger — one that carries the id of the request your server is handling, say. It sends through the same `fetch` and records into the same span recorders, so one `flush()` sends what both recorded; the client it was made from is not changed and keeps writing where it did.

## Spans

A run leaves one span: `operations.execute`, `operations.execute_async`, or `executions.wait` for a wait. Its ten fields are the call, `outcome` (`ok`, `refused`, `error`), the run's `status`, `durationMs`, `executionId`, `operationCode`, `estimated`, `actual`, `errorCode` and `cacheHit` — ids, money and a verdict, never a prompt or an answer. Credit movements and webhooks leave none.

```ts
import { LoggerSpanRecorder, Slen } from '@slen/sdk';

const slen = new Slen({
  apiKey: process.env.SLEN_API_KEY,
  spanRecorder: new LoggerSpanRecorder(console),
  otlp: { endpoint: 'http://collector:4318', serviceName: 'billing-api' },
});
```

`spanRecorder` takes any `{ record(span) }`: `LoggerSpanRecorder` writes one line per span, `MemorySpanRecorder` keeps them, `otelSpanRecorder(tracer)` hands them to an OpenTelemetry tracer of yours. `otlp` sends them to an OTLP/HTTP collector in batches; call `await slen.flush()` before a short-lived process exits. A recorder that throws does not fail the call.

## Long-running servers

A server builds the client once and serves every request with it. A `Slen` keeps no state of a call, so one per process is the rule; one per request works too, at the cost of a new client each time.

```ts
// Once per process.
const slen = new Slen({ apiKey: process.env.SLEN_API_KEY, logger });

// In each request: the request's logger goes on a copy; the shared client writes where it did.
const run = await slen.withLogger(requestLogger).operations.execute('support.reply', input, {
  idempotencyKey: `ticket-${ticketId}:reply`,
  timeoutMs: 20_000,
  retries: 0,
});
```

- **The context of a request goes through `withLogger()`**: a copy over the same `fetch` and span recorders, so one `flush()` sends what both recorded. Never change the shared client.
- **Do not wait in a request handler.** `executions.wait()` keeps the handler open for as long as the run takes. Start the run with `executeAsync()` and learn its end from the `execution.finished` webhook, or wait in a queue worker.
- **A run inside a request gets a budget of its own**: `timeoutMs` and `retries` of the call (above), not the client's minutes.
- **One client per API key**, built where the key is known; no cache of clients in module scope keyed by it.
- **`FakeFetch` and `MemorySpanRecorder` keep everything** they are given: they are for tests, never for a server.

## Errors

Every failure is a `SlenError` with `code`, `status`, `details`, `requestId` (what support finds the request by) and `retryAfterSeconds`. The code decides the type; a code this version has no name for falls back by status:

| Error | Codes | Fallback |
|---|---|---|
| `AuthenticationError` | `invalid_api_key`, `insufficient_scope`, `not_authenticated`, `not_a_member`, `account_suspended` | any other 401 / 403 |
| `PolicyDeniedError` | `policy_denied`, `model_not_allowed` | |
| `CustomerBlockedError` (a `PolicyDeniedError`) | `customer_blocked` | |
| `SpendRefusedError` (the family below) | `budget_exceeded`, `operation_limit_exceeded`, `concurrency_limit_exceeded`, `insufficient_credits`, `overrun_stopped`, `overrun_approval_required` | any other 402 |
| `RateLimitError` | `rate_limit_exceeded` | any other 429 |
| `IdempotencyConflictError` | `idempotency_conflict`, `idempotency_in_progress` | |
| `CustomerNotFoundError` | `customer_not_found` | |
| `ProviderError` | `provider_error`, `provider_unavailable`, `provider_timeout`, `provider_rate_limit`, `provider_not_configured`, `pool_exhausted` | any other 5xx |
| `OperationUncertainError` | `operation_uncertain` | |
| `ServiceUnavailableError` | `ledger_unavailable`, `service_unavailable` | |
| `FlowRuntimeError` | `flow_runtime_error`, `unrouted_port`, `step_limit_exceeded`, `http_request_failed`, `unknown_node`, `node_type_not_supported`, `execution_conflict` | |
| `TimeoutError` | `execution_timeout`, `background_hold_expired` | no answer in time (the SDK's own, no code) |
| `ConnectionError` | | Slen could not be reached, or the connection broke (the SDK's own, no code) |
| `InvalidResponseError` | `invalid_response`, `webhook_payload_invalid` (the SDK's own) | |
| `WebhookSignatureError` | `webhook_signature_invalid` (the SDK's own) | |
| `InvalidRequestError` | `cost_calculation_failed`; `invalid_request` (the SDK's own: refused before the wire) | everything else |

The same code is the same type in the PHP SDK: the table is `contract/error-codes.json` at the root of the repository. Every 402 extends `SpendRefusedError`, so "money said no" is one arm that still knows which. A 429 is not in it: `RateLimitError` is the key's own request rate.

**What is retried.** No answer, a 429 and a 503 are sent again, under the same idempotency key, up to `retries` times: a `Retry-After` of up to 30 s is waited out, a longer one comes back to you as `retryAfterSeconds`; otherwise the pause is 200 ms doubling, at most 5 s. A 500, 502 or 504 is never repeated — a provider may have been paid.

**Which of them may have cost money.** The money of a run is the money of the model calls its flow made. The types are drawn along that line, with one exception — the second `ProviderError` row, where the code has to be read as well:

| Error | Was money spent? | Send it again? |
|---|---|---|
| `SpendRefusedError`, `PolicyDeniedError`, `RateLimitError`, `InvalidRequestError`, `AuthenticationError`, `IdempotencyConflictError` — thrown before the run began | no — nothing ran and nothing was held | only once what was refused has changed |
| `ServiceUnavailableError` | no — Slen did not carry the request out | yes, later, under the same key |
| `TimeoutError`, `ConnectionError` raised by the SDK (`code === null`) | unknown — the request may have reached the server | under the same key only: the SDK has already repeated it so, and the server runs a key once |
| `OperationUncertainError` | **unknown — it may have been.** A provider was called and its answer never came; the hold is left in place until it expires | not under a new key: under the same one the server answers with the run as it ended and runs nothing |
| `ProviderError` with a provider's code — `provider_error`, `provider_unavailable`, `provider_timeout`, `provider_rate_limit`, `provider_not_configured`, `pool_exhausted` | no — for the model call that failed: its hold was given back. A model call the run made before it was paid for (last row) | as the last row says; `provider_not_configured` needs a connection set up first |
| `ProviderError` with any other code, or with none (`code === null`) | **unknown.** A 5xx without a code this version knows lands here too — the page of a proxy that gave up, a bare 500 — and it does not say how far the run got | as for `OperationUncertainError`: not under a new key |
| `FlowRuntimeError` — and **any of the above out of `operations.execute()`** once the walk has begun: a `ProviderError`, a `SpendRefusedError` or a `PolicyDeniedError` of a later node, `ledger_unavailable`, the server's `execution_timeout` and `background_hold_expired` | whatever model calls the flow made before it stopped were paid for | a repeat under a new key pays for those again. Under the same key the server answers with the run as it ended (`replayed`) and runs nothing — fix the flow or its input, then send it under a new one |

A credit movement (`topUp`, `charge`, `adjust`) moves credits once per key: after a `TimeoutError` or a `ConnectionError`, send it again under the same key.

A success the SDK cannot read — a 2xx whose body is not the API's envelope, such as the page of a proxy — is an `InvalidResponseError` with the status it came with. The call may have gone through; it is not repeated, and the body is never quoted.

## Testing your own code

```ts
import { FakeFetch, MemorySpanRecorder, Slen } from '@slen/sdk';

const http = new FakeFetch().push({ status: 200, body: { data: { status: 'ok' } } });
const spans = new MemorySpanRecorder();
const slen = new Slen({ apiKey: 'key-for-tests', fetch: http.fetch, spanRecorder: spans });
```

`FakeFetch` answers from the queue `push()` fills and keeps every request it was given (`requests`, `last()`): method, URL, headers and the body as JSON. `MemorySpanRecorder` keeps the spans (`spans`, `last()`). Both are what the SDK's own suite uses.

## Development

```bash
docker run --rm -v "$PWD":/app -w /app node:22-alpine sh -c 'npm ci && npm run typecheck && npm test && npm run build'
```

The suite reads `contract/` — the contract both SDKs share, copied here and not edited by hand — and runs the examples of `examples/help`. With `SLEN_OPENAPI_SPEC` naming the API's OpenAPI spec, the contract test and the help examples are held against it as well; without it those checks are skipped. `AGENTS.md` has the rules of the package.
