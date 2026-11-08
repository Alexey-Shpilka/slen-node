# Changelog

All notable changes to `@slen/sdk` are written here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow [Semantic Versioning](https://semver.org/), and before 1.0 a minor version may break.

## [Unreleased]

### Added
- `'queue_slot'` in `ParkReason`, and so in `WaitingOn.type`: the run waits for a slot of a Queue node's limit of calls at once. `execute()` answers such a run at once — `status: 'waiting'`, `retry_after_seconds` 2 — and the run goes on by itself when a slot is freed; `wait()` follows it as it follows any other wait. `resume_at` is the deadline: a run still without a slot then leaves by the node's `busy` port, and with nothing connected there it ends `rejected` with `error_code` `concurrency_limit_exceeded`. The README shows the wait.

### Changed
- `ConcurrencyLimitError` (`concurrency_limit_exceeded`, 402) is the refusal of a flow's Queue node whose limit of calls at once is full and whose `busy` port leads nowhere — no longer of a `concurrency` budget, a type the API no longer creates. Its `details` are the node's `busy` output: `reason` (`timeout`, `refused`, `queue_full`), `key`, `limit`, `in_flight`, `waiting`, `waited_seconds`. The doc comment says so; the type and the code it maps are as they were.

## [0.5.0] - 2026-11-08

### Changed
- `FlowExecutionNode.cost` after the capture is the fact: the estimate the node's hold was taken on until the hold is captured, then what the provider billed — the sum of the call's attempts. `estimated_cost` keeps the estimate, `cost_status` says which of the two `cost` holds (`'estimated'`, `'actual'`), and `cost_incomplete` is `true` when the fact misses something the provider billed that Slen cannot price yet. The fact arrives up to a minute after the run ended. The three new fields are optional, as the spec has them.

### Added
- `warnings` on `ExecutionResult`, `ExecutionStatusView` and `ExecutionTrace`: what the run said about its request when it started and went on with — a list of `ExecutionWarning` (`code`, `keys`, `message`), empty when there is nothing to say. `input_key_ignored`: the input carried keys of a model call (`tools`, `model`, `temperature`, …, named in `keys`) that no node of the flow passes to the model; the trace has the event `input_keys_ignored`. The API always sends it, so the field is required: an answer written by hand — the one a test double queues — needs it too. The SDK writes a list that is not empty to the journal: `slen.execution.warnings` (`LOG_EVENTS.executionWarnings`) at the warn level, one record for each answer — `execute()`, `executeAsync()`, `get()`, `trace()`, and the state a `wait()` answers with — carrying the run's `execution_id` and each warning's `code` and `keys`, never its message.
- `ExecutionCost.incomplete`: `true` when a provider billed something Slen could not price for one of the run's calls — a usage field it does not know, a price tier, a cache write or a server tool without a price — and `actual` is then what Slen knew. Set together with `actual`; `false` until then. The API always sends it, so the field is required: an `ExecutionCost` written by hand — the answer a test double queues — needs it too.
- On `AttemptSummary`, the attempts of a trace node: `input_tokens` (the whole input, the cache read and writes included) and `output_tokens` (the whole paid output, reasoning included); `cached_input_tokens`, `cache_write_tokens`, `cache_write_long_tokens` and `reasoning_tokens`, the parts of those; `tool_calls`, the paid server-tool calls by name (`{ web_search: 6 }`); `cost_breakdown`, an `AttemptCostBreakdown` — `input`, `cached_input`, `cache_write`, `output`, `tools` by name and `total` — null until the attempt is priced; `cost_incomplete`, the attempt's own `incomplete`. Optional, as the spec has them.
- On `FlowExecutionNode`, the nodes of a trace: `output` — what a model node left, its answer on `success` / `tool_calls` (`content`, `finish_reason`, `usage`, `tool_calls`, …) or its `error` on a failure port (`{ class, code, http_status, message, provider, model, retry_after_seconds }`), as an open object; `output_truncated` — the kept output was cut to the limit (64 KB of JSON by default); `output_stored` — `'stored'`, `'disabled_by_project'` (the project keeps no model answers), `'withheld'` (grounded with Google Search: its `content` is not kept) or `'history_paused'`. Null for every other node; optional, as the spec has them — a trace of a backend that kept no outputs leaves them out.
- `model_retired` (403) becomes a `PolicyDeniedError`, as `model_not_allowed` does: a model its provider stopped listing, refused before any attempt — nothing was spent; the flow needs another model. Until now the API answered such a call with `model_not_allowed`; without the row the new code would fall back by status to `AuthenticationError`.
- `pool_unavailable` (503) is in the contract copies, unmapped: a model node whose provider keys were all cooling down or refused. It leaves the node by its `unavailable` port; a run that ends on it carries it as its `error_code`, and as an HTTP error it falls back by status to `ProviderError`, like any 5xx without a row.

## [0.4.1] - 2026-11-02

### Added
- `PlanLimitError` (a `SlenError`): a refusal of the organization's plan. `plan_limit_reached` (409) — one more would pass what the plan allows — and `plan_feature_unavailable` (403) — the plan does not include the feature — become it; until now they fell back by status to `InvalidRequestError` and `AuthenticationError`. Its `details` carry `required_plan`, the plan to upgrade to. On the Free plan `customers.create()` of a new customer, `updateAccount()` and a `topUp()` that would open an account are refused so: end customers need a paid plan. No run is refused by a plan.
- `ExecutionTrace.history_paused`: the month's executions with history had run out when the run reached its first model call — it ran with the money fully protected and wrote no trace, so `nodes` and `events` are empty. Absent from a backend before 1.0.23.

## [0.4.0] - 2026-10-31

### Breaking
- `customers.prices()` answers a `CreditPriceList` — `{ data: CreditPrice[] }`, the body of `GET /v1/credit-prices` — instead of the bare list, so the answer has a place for the id of its response; read the rows as `prices.data`. The PHP SDK answers the same object.
- Every call that reads an answer returns `Promise<WithRequestId<T>>`, the answer typed as before with `_request_id` beside it. Code that names the result `Customer`, `Page<Customer>` or another wire type keeps compiling; code that declared `Promise<Customer>` for a function returning a call's result keeps compiling too.
- A 204 answered to a call that reads an answer is an `InvalidResponseError`; it used to resolve `undefined`.
- An error takes its `requestId` from the `X-Request-Id` header of the answer first, then from `error.request_id` of its body (it was the other way round; the two carry the same id).

### Added
- `customers.listAll(options)` and `customers.entriesAll(externalUserId, options)`: every customer and every entry of a statement, page after page, as async generators. A page is asked for when the loop reaches it; `cursor` is where it starts, `limit` the size of a page, `timeoutMs`, `retries` and `signal` hold for each page.
- `_request_id` on the answer of every call that reads one: the `X-Request-Id` of the response, not enumerable, so `JSON.stringify` and a spread leave it out. `executions.wait()` gives the id of its last read.
- `requestId` in the options of every call: your own id of the request, sent as `X-Request-Id` on each attempt and kept by the API, and carried by the `ConnectionError` or `TimeoutError` of a call that got no answer; 8 to 128 of `A-Z a-z 0-9 . _ : -`, anything else refused before the wire. Not taken by `listAll()`, `entriesAll()` or `executions.wait()`, which make more than one request; the loops refuse one at the call.
- The types `WithRequestId<T>` and `CreditPriceList`.

## [0.3.1] - 2026-10-30

No change of the API or of behaviour.

### Changed
- The first version published from CI, with npm provenance: its page on npm links the workflow run and the commit it was built from.
- Built with TypeScript 7. The types that ship are compiled in CI as a consumer reads them, on TypeScript 5.0 and on 7, with Node's resolution and a bundler's.

## [0.3.0] - 2026-10-29

### Breaking
- Four option types are named as the PHP SDK names its classes: `CustomerListFilters` → `CustomerListOptions`, `AccountSettings` → `AccountOptions`, `EntryFilters` → `EntryListOptions`, `PriceFilters` → `PriceListOptions`. The old names are gone.
- `webhooks.verify()` and `webhooks.constructEvent()` take three parameters: the secret of a single check is `secret` of `VerifyOptions`, beside `toleranceSeconds` and `now`.

### Added
- `retries` of a single call in `RequestOptions`, beside `timeoutMs`; `0` sends the call once.
- `slen.health(options)` takes the options of a call.
- `slen.withLogger(logger)`: a copy of the client over the same `fetch` and span recorders, for the logger of one request.
- `isPending`, `isFinished` and `isCompleted` are exported, beside `isRejected`.
- A section on long-running servers and a section on compatibility in the README.

## [0.2.0]

The first tag; not published.

[Unreleased]: https://github.com/Alexey-Shpilka/slen-node/compare/v0.5.0...HEAD
[0.5.0]: https://github.com/Alexey-Shpilka/slen-node/compare/v0.4.1...v0.5.0
[0.4.1]: https://github.com/Alexey-Shpilka/slen-node/compare/v0.4.0...v0.4.1
[0.4.0]: https://github.com/Alexey-Shpilka/slen-node/compare/v0.3.1...v0.4.0
[0.3.1]: https://github.com/Alexey-Shpilka/slen-node/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/Alexey-Shpilka/slen-node/releases/tag/v0.3.0
