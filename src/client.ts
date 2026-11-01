// SPDX-License-Identifier: Apache-2.0
import { ScrapeConfig, type ScrapeOptions } from "./config.js";
import { prepareDecoding } from "./decoding.js";
import { SdoConfigError } from "./errors.js";
import { checkHeaders } from "./headers.js";
import { callSignal, JobsClient, type AsyncJobs, type CallOptions } from "./jobs.js";
import { plainObject, rejectUnknownKeys } from "./options.js";
import { callPlugin, pluginResponse } from "./plugins.js";
import { buildQuery } from "./query.js";
import { checkSignal, prepareRequest, REQUEST_OPTION_KEYS, type RequestOptions } from "./request.js";
import { ScrapeResult } from "./response.js";
import {
  effectiveTimeoutMs,
  GATEWAY_TIMEOUT_MARGIN_MS,
  MAX_RESPONSE_BYTES,
  Transport,
  type FetchLike,
} from "./transport.js";
import { normalizeBaseUrl } from "./urls.js";
import { parseUsage, type Usage } from "./usage.js";
import { VERSION } from "./version.js";

const DEFAULT_BASE_URL = "https://api.scrape.do";
const DEFAULT_ASYNC_BASE_URL = "https://q.scrape.do";
// The gateway's default `timeout` (60 s) plus the margin, so the gateway's
// answer to a request that sets no timeout always arrives first.
const DEFAULT_TIMEOUT_MS = 60_000 + GATEWAY_TIMEOUT_MARGIN_MS;
const DEFAULT_ACCEPT_ENCODING = "gzip, deflate, br";
// A plain decimal number of seconds: no sign, exponent, hex, underscore or space.
const SECONDS = /^[0-9]+(?:\.[0-9]+)?$/;
const MIN_TIMEOUT_SECONDS = 0.001;
// What is left of a token after trimming: visible ASCII only.
const TOKEN_CHARS = /^[\x21-\x7e]+$/;

export interface ClientOptions {
  /**
   * API token. Surrounding whitespace is trimmed; if omitted or empty, SDO_TOKEN
   * is read from the environment.
   */
  token?: string;
  /** Sync API base (default https://api.scrape.do, or SDO_BASE_URL). A path prefix is kept. */
  baseUrl?: string;
  /** Async job API base (default https://q.scrape.do, or SDO_ASYNC_BASE_URL). */
  asyncBaseUrl?: string;
  /**
   * Allow a plain-http base URL for a host other than localhost/127.0.0.1/::1.
   * The token is then sent in cleartext; only for a trusted local gateway.
   */
  allowInsecureHttp?: boolean;
  /**
   * Total timeout per attempt in ms, body included (default 70000: the gateway's
   * 60 s default plus 10 s; env SDO_TIMEOUT in seconds). A scrape whose gateway
   * `timeout` (or a plugin call whose `timeout` param) is longer waits for that
   * plus 10 s.
   */
  timeoutMs?: number;
  /** Retries for failures before the request was sent and for retryable statuses (default 2; negative counts as 0). */
  retries?: number;
  /** Base of the exponential backoff between retries, in ms (default 500). */
  backoffMs?: number;
  acceptEncoding?: string;
  /** Advertise `br` alone so the gateway actually returns brotli. */
  preferBrotli?: boolean;
  /**
   * Ceiling for a response body, raw and decompressed (default 32 MiB).
   * Exceeding it throws `SdoResponseTooLargeError` instead of inflating the
   * whole payload.
   */
  maxResponseBytes?: number;
  /**
   * An injected fetch, for tests or runtimes without node:http. Redirects are
   * never followed regardless. Fetch decodes Content-Encoding itself (so its
   * rules apply, not the SDK's) and adds headers of its own; see the README.
   */
  fetchImpl?: FetchLike;
}

const CLIENT_OPTION_KEYS: readonly string[] = [
  "token",
  "baseUrl",
  "asyncBaseUrl",
  "allowInsecureHttp",
  "timeoutMs",
  "retries",
  "backoffMs",
  "acceptEncoding",
  "preferBrotli",
  "maxResponseBytes",
  "fetchImpl",
];

/**
 * The only client-identifying header, and deliberately the whole of it.
 * No OS and no runtime version: the spec fixes the User-Agent at
 * `sdo-sdk-<lang>/<version>`, and anything appended is extra client
 * fingerprinting the no-telemetry lock forbids.
 */
function userAgent(): string {
  return `sdo-sdk-js/${VERSION}`;
}

/** An environment variable, with "" meaning unset. */
function env(name: string): string | undefined {
  const value = process.env[name];
  return value === undefined || value === "" ? undefined : value;
}

/**
 * value without leading and trailing ASCII whitespace (tab, LF, VT, FF, CR,
 * space). A scan rather than a regex: an anchored /[\t...]+$/ backtracks
 * quadratically over a long run of whitespace that does not end the string.
 */
