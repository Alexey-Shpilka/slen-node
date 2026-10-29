# Changelog

All notable changes to `@slen/sdk` are written here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow [Semantic Versioning](https://semver.org/), and before 1.0 a minor version may break.

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

[0.3.0]: https://github.com/Alexey-Shpilka/slen-node/releases/tag/v0.3.0
