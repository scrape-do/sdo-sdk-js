<!-- SPDX-License-Identifier: Apache-2.0 -->
# sdo — JavaScript/TypeScript SDK for Scrape.do

The official JS/TS SDK for the [Scrape.do](https://scrape.do) web-scraping API.
Token-only auth, transparent compression, a typed result, and a generic plugin
core — no telemetry, no UI. ESM + CJS, Node.js 22+.

> Package: **`@scrape-do/sdk`**.

## Install

```bash
npm install @scrape-do/sdk
# optional CSS extraction via result.selector() (an optional peer dependency):
npm install cheerio
```

## Quickstart

```ts
import { Client, ScrapeConfig } from "@scrape-do/sdk";

// Token precedence: new Client({ token }) > SDO_TOKEN env var
const client = new Client({ token: "YOUR_TOKEN" });

const result = await client.scrape("https://example.com", { render: true, geoCode: "us" });
console.log(result.statusCode, result.cost);
console.log(result.text.slice(0, 200));

// reuse a config:
const cfg = new ScrapeConfig("https://example.com", { superProxy: true, output: "markdown" });
const md = (await client.scrape(cfg)).text;
```

## Authentication and configuration

The only thing you need is a Scrape.do token: `new Client({ token })` or the
`SDO_TOKEN` environment variable. Surrounding whitespace is trimmed (a secret
file ending in a newline works), and an empty token falls back to `SDO_TOKEN`;
whitespace or control characters inside it are a `SdoConfigError`. The sync
scrape path sends the token as the API query parameter; the async job API sends
it as the `X-Token` header. It is masked out of every error the SDK raises and
is not printed when a client is logged.

| Environment variable | Used when | Meaning |
| --- | --- | --- |
| `SDO_TOKEN` | no `token` is passed | API token |
| `SDO_BASE_URL` | no `baseUrl` is passed | sync API base (default `https://api.scrape.do`) |
| `SDO_ASYNC_BASE_URL` | no `asyncBaseUrl` is passed | async job API base (default `https://q.scrape.do`) |
| `SDO_TIMEOUT` | no `timeoutMs` is passed | client timeout in seconds (default 70): a decimal number such as `30` or `1.5`, at least `0.001` |

Base URLs must be `https://` because the token travels with every request.
Plain `http://` is accepted only for `localhost`, `127.0.0.1` and `::1`, or with
`allowInsecureHttp: true`. A path prefix is kept; a query, a fragment or
credentials in a base URL are a `SdoConfigError`.

Option names are checked: a misspelled or unknown option (`renderr`,
`geo_code`, `super`) is a `SdoConfigError` naming it, with a suggestion where one
fits, instead of a request sent without it. Parameters the SDK does not model go
through `extraParams`, whose keys (like plugin parameter names) must start with a
letter and contain only letters, digits, `_`, `.` or `-`.

## Timeouts, retries and cancellation

`timeoutMs` is a total deadline per attempt: connecting, the headers and the
whole body. Its default, 70 seconds, is the gateway's own default timeout (60
seconds) plus 10, so the gateway's answer always arrives first.
`ScrapeOptions.timeout` is a different value: the gateway's own timeout, in
milliseconds (5000-120000). When it is set (or a plugin call passes a positive
integer `timeout` param), one attempt waits at least that long plus 10 seconds,
so the client does not give up on a request the gateway may still complete.

A request is retried (default `retries: 2`, exponential backoff, `Retry-After`
honoured up to 30 seconds) when the gateway answers 429, 502, 503, 504 or
520-524, or when it never left the machine (DNS, a refused or timed-out
connection, TLS). A failure after the request was sent (a read timeout, a
connection dropped mid-response, a body that cannot be decoded, an oversized
body) is not retried: the gateway may already be running, and billing, it.
Requests with side effects (POST, PUT, PATCH, DELETE) are retried only on 429.
A 510 is the gateway's record of a request whose HTTP client cancelled it before
it finished; it is not an upstream failure and is not retried.

Pass an `AbortSignal` to stop a call, including the wait before a retry:

```ts
const controller = new AbortController();
setTimeout(() => controller.abort(), 5_000);
await client.scrape("https://example.com", { signal: controller.signal });
await client.jobs.status("job-id", { signal: controller.signal }); // plugin() and every jobs call too
```