function trimAsciiWhitespace(value: string): string {
  const isSpace = (c: number) => c === 0x20 || (c >= 0x09 && c <= 0x0d);
  let start = 0;
  let end = value.length;
  while (start < end && isSpace(value.charCodeAt(start))) start++;
  while (end > start && isSpace(value.charCodeAt(end - 1))) end--;
  return value.slice(start, end);
}

/**
 * The token, trimmed of ASCII whitespace; undefined when that leaves nothing
 * ("not given"). Anything but visible ASCII left inside is a config error that
 * names where the token came from (a secret file often ends in a newline).
 */
function cleanToken(value: unknown, source: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new SdoConfigError(`The token (${source}) must be a string.`);
  const token = trimAsciiWhitespace(value);
  if (token === "") return undefined;
  if (!TOKEN_CHARS.test(token)) {
    throw new SdoConfigError(
      `The token (${source}) contains whitespace, control or non-ASCII characters; check the value.`,
    );
  }
  return token;
}

function resolveTimeoutMs(explicit: number | undefined): number {
  if (explicit !== undefined) {
    if (typeof explicit !== "number" || !Number.isFinite(explicit) || explicit <= 0) {
      throw new SdoConfigError(`timeoutMs must be a positive number of milliseconds, got ${String(explicit)}.`);
    }
    return explicit;
  }
  const raw = env("SDO_TIMEOUT");
  if (raw === undefined) return DEFAULT_TIMEOUT_MS;
  const seconds = SECONDS.test(raw) ? Number(raw) : NaN;
  if (!(seconds >= MIN_TIMEOUT_SECONDS)) {
    throw new SdoConfigError(
      `SDO_TIMEOUT must be a decimal number of seconds of at least ${MIN_TIMEOUT_SECONDS} ` +
        `(such as 30 or 1.5), got ${JSON.stringify(raw)}.`,
    );
  }
  return seconds * 1000;
}

function finiteNumber(name: string, value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new SdoConfigError(`${name} must be a finite number, got ${String(value)}.`);
  }
  return value;
}

export class Client {
  // An ES private field: unlike a TypeScript `private`, it is not a property,
  // so console.log(client), util.inspect and JSON.stringify cannot print it.
  readonly #token: string;
  readonly #transport: Transport;
  #jobs?: AsyncJobs;
  readonly baseUrl: string;
  readonly asyncBaseUrl: string;
  /** The total per-attempt request timeout, in milliseconds. */
  readonly timeoutMs: number;

