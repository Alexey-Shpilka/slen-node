# Changelog

All notable changes to `@slen/sdk` are written here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow [Semantic Versioning](https://semver.org/), and before 1.0 a minor version may break.

## [Unreleased]

## [0.4.0] - 2026-10-31

### Breaking
- `customers.prices()` answers a `CreditPriceList` — `{ data: CreditPrice[] }`, the body of `GET /v1/credit-prices` — instead of the bare list, so the answer has a place for the id of its response; read the rows as `prices.data`. The PHP SDK answers the same object.
- Every call that reads an answer returns `Promise<WithRequestId<T>>`, the answer typed as before with `_request_id` beside it. Code that names the result `Customer`, `Page<Customer>` or another wire type keeps compiling; code that declared `Promise<Customer>` for a function returning a call's result keeps compiling too.
- A 204 answered to a call that reads an answer is an `InvalidResponseError`; it used to resolve `undefined`.
- An error takes its `requestId` from the `X-Request-Id` header of the answer first, then from `error.request_id` of its body (it was the other way round; the two carry the same id).

### Added
- `customers.listAll(options)` and `customers.entriesAll(externalUserId, options)`: every customer and every entry of a statement, page after page, as async generators. A page is asked for when the loop reaches it; `cursor` is where it starts, `limit` the size of a page, `timeoutMs`, `retries` and `signal` hold for each page.
- `_request_id` on the answer of every call that reads one: the `X-Request-Id` of the response, not enumerable, so `JSON.stringify` and a spread leave it out. `executions.wait()` gives the id of its last read.
- `requestId` in the options of every call: your own id of the request, sent as `X-Request-Id` on each attempt and kept by the API; 8 to 128 of `A-Z a-z 0-9 . _ : -`, anything else refused before the wire. Not taken by `listAll()`, `entriesAll()` or `executions.wait()`, which make more than one request.
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

[Unreleased]: https://github.com/Alexey-Shpilka/slen-node/compare/v0.4.0...HEAD
[0.4.0]: https://github.com/Alexey-Shpilka/slen-node/compare/v0.3.1...v0.4.0
[0.3.1]: https://github.com/Alexey-Shpilka/slen-node/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/Alexey-Shpilka/slen-node/releases/tag/v0.3.0