An aborted call rejects with `SdoAbortError` (a `SdoTransportError`).

## Compression

Every request sends `Accept-Encoding: gzip, deflate, br` (`{ preferBrotli: true }`
advertises `br` alone) and the SDK decodes the response itself, as a stream under
the size ceiling: `Content-Encoding` is read as a comma list and undone in
reverse order; `gzip`, `x-gzip`, `deflate` (zlib or raw) and `br` are decoded and
`identity` is skipped; any other coding is left as it is. Data after the end of a
complete stream is ignored. A truncated or corrupt body is a `SdoTransportError`,
never a partial result, and is not retried.

## Sending a body and headers

The gateway relays the method, body and headers to the target:

```ts
await client.scrape("https://example.com/api", { method: "PUT", json: { name: "x" } });
await client.scrape("https://example.com/form", { data: "a=1&b=2", headers: { "Content-Type": "application/x-www-form-urlencoded" } });
```

A body without a `method` is sent as POST. `json` is sent as compact JSON with
`Content-Type: application/json` (unless you set one); `data` is sent as-is.

Header names are case-insensitive and yours replace the SDK's own:
`{ "user-agent": "..." }` is sent as the only User-Agent, not merged with the
SDK's. A name must be an RFC 9110 token and a value printable ASCII (no CR, LF,
NUL or non-ASCII); `Host`, `Content-Length`, `Transfer-Encoding` and `Connection`
cannot be set. Anything else is a `SdoConfigError` before the request is sent.
The SDK adds only `User-Agent`, `Accept-Encoding` and, with a body,
`Content-Type` (the HTTP layer adds `Host`, `Connection` and the body length).

## Text

`result.text` decodes the body with the WHATWG Encoding Standard: a byte-order
mark, then the `Content-Type` charset, then UTF-8 for JSON, then `<meta>` for
HTML (the HTML standard's prescan of the first 1024 bytes), then UTF-8. EUC-KR,
Big5 and Shift_JIS are decoded by the SDK's own WHATWG decoders; their tables
load only when a response needs them. `result.json()` parses the body as UTF-8
and rejects NaN, Infinity and numbers too large for a double.

`result.selector()` loads the text into [cheerio](https://cheerio.js.org/), an
optional peer dependency. Its type is yours to name, so the SDK's own types do
not need cheerio installed:

```ts
import type { CheerioAPI } from "cheerio";
const $ = await result.selector<CheerioAPI>();
console.log($("h1").first().text());
```

## Errors

Successful scrapes — including target 404/410 pages, any status the gateway
billed, and redirects — return a `ScrapeResult` (check `result.statusCode`).
`Scrape.do-Request-Cost` is the authoritative billing figure: a response of
status 400 or above with a positive cost is the target's own answer (its 400,
401, 403, 422, ...), returned as a result and never retried. Without one, the
status keeps its gateway meaning: the gateway's own 400 (a parameter it
rejected, such as `render=mert`) is a `SdoValidationError`, its 401 (a refused
token, no credits) a `SdoAuthError`. An error's `billed` follows the cost
header when present (0 is not billed) and the documented status table
otherwise; `error.cost` and `result.cost` hold the header. Plugin calls follow
the same rules, and a plugin's `{"error": ..., "message": ...}` envelope
supplies the message. Only gateway-origin failures throw,
from one taxonomy rooted at `SdoError`: `SdoConfigError` (invalid input, no
request made), `SdoTransportError` (`SdoConnectionError`, `SdoTimeoutError`,
`SdoResponseTooLargeError`, `SdoAbortError`, or a body that cannot be decoded or
is not valid JSON) and `SdoApiError` (`SdoAuthError`, `SdoValidationError`,
`SdoConcurrencyError`, `SdoGatewayError`).

With `transparentResponse: true`, a response carrying
`Scrape.do-Initial-Status-Code` is the target's own answer and is returned as a
result whatever its status, never raised or retried.

Every body is read under a size ceiling (`maxResponseBytes`, default 32 MiB).
An error body is read up to 64 KiB for its message; the HTTP status decides the
error even when that body is larger, compressed badly or slow.
Repeated response headers are available with `result.headerValues("set-cookie")`.
With `disableRedirection: true`, `result.targetRedirectedLocation` is the
target's `Location` (the `Scrape.do-Target-Redirected-Location` header).