  constructor(options: ClientOptions | string = {}) {
    const opts: ClientOptions =
      typeof options === "string" ? { token: options } : (plainObject(options ?? {}, "Client options") as ClientOptions);
    rejectUnknownKeys(opts as Record<string, unknown>, CLIENT_OPTION_KEYS, "Client option(s)");

    // An empty token means "not given", so a blank config value falls back to the env.
    const token = cleanToken(opts.token, "the token option") ?? cleanToken(env("SDO_TOKEN"), "SDO_TOKEN");
    if (token === undefined) {
      throw new SdoConfigError("No token provided. Pass new Client({ token }) or set SDO_TOKEN.");
    }
    this.#token = token;

    const insecure = opts.allowInsecureHttp === true;
    this.baseUrl = normalizeBaseUrl(opts.baseUrl || env("SDO_BASE_URL") || DEFAULT_BASE_URL, "baseUrl", insecure);
    this.asyncBaseUrl = normalizeBaseUrl(
      opts.asyncBaseUrl || env("SDO_ASYNC_BASE_URL") || DEFAULT_ASYNC_BASE_URL,
      "asyncBaseUrl",
      insecure,
    );
    this.timeoutMs = resolveTimeoutMs(opts.timeoutMs);

    const maxResponseBytes = finiteNumber("maxResponseBytes", opts.maxResponseBytes, MAX_RESPONSE_BYTES);
    if (maxResponseBytes <= 0) throw new SdoConfigError("maxResponseBytes must be positive.");
    const acceptEncoding = opts.preferBrotli ? "br" : (opts.acceptEncoding ?? DEFAULT_ACCEPT_ENCODING);
    checkHeaders({ "Accept-Encoding": acceptEncoding }, "acceptEncoding");
    if (opts.fetchImpl !== undefined && typeof opts.fetchImpl !== "function") {
      throw new SdoConfigError("fetchImpl must be a function with the signature of fetch.");
    }

    this.#transport = new Transport({
      timeoutMs: this.timeoutMs,
      acceptEncoding,
      // A negative count would skip the request loop; clamp to zero, as the
      // Python and Go SDKs do.
      retries: Math.max(0, Math.floor(finiteNumber("retries", opts.retries, 2))),
      backoffMs: Math.max(0, finiteNumber("backoffMs", opts.backoffMs, 500)),
      userAgent: userAgent(),
      maxResponseBytes,
      fetchImpl: opts.fetchImpl,
    });
  }

  /**
   * Scrape a URL through the gateway.
   *
   * The second argument carries the scrape parameters and, optionally, the
   * request to send to the target: `method`, `json` or `data`, and `headers`,
   * plus a `signal` to abort the call. A body without an explicit method is
   * sent as POST. Unknown option names are a `SdoConfigError`.
   */
  scrape(config: ScrapeConfig, request?: RequestOptions): Promise<ScrapeResult>;
  scrape(url: string, options?: ScrapeOptions & RequestOptions): Promise<ScrapeResult>;
  async scrape(
    target: string | ScrapeConfig,
    options: (ScrapeOptions & RequestOptions) | RequestOptions = {},
  ): Promise<ScrapeResult> {
    const opts = plainObject(options ?? {}, "scrape() options");
    let config: ScrapeConfig;
    let request: RequestOptions;
    if (target instanceof ScrapeConfig) {
      rejectUnknownKeys(
        opts,
        REQUEST_OPTION_KEYS,
        "request option(s) next to a ScrapeConfig",
        [],
        " Scrape parameters belong in the ScrapeConfig.",
      );
      config = target;
      request = opts as RequestOptions;
    } else {
      const { method, json, data, signal, ...scrapeOptions } = opts as ScrapeOptions & RequestOptions;
      config = new ScrapeConfig(target, scrapeOptions);
      request = { method, json, data, signal };
    }
    const signal = checkSignal(request.signal);
    const prepared = prepareRequest(request, config.options.headers);
    const params = config.toParams();
    // The gateway renders GET requests only and answers any other method with a 400.
    const render = params.find(([key]) => key === "render")?.[1];
    if (render !== undefined && render !== "false" && prepared.method !== "GET") {
      throw new SdoConfigError(`render works with GET requests only; got ${prepared.method}.`);
    }
    const query = buildQuery([["token", this.#token], ...params]);
    const resp = await this.#transport.send({
      method: prepared.method,
      url: `${this.baseUrl}/?${query}`,
      token: this.#token,
      api: "sync",
      headers: prepared.headers,
      body: prepared.body,
      transparent: config.options.transparentResponse === true,
      // The client waits at least as long as the gateway was told it may take.
      timeoutMs: effectiveTimeoutMs(this.timeoutMs, config.options.timeout),
      signal,
    });
    await prepareDecoding(resp.body, resp.headers.get("content-type") ?? undefined);
    return new ScrapeResult({ content: resp.body, statusCode: resp.status, headers: resp.headers, url: config.url });
  }

  /**
   * Call a documented plugin endpoint generically; returns parsed JSON or bytes.
   * `route` is the path under /plugin/, e.g. "google/shopping"; "amazon" (or
   * "amazon/") is the Amazon raw-HTML plugin at /plugin/amazon/. `pluginResult`
   * returns the same response with its status and headers.
   */
  async plugin(route: string, params: Record<string, unknown> = {}, call?: CallOptions): Promise<unknown> {
    return callPlugin(this.#transport, this.baseUrl, this.#token, route, params, callSignal(call));
  }

  /**
   * Call a plugin like `plugin`, but return the delivered response as a
   * ScrapeResult: its status, headers (`cost`, `remainingCredits`)
   * and body (`json()` parses it). `url` is "".
   */
  async pluginResult(route: string, params: Record<string, unknown> = {}, call?: CallOptions): Promise<ScrapeResult> {
    const resp = await pluginResponse(this.#transport, this.baseUrl, this.#token, route, params, callSignal(call));
    await prepareDecoding(resp.body, resp.headers.get("content-type") ?? undefined);
    return new ScrapeResult({ content: resp.body, statusCode: resp.status, headers: resp.headers, url: "" });
  }

  /**
   * The account's usage statistics (GET <baseUrl>/info, the token as a query
   * parameter); costs no credits. The endpoint allows 10 requests per minute
   * per IP and answers 429 above that, so an error status is not retried (a
   * quick retry only spends more of the same minute). An unknown token is
   * answered with a 502 "authentication refused".
   */
  async usage(call?: CallOptions): Promise<Usage> {
    const resp = await this.#transport.send({
      method: "GET",
      url: `${this.baseUrl}/info?${buildQuery([["token", this.#token]])}`,
      token: this.#token,
      api: "sync",
      signal: callSignal(call),
      noStatusRetry: true,
    });
    return parseUsage(resp.body, this.#token);
  }

  /** The async job API (q.scrape.do), authenticated with the same token. */
  get jobs(): AsyncJobs {
    this.#jobs ??= new JobsClient(this.#token, this.asyncBaseUrl, this.#transport);
    return this.#jobs;
  }
}
