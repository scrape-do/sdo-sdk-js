<!-- SPDX-License-Identifier: Apache-2.0 -->
# Changelog

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- `jobs.createPlugin(key, params, options?, call?)`: plugin jobs on the async
  API (`{"Plugin": {"Key": ..., "Params": [...]}}`), one task per params entry,
  1 to 1000 entries. A malformed key, an empty or oversized list, or options
  that set `Targets` or `Plugin` throw `SdoConfigError`.
- `ListJobsOptions` (`page`, `pageSize` 1-100, `status`, `startFrom` /
  `startTo` as a Date or RFC 3339 string, `sort`) and `JobPage` (`jobs`,
  `totalCount`, `pageSize`, `pageNumber`, `totalPages`) for the paginated job
  list; `JOB_STATUSES`, `JOB_SORTS` and `MAX_PLUGIN_PARAMS`.
- `JobStatus.acquiredConcurrency` and `JobStatus.limitConcurrency`.

### Changed

- **Breaking:** `jobs.list(call?)` is now `jobs.list(options?, call?)` and
  resolves to a `JobPage`. The endpoint is paginated (10 jobs a page by
  default), so the old method silently returned only the first page while
  documenting "all jobs". Read `.jobs` for the list.
- `jobs.create` also refuses options that set `Plugin`.

## [0.1.0] - 2026-11-01

The first release of `@scrape-do/sdk`, the JavaScript/TypeScript SDK for the
Scrape.do API. ESM and CommonJS, with type declarations, for Node.js 22 or newer.

### Added

- **Client.** `new Client({ token })` or the `SDO_TOKEN` environment variable
  (trimmed; an empty value falls back to the environment; whitespace or control
  characters inside it are a `SdoConfigError`). `baseUrl` / `asyncBaseUrl` (or
  `SDO_BASE_URL` / `SDO_ASYNC_BASE_URL`) keep a path prefix and must be https,
  except for loopback hosts or with `allowInsecureHttp: true`. `timeoutMs` (or
  `SDO_TIMEOUT`, in seconds), `retries`, `backoffMs`, `acceptEncoding`,
  `preferBrotli`, `maxResponseBytes` and an injectable `fetchImpl`. Unknown
  option names are a `SdoConfigError` with a suggestion where one fits.
- **ScrapeConfig** covering the documented public scrape parameters, validated
  before any request: enums case-insensitive and sent lowercase, the documented
  millisecond ranges, render-only parameters that need `render`, an absolute
  http(s) target URL (a string grammar, sent exactly as given), and unknown
  option names. Unset values (`false`, `0`, `""`, `[]`, `{}`) are omitted.
  `extraParams` is the escape hatch for anything else (`token`, `url`, an empty
  key and a key that is not a parameter name — a letter, then letters, digits,
  `_`, `.` or `-` — are refused). `playWithBrowser` and JSON bodies use one
  canonical JSON encoding.
- **One wire encoding.** The query string is built by hand in a fixed order
  (token, url, typed parameters in spec order, `extraParams` sorted by code
  point), with RFC 3986 percent-encoding.
- **Request method, body and headers.** `client.scrape(url, { method, json,
  data, headers })` or `client.scrape(config, { ... })`. A body without a method
  is sent as POST. Header names are case-insensitive and a caller's value
  replaces the SDK's own; invalid names or values and `Host`, `Content-Length`,
  `Transfer-Encoding` or `Connection` are a `SdoConfigError` before sending.