## Parameter rules

Besides enums, millisecond ranges and render-only options (`width` and `height`
included), the documented parameter dependencies are checked before any
request, each one the gateway rejects (or documents as invalid), so a mistake
costs nothing:

| Rule | Why |
|---|---|
| `showFrames`, `showWebsocketRequests` and every screenshot option need `returnJson` (and `render`) | their output is part of the JSON response |
| at most one of `screenshot`, `fullScreenshot`, `particularScreenshot` | the gateway takes one |
| `particularScreenshot` cannot be combined with `playWithBrowser` | use a `ScreenShot` action instead |
| `regionalGeoCode` needs `superProxy` and excludes `geoCode` | the gateway rejects both |
| `zipCode` needs `superProxy` and `geoCode` | without super it is silently ignored |
| `sessionId` is an integer 0-1000000 (a number or decimal digits) | the documented range |
| `retryTimeout` cannot be combined with `render` | the gateway rejects it |
| at most one of `customHeaders`, `extraHeaders`, `forwardHeaders` | the gateway rejects any two |

`returnJson` on its own is allowed: without `render` the gateway wraps the plain
response in the same JSON envelope. A target URL in an error message has its
`user:password@` masked.

## Plugins

```ts
// Google plugins take Google's own locale params: gl (country), hl (language).
const data = await client.plugin("google/shopping", { q: "laptop", gl: "us" });

// pluginResult returns the same response with its status and headers.
const res = await client.pluginResult("google/search", { q: "laptop", gl: "us" });
console.log(res.statusCode, res.cost, res.json());

// The Amazon raw-HTML plugin lives at /plugin/amazon/; the route "amazon" (or "amazon/") calls it.
const html = await client.plugin("amazon", { url: "https://www.amazon.com/dp/B0C7BKZ883", geocode: "us", zipcode: "10001" });
```

Parameters are sent sorted by name; a list repeats the name, `false` is sent as
`false`, an object is sent as compact JSON and `null` is skipped. A nested list,
an empty name or `token` is a `SdoConfigError`.

## Usage statistics

```ts
const usage = await client.usage(); // GET https://api.scrape.do/info; no credits
console.log(usage.isActive, usage.remainingMonthlyRequest, usage.remainingConcurrentRequest);
```

`usage()` returns `isActive`, `concurrentRequest`, `maxMonthlyRequest`,
`remainingConcurrentRequest` and `remainingMonthlyRequest`. The endpoint allows
10 requests per minute per IP and answers 429 above that; the SDK does not retry
its error statuses (a quick retry only spends more of the same minute). An
unknown token is answered with a 502 "authentication refused".

## Async jobs

Batch, long-running work goes through the REST job API at `https://q.scrape.do`,
reached via `client.jobs`. Auth is your token sent as the `X-Token` header (never
a query parameter), and every call goes through the same transport, timeout and
retry rule as a scrape.

```ts
// Submit a batch. `options` are merged verbatim into the job body using the
// API's own PascalCase keys (Super, GeoCode, Render, Output, …).
const job = await client.jobs.create(["https://example.com", "https://example.org"], {
  Super: true,
  GeoCode: "us",
});

const status = await client.jobs.status(job.jobId!); // { status, tasks: [...], ... }
const taskId = status.tasks[0]?.taskId;
if (taskId !== undefined) {
  const result = await client.jobs.result(job.jobId!, taskId); // per-task payload
  const bytes = result.contentBytes(); // base64-decoded when result.base64EncodedContent
}

// A plugin job: one task per params entry (at most 1000), with the plugin's own
// parameter names. Targets and a plugin cannot be combined in one job.
const pluginJob = await client.jobs.createPlugin("amazon/pdp", [
  { asin: "B0C7BKZ883", geocode: "us" },
  { asin: "B0BSHF7WHW", geocode: "us" },
]);

// The job list is paginated (default: the 10 most recent). Filter by status and
// start time, sort, and walk `page` up to `totalPages`.
const page = await client.jobs.list({
  status: "success",
  startFrom: new Date("2025-01-01T00:00:00Z"), // or an RFC 3339 string
  sort: "start_time_asc",
  page: 2,
  pageSize: 25, // 1-100
}); // { jobs: JobStatus[], totalCount, pageSize, pageNumber, totalPages }
const account = await client.jobs.me(); // { totalConcurrency, freeConcurrency, activeJobs, availableCredits }
await client.jobs.cancel(job.jobId!);
```

