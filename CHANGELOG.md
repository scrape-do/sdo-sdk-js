<!-- SPDX-License-Identifier: Apache-2.0 -->
# Changelog

Format: [Keep a Changelog](https://keepachangelog.com/) · [SemVer](https://semver.org/).

Before 1.0, a minor version may contain breaking changes; each is marked
**Breaking** and described in MIGRATING.md. Patch versions never break.

## [Unreleased]

The first release of `@scrape-do/sdk`, the official JavaScript/TypeScript SDK
for the Scrape.do API. ESM and CommonJS, with type declarations, for Node.js
22.23.4, 24.22.1 or 26.12.1 or newer.

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
  millisecond ranges, render-only parameters (`width` and `height` included)
  that need `render`, an absolute http(s) target URL (a string grammar, sent
  exactly as given), and unknown option names. Unset values (`false`, `0`, `""`,
  `[]`, `{}`) are omitted, except that `blockResources` is tri-state: unset
  sends nothing, `true` needs `render`, and `false` is sent as
  `blockResources=false` (the gateway defaults to `true`).
  `extraParams` is the escape hatch for anything else (`token`, `url`, an empty
  key and a key that is not a parameter name — a letter, then letters, digits,
  `_`, `.` or `-` — are refused). `playWithBrowser` and JSON bodies use one
  canonical JSON encoding.
- **Parameter rules.** The documented parameter dependencies the gateway
  rejects with a 400, or documents as invalid, are a `SdoConfigError` before any
  request: `showFrames`, `showWebsocketRequests` and the screenshot options
  require `returnJson`; at most one screenshot option; `particularScreenshot`
  excludes `playWithBrowser`; `regionalGeoCode` requires `superProxy` and
  excludes `geoCode`; `zipCode` requires `superProxy` and `geoCode`;
  `sessionId` is an integer 0-1000000 (a number or decimal digits; `0` is
  sent); `retryTimeout` excludes `render`; at most one of `customHeaders`,
  `extraHeaders`, `forwardHeaders`. `returnJson` without `render` is valid (the
  gateway wraps the plain response in JSON).
- **One wire encoding.** The query string is built by hand in a fixed order
  (token, url, the typed parameters in the order every sdo SDK uses,
  `extraParams` sorted by code point), with RFC 3986 percent-encoding.
- **Request method, body and headers.** `client.scrape(url, { method, json,
  data, headers })` or `client.scrape(config, { ... })`. A body without a method
  is sent as POST. Header names are case-insensitive and a caller's value
  replaces the SDK's own; invalid names or values and `Host`, `Content-Length`,
  `Transfer-Encoding` or `Connection` are a `SdoConfigError` before sending. A
  rendered request (`render: true`) with any method other than GET is a
  `SdoConfigError` too: the gateway answers it with a 400 ("JavaScript Render
  feature just works with 'GET' method type").
- **Transport.** `node:http` / `node:https` by default. Redirects are never
  followed. The timeout is a total deadline per attempt (70 seconds by default:
  the gateway's 60-second default plus 10), raised to a gateway `timeout` plus
  10 seconds when the config sets one or a plugin call passes a positive
  integer `timeout` param. Only failures before the
  request was sent are retried, together with the retryable statuses (429 only
  for POST, PUT, PATCH and DELETE); `Retry-After` is honoured up to 30 seconds.
  A 510, the gateway's record of a request its HTTP client cancelled before it
  finished, is not an upstream failure and is not retried.
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
  own answer under `transparentResponse` are results, never errors or retried;
  without a positive cost a status keeps its gateway meaning (the gateway's own
  400 is an `SdoValidationError`, its 401 an `SdoAuthError`), on the scrape and
  plugin paths alike. `billed` follows the cost header when present, else the
  documented table; `SdoApiError.cost` holds the header, read like
  `ScrapeResult.cost` (one value, trimmed of spaces and tabs, ASCII digits, at
  most 2^53-1).
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
- **Async jobs.** `client.jobs.create` / `createPlugin` / `status` / `result` /
  `list` / `cancel` / `me` on the REST job API at `https://q.scrape.do`,
  authenticated with the `X-Token` header. `createPlugin(key, params, options?,
  call?)` submits a plugin job (`{"Plugin": {"Key": ..., "Params": [...]}}`),
  one task per params entry, 1 to 1000 entries; a malformed key, an empty or
  oversized list, or options that set `Targets` or `Plugin` (on `create` too)
  throw `SdoConfigError`. `list(options?, call?)` reads one page of the
  paginated job list (`ListJobsOptions`: `page`, `pageSize` 1-100, `status`,
  `startFrom` / `startTo` as a Date or RFC 3339 string, `sort`) into a
  `JobPage` (`jobs`, `totalCount`, `pageSize`, `pageNumber`, `totalPages`);
  `JOB_STATUSES`, `JOB_SORTS` and `MAX_PLUGIN_PARAMS` export the accepted
  values. Typed results (`Job`, `JobStatus` with `acquiredConcurrency` and
  `limitConcurrency`, `JobPage`, `Task`, `TaskResult`, `Account`) read absent
  or mistyped fields as `undefined`; `TaskResult.contentBytes()` decodes base64
  content, validated in linear time whatever its size.

### Security

- Requires Node.js 22.23.4, 24.22.1 or 26.12.1 or newer: earlier releases have
  an out-of-bounds write in the bundled Brotli decoder (CVE-2026-111497),
  reachable from a target's `Content-Encoding: br` response.
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
- CI: code from a fork's pull request never reaches the organisation's
  persistent self-hosted runners: every job runs on GitHub-hosted runners
  except CodeQL (same-repository events only; a fork's pull request is
  analysed once merged) and Scorecard (never on a pull request); every
  checkout drops its token
  (`persist-credentials: false`); and gitleaks scans with a config and ignore
  list from the workflow, so a pull request cannot allowlist its own secret with
  a `.gitleaks.toml` or `.gitleaksignore`.
- The User-Agent is exactly `sdo-sdk-js/<version>`, the only client-identifying
  header. There is no telemetry.

[Unreleased]: https://github.com/scrape-do/sdo-sdk-js/commits/main