- **Transport.** `node:http` / `node:https` by default. Redirects are never
  followed. The timeout is a total deadline per attempt (70 seconds by default:
  the gateway's 60-second default plus 10), raised to a gateway `timeout` plus
  10 seconds when the config sets one or a plugin call passes a positive
  integer `timeout` param. Only failures before the
  request was sent are retried, together with the retryable statuses (429 only
  for POST, PUT, PATCH and DELETE); `Retry-After` is honoured up to 30 seconds.
- **Cancellation.** An `AbortSignal` (`signal`) on `scrape()`, `plugin()` and
  every job call aborts the request or the wait before a retry, with
  `SdoAbortError`.
- **Decompression.** `gzip`, `x-gzip`, `deflate` (zlib or raw) and `br`, stacked
  codings undone in reverse order, decoded as a stream under the size ceiling
  (`maxResponseBytes`, default 32 MiB, on every body path). A truncated or corrupt
  body is a transport error and is not retried.
- **ScrapeResult** with `bytes()`, `text` and `json()`, the gateway's metadata
  headers (`cost`, `remainingCredits`, `initialStatusCode`, `targetUrl`,
  `resolvedUrl`, `cookies`, `targetRedirectedLocation` — the target's
  `Location` under `disableRedirection`),
  `headerValues(name)` for repeated headers, and `selector()` for CSS extraction
  with the optional peer dependency `cheerio`.
- **Text decoding** per the WHATWG Encoding Standard (BOM, charset label, JSON,
  the HTML `<meta>` prescan, UTF-8), with the SDK's own WHATWG decoders for
  EUC-KR, Big5 and Shift_JIS, loaded only when a response needs them. `json()`
  rejects NaN, Infinity and numbers that overflow a double.
- **Errors.** One taxonomy rooted at `SdoError`: `SdoConfigError`,
  `SdoTransportError` (`SdoConnectionError`, `SdoTimeoutError`,
  `SdoResponseTooLargeError`, `SdoAbortError`) and `SdoApiError`
  (`SdoAuthError`, `SdoValidationError`, `SdoConcurrencyError`,
  `SdoGatewayError`), with `billed`, `isRetryable`, `retryAfter` and a
  2048-character excerpt of the error body. Messages come from the gateway's
  error envelope (`message`, then `error`, each in any letter case, so a
  plugin's `{"error": ..., "message": ...}` reads too) or a fixed default.
  Target 404/410 pages, any status of 400 or above the gateway billed (a
  positive `Scrape.do-Request-Cost`, the authoritative figure) and a target's
  own answer under `transparentResponse` are results, never errors; without a
  positive cost a status keeps its gateway meaning (the gateway's own 400 is
  an `SdoValidationError`, its 401 an `SdoAuthError`), on the scrape and
  plugin paths alike. `billed` follows the cost header when present, else the
  documented table; `SdoApiError.cost` holds the header, read like
  `ScrapeResult.cost` (one value, ASCII digits, at most 2^53-1).
- **Plugins.** `client.plugin(route, params)` calls any documented plugin;
  routes and parameter names are validated and parameters sent sorted (objects
  as JSON). `client.pluginResult(route, params)` returns the same response as a
  `ScrapeResult`, so its `statusCode` and `cost` are not lost. The route
  `amazon` (or its documented spelling `amazon/`) calls the Amazon raw-HTML
  plugin at `/plugin/amazon/`, the path the gateway serves it under (it answers
  `/plugin/amazon` with a redirect the SDK never follows).
- **Usage statistics.** `client.usage()` reads `GET /info` on the sync base URL
  into a `Usage` (`isActive`, `concurrentRequest`, `maxMonthlyRequest`,
  `remainingConcurrentRequest`, `remainingMonthlyRequest`); a body without those
  fields is a `SdoTransportError`. The endpoint is rate-limited to 10 requests
  per minute, so its error statuses (429 included) are not retried.
- **Async jobs.** `client.jobs.create` / `status` / `result` / `list` / `cancel`
  / `me` on the REST job API at `https://q.scrape.do`, authenticated with the
  `X-Token` header. Typed results (`Job`, `JobStatus`, `Task`, `TaskResult`,
  `Account`) read absent or mistyped fields as `undefined`;
  `TaskResult.contentBytes()` decodes base64 content, validated in linear time
  whatever its size.

### Changed

- `scrape` refuses a rendered request (`render: true`) with any
  method other than GET with a `SdoConfigError`, before anything is sent. The
  gateway answers such a request with a 400 ("JavaScript Render feature just
  works with 'GET' method type").

- **Behavior change.** `blockResources: false` is now sent as
  `blockResources=false` (it was dropped as unset, so resource blocking could
  not be turned off: the gateway defaults to `true`). The option is tri-state:
  unset sends nothing, `true` needs `render`, and `false` does not.
- **Behavior change.** `Scrape.do-Request-Cost` decides origin and billing.
  Any response of status 400 or above with a positive cost is the target's
  answer the gateway billed (its 400, 401, 403, 422, ...) and is now a
  `ScrapeResult`, like a target 404/410, never retried. The gateway's own
  errors carry no cost (or 0) and keep their classes: its 400 is an
  `SdoValidationError`, its 401 an `SdoAuthError`, both with `billed: false` —
  a 400 is no longer always billed. `billed` follows the cost header when
  present, else the documented table. New `SdoApiError.cost`;
  `ScrapeResult.cost` now trims spaces and tabs and refuses values over
  2^53-1.
- **Behavior change.** More documented parameter rules are checked before any
  request (`SdoConfigError`), each one the gateway rejects with a 400 or
  documents as invalid: `showFrames`, `showWebsocketRequests` and the screenshot
  options require `returnJson`; at most one screenshot option;
  `particularScreenshot` excludes `playWithBrowser`; `regionalGeoCode` requires
  `superProxy` and excludes `geoCode`; `zipCode` requires `superProxy` and
  `geoCode`; `sessionId` must be an integer 0-1000000 (it now also accepts a
  number; `0` is sent); `retryTimeout` excludes `render`; at most one of
  `customHeaders`, `extraHeaders`, `forwardHeaders`; `width` and `height`
  require `render`. `returnJson` without `render` stays valid (the gateway wraps
  the plain response in JSON).
- **Behavior change.** A 510 is no longer retried and its default message is
  "The request was canceled by the HTTP client (HTTP 510)." The gateway answers
  510 only when the client cancelled the request before it finished; it is not
  an upstream failure.
- Option docs corrected: `pureCookies` returns the target's `Set-Cookie` header
  instead of `Scrape.do-Cookies` (the body is unchanged); `returnJson` returns
  network requests and content as JSON.
- **Behavior change.** The default client timeout is 70 seconds (was 60), so a
  request that sets no gateway `timeout` (60 seconds by default) is never
  abandoned just before its answer arrives. An explicit `timeoutMs` or
  `SDO_TIMEOUT` keeps its meaning.

### Security

- A target URL in a `SdoConfigError` has its `user:password@` masked and its
  credential-shaped query values redacted.
- The token only travels over https and is masked, literally and
  percent-encoded, together with credential-shaped values, in every error
  message, retained error body and wrapped cause. A client logged with
  `console.log`, `util.inspect` or `JSON.stringify` does not show it.
- Redirects are never followed, so neither the token nor `X-Token` can be
  carried to another origin.
- Every body, compressed or not, is read under the size ceiling.
- Job and task ids and plugin routes are validated before they enter a URL;
  `extraParams` keys and plugin parameter names must be parameter names, so a
  key cannot smuggle `&token=` or other query syntax onto the wire.
- Response headers a target controls (`Content-Type`, `Content-Encoding`,
  `Retry-After`) are trimmed with index loops, not backtracking regexes, so a
  long run of whitespace costs linear time.
- A body is decoded through at most five `Content-Encoding` codings (urllib3's
  limit); a longer chain is a `SdoTransportError`, never retried, so a target
  cannot make the SDK stack a decoder per listed coding. A decode error quotes
  at most 64 characters of the header.
- CI: every job runs on GitHub-hosted runners, so code from a pull request
  never reaches the org's persistent self-hosted runners (only CodeQL runs
  there, for same-repository events; a fork's pull request is analysed once
  merged); every checkout drops its token
  (`persist-credentials: false`); and gitleaks scans with a config and ignore
  list from the workflow, so a pull request cannot allowlist its own secret with
  a `.gitleaks.toml` or `.gitleaksignore`.
- The User-Agent is exactly `sdo-sdk-js/<version>`, the only client-identifying
  header. There is no telemetry.