Every method returns a typed object (`Job`, `JobStatus`, `JobPage`, `Task`,
`TaskResult`, `Account`). An invalid plugin key, an empty or oversized `params`
list, options that set `Targets` or `Plugin`, and `list` options outside the
documented values throw `SdoConfigError` before anything is sent. The async API
has its own concurrency pool (30% of the plan's limit, not taken from the main
API's); `JobStatus.acquiredConcurrency` and `limitConcurrency` report a job's
share of it. A field the API leaves out, or sends with an unexpected type, reads
as `undefined` (lists as `[]`, flags as `false`); a response that is not a JSON
object is a `SdoTransportError`, and so is `contentBytes()` on content flagged
as base64 that is not valid base64 (line breaks inside it are ignored). `cancel()` succeeds on any 2xx. Any non-2xx
answer (a redirect included; redirects are never followed) throws the same
`SdoError` taxonomy as the sync scrape path; async errors are never `billed`.
Job and task ids are validated before they are put in the URL.

## Custom fetch

By default the SDK sends requests with Node's `node:http` / `node:https`. For
tests or runtimes without them, pass `fetchImpl` (a function with the signature
of `fetch`). Redirects are still never followed, but that path differs:

- `fetch` decodes `Content-Encoding` itself, so its rules apply instead of the
  SDK's (for example, Node's `fetch` may return a truncated compressed body as a
  shorter successful one). The size ceiling still applies to what it returns.
- `fetch` adds `accept: */*`, `accept-language: *` and `sec-fetch-mode: cors` to
  every request, and a caller cannot remove `sec-fetch-mode`.
- A rejected `fetch` is retried only when its error code shows no connection was
  made (`ECONNREFUSED`, `ENOTFOUND`, `EAI_AGAIN`, `EHOSTUNREACH`, `ENETUNREACH`,
  `EADDRNOTAVAIL`, a connect timeout).
- Node's `fetch` turns a 407 answer into a network error and resends a request
  answered with 421 on its own; the default transport returns both as they are.

## CI/CD workflows

| Workflow | Runs on | What it does |
|----------|---------|--------------|
| `ci.yml` | every push to `main` and every pull request | type check, the test suite with 99% coverage floors on Node 22 and 24 (Linux), plus macOS and Windows on Node 24, including the cross-language conformance suite and its integrity check; the build and `check:dist` (no bundled dependencies, ESM/CJS and TypeScript consumers load it); the public-API snapshot (`api-surface.txt`) must be up to date; CodeQL code scanning. Everything runs on GitHub-hosted runners; CodeQL runs on the org's self-hosted runners for same-repository events (its upload is a GitHub API call the org's IP allow list only accepts from there); a pull request from a fork is analysed once merged. |
| `security.yml` | push to `main`, pull requests, and weekly | secret scanning over the full git history (gitleaks), OSV-Scanner over the lockfile, `npm audit`, and an SBOM uploaded as a build artifact. OpenSSF Scorecard runs on pushes to `main` and weekly, with results in code scanning. |
| `publish.yml` | a version tag only | A tag `vX.Y.Z-rc.N` publishes to npm under the `next` dist-tag; `vX.Y.Z` publishes under `latest`. The tag must be on `main` and match both `package.json` and `src/version.ts`. The build job re-runs the checks; the publish job uses npm trusted publishing with provenance (no stored token) after approval in the `prerelease` or `release` environment, and skips a version that is already on npm. |
| Dependabot | weekly | update pull requests for npm dependencies and the GitHub Actions, taken only after a 7-day cooldown; each one runs the checks above. |

Every action is pinned to a full commit SHA and every job declares least-privilege `permissions:`. Publishing never happens outside the `scrape-do` organisation, never from a commit that is not on `main`, and never without a maintainer's approval.

## Responsible use

You are responsible for complying with the terms of service, `robots.txt`, and
applicable laws of any site you scrape. Third-party names are trademarks of their
respective owners; Scrape.do is not affiliated with them.

## License

[Apache-2.0](LICENSE).
