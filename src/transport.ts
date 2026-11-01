// SPDX-License-Identifier: Apache-2.0
// The one HTTP stack every request goes through: sync scrapes, plugins and the
// async job API alike. It owns the safeguards so no path can skip them:
//
//   - redirects are never followed (a 3xx must not carry the token elsewhere);
//   - the timeout is a total deadline per attempt over connect, headers and body;
//   - every body is read under a byte ceiling, and Content-Encoding is undone
//     by a bounded, streaming decoder, so a small compressed payload cannot
//     inflate without bound;
//   - error bodies are read through a smaller cap, and bodies that are not read
//     are released so the connection is freed;
//   - only a failure before the request was sent is retried (and only for an
//     idempotent method); after that the gateway may already be running, and
//     billing, the request;
//   - every failure surfaces as an SdoError with the token masked out of its
//     message, retained body and cause.
import { contentCodings, decodeBody, StageTooLarge, type ByteSource } from "./decompress.js";
import {
  asyncEnvelopeMessage,
  redactSecrets,
  sanitizeCause,
  SdoAbortError,
  SdoApiError,
  SdoAuthError,
  SdoConcurrencyError,
  SdoConnectionError,
  SdoGatewayError,
  SdoResponseTooLargeError,
  SdoTimeoutError,
  SdoTransportError,
  SdoValidationError,
  syncEnvelopeMessage,
} from "./errors.js";
import { mergeHeaders, parseRequestCost, trimChars, type HeaderMap } from "./headers.js";
import { fetchSender, nodeSend, SendFailure, type Exchange, type FetchLike, type Sender } from "./http.js";

export type { FetchLike } from "./http.js";

/** Default ceiling for a response body, raw and decompressed (32 MiB). */
export const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;
/** How much of an error body is read: enough for the envelope and a 2048-character excerpt. */
export const ERROR_BODY_READ_BYTES = 64 * 1024;
const RETAINED_BODY_CHARS = 2048;
/** How much of a Content-Encoding header a decode error quotes. */
const MAX_CODING_IN_MESSAGE = 64;
/** Upper bound for any wait between attempts, Retry-After included. */
export const MAX_BACKOFF_MS = 30_000;
/** A gateway `timeout` gets this much on top before the client gives up on an attempt. */
export const GATEWAY_TIMEOUT_MARGIN_MS = 10_000;
const MAX_TIMER_MS = 2_147_483_647;

// 510 is not transient: the gateway answers it only when the HTTP client
// cancelled the request before the gateway finished, so a retry would re-send
// a request its caller abandoned.
export const RETRYABLE_STATUSES: ReadonlySet<number> = new Set([429, 502, 503, 504, 520, 521, 522, 523, 524]);
/** The gateway's status for a request its HTTP client cancelled. */
const CLIENT_CANCELED_STATUS = 510;
// A request that can have side effects on the target is retried only when the
// gateway refused it before contacting the target (429).
const NON_IDEMPOTENT_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const NON_IDEMPOTENT_RETRY_STATUSES = new Set([429]);
// The documented billing table, used only for an error without a readable
// Scrape.do-Request-Cost (the header is authoritative): of the statuses that
// can be in an error position, only 404 and 410, which are results anyway.
// The gateway's own 400, 401, 429, 502 and 510 are not billed.
export const BILLED_STATUSES: ReadonlySet<number> = new Set([404, 410]);
const TARGET_ORIGIN_HEADER = "scrape.do-initial-status-code";
const REQUEST_COST_HEADER = "scrape.do-request-cost";

/**
 * Retry-After as whole seconds, or undefined. Only RFC 9110 delay-seconds is
 * honoured (ASCII digits after trimming spaces/tabs); a date, a sign, a
 * fraction or any other form falls back to the exponential backoff.
 */
export function parseRetryAfter(raw: string | null | undefined): number | undefined {
  if (raw === null || raw === undefined) return undefined;
  const trimmed = trimChars(raw, " \t");
  return /^[0-9]+$/.test(trimmed) ? Number(trimmed) : undefined;
}

/** The wait before the next attempt, in ms, when the response carried Retry-After (capped at 30 s). */
export function retryAfterDelayMs(seconds: number): number {
  return Math.min(seconds * 1000, MAX_BACKOFF_MS);
}

/**
 * The per-attempt deadline for a scrape: the client's timeout, raised to the
 * gateway `timeout` (ms) plus a margin when the config sets one, so the client
 * never abandons a request the gateway was told it may take longer for.
 */
export function effectiveTimeoutMs(clientTimeoutMs: number, gatewayTimeoutMs?: number): number {
  if (!gatewayTimeoutMs) return clientTimeoutMs;
  return Math.max(clientTimeoutMs, gatewayTimeoutMs + GATEWAY_TIMEOUT_MARGIN_MS);
}

function tooLarge(limit: number): SdoResponseTooLargeError {
  return new SdoResponseTooLargeError(
    `Response exceeded the ${limit}-byte limit; aborted before decompressing it fully. ` +
      `Raise maxResponseBytes if you expect payloads this large.`,
    limit,
  );
}

export interface ReadOptions {
  /** Aborts a read that stalls (the request's deadline or the caller's signal). */
  signal?: AbortSignal;
  /** Return the first `limit` bytes (and `truncated: true`) instead of throwing when the body is longer. */
  truncate?: boolean;
  /** Called on every early exit, so the connection is released. */
  release?: () => void;
}

export interface CappedBody {
  bytes: Uint8Array;
  /** The body continued past `limit` (only with `truncate`). */
  truncated: boolean;
}

/** Read a body, stopping as soon as it exceeds `limit` bytes. */
export async function readCapped(source: ByteSource, limit: number, opts: ReadOptions = {}): Promise<CappedBody> {
  const { signal, truncate = false, release } = opts;
  const it = source[Symbol.asyncIterator]();
  let onAbort: (() => void) | undefined;
  // Settles only on abort: raced against every read so a stalled body cannot
  // outlive the deadline, whatever the source does with the signal.
  const aborted = new Promise<never>((_, reject) => {
    if (!signal) return;
    onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
  });
  aborted.catch(() => undefined);
  const chunks: Uint8Array[] = [];
  let total = 0;
  let complete = false;
  let truncated = false;
  try {
    for (;;) {
      // Checked first: an already-queued chunk would otherwise win the race.
      signal?.throwIfAborted();
      const { done, value } = await Promise.race([aborted, it.next()]);
      if (done) {
        complete = true;
        break;
      }
      if (total + value.length > limit) {
        if (!truncate) throw tooLarge(limit);
        chunks.push(value.subarray(0, limit - total));
        total = limit;
        truncated = true;
        break;
      }
      total += value.length;
      chunks.push(value);
    }
  } finally {
    if (onAbort) signal?.removeEventListener("abort", onAbort);
    // Stop the transfer on every early exit so the connection is released.
    if (!complete) {
      release?.();
      it.return?.().catch(() => undefined);
    }
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    bytes.set(c, offset);
    offset += c.length;
  }
  return { bytes, truncated };
}

function truncateChars(text: string, max: number): string {
  // By code point, so a surrogate pair is never split.
  let count = 0;
  let end = 0;
  for (const ch of text) {
    if (count === max) return text.slice(0, end);
    count += 1;
    end += ch.length;
  }
  return text;
}

export interface TransportOptions {
  timeoutMs: number;
  acceptEncoding: string;
  retries: number;
  backoffMs: number;
  userAgent: string;
  maxResponseBytes: number;
  /** An injected fetch; without one, node:http / node:https and the SDK's own decoder are used. */
  fetchImpl?: FetchLike;
  /** The wait between attempts (a test seam); it must reject when `signal` aborts. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

export interface HttpRequest {
  method: string;
  url: string;
  /** The client's token, masked out of everything that becomes an error. */
  token: string;
  /** Which API answers: for the job API any non-2xx (a 3xx included) is an error, with its own envelope. */
  api: "sync" | "async";
  headers?: HeaderMap;
  body?: Uint8Array;
  /** The scrape asked for transparentResponse, so a target-origin response is a result. */
  transparent?: boolean;
  /** This call's per-attempt deadline in ms (default: the client's timeout). */
  timeoutMs?: number;
  /**
   * The gateway-side timeout this call asked for (a plugin's `timeout` param),
   * in ms. Without `timeoutMs`, the deadline is the client's timeout raised to
   * this plus the margin.
   */
  gatewayTimeoutMs?: number;
  /** The caller's AbortSignal. */
  signal?: AbortSignal;
  /**
   * Do not retry a retryable status (a failure before anything was sent still
   * is). For /info, whose 429 is a per-minute rate limit a quick retry only
   * extends.
   */
  noStatusRetry?: boolean;
}

export interface HttpResponse {
  status: number;
  headers: Headers;
  body: Uint8Array;
}

interface Retry {
  retryInMs?: number;
}

interface Attempt {
  /** The attempt's deadline and the caller's signal, combined. */
  signal: AbortSignal;
  deadline: AbortSignal;
  timeoutMs: number;
}

// Marks a failure of the connection itself while a body was read, as opposed
// to a failure of the decoder reading it.
class ReadFailure extends Error {
  constructor(readonly original: unknown) {
    super("read failed");
  }
}

async function* rawBody(ex: Exchange, limit: number): ByteSource {
  let total = 0;
  try {
    for await (const chunk of ex.body) {
      total += chunk.length;
      // The raw read is capped too: an incompressible body cannot grow past it.
      if (total > limit) throw tooLarge(limit);
      yield chunk;
    }
  } catch (e) {
    if (e instanceof SdoResponseTooLargeError) throw e;
    throw new ReadFailure(e);
  }
}

function isResult(ex: Exchange, req: HttpRequest): boolean {
  const s = ex.status;
  if (req.api === "async") return s >= 200 && s < 300;
  // With transparentResponse the gateway relays the target's own status; the
  // header marks the response as the target's answer, never a gateway error.
  if (req.transparent && ex.headers.has(TARGET_ORIGIN_HEADER)) return true;
  if (targetAnswered(ex.headers)) return true;
  return s < 400 || s === 404 || s === 410;
}

/**
 * Whether the gateway billed the response, which makes it the target's answer
 * whatever its status. The gateway charges the target statuses it counts as
 * delivered (400, 401, 404, 405 and more) and states the charge in
 * Scrape.do-Request-Cost; its own errors — a parameter it cannot parse
 * (render=mert), a refused token, a blocked URL — are written before any cost
 * is known and carry no cost header, and a failed fetch carries a cost of 0. A
 * billed response is a result, so it is never retried. Without a readable
 * positive cost the status keeps its gateway meaning, so a gateway message is
 * never passed off as the target's page.
 */
export function targetAnswered(headers: Headers): boolean {
  return (parseRequestCost(headers.get(REQUEST_COST_HEADER)) ?? 0) > 0;
}

/**
 * Map an error HTTP response to the SdoError taxonomy. `text` is the error body
 * as read (undefined when it could not be read); the envelope is parsed only
 * when `complete`, i.e. the whole body was read within the error-body cap.
 */
export function buildError(
  resp: { status: number; headers: Headers },
  text: string | undefined,
  complete: boolean,
  req: HttpRequest,
): SdoApiError {
  const status = resp.status;
  const source = complete ? text : undefined;
  const envelope = req.api === "sync" ? syncEnvelopeMessage(source) : asyncEnvelopeMessage(source);
  // The cost header is authoritative; the documented table is the fallback.
  const cost = req.api === "sync" ? parseRequestCost(resp.headers.get(REQUEST_COST_HEADER)) : undefined;
  const common = {
    statusCode: status,
    billed: req.api === "sync" && (cost === undefined ? BILLED_STATUSES.has(status) : cost > 0),
    cost,
    isRetryable: RETRYABLE_STATUSES.has(status),
    retryAfter: parseRetryAfter(resp.headers.get("retry-after")),
    body: text === undefined ? undefined : truncateChars(redactSecrets(text, req.token), RETAINED_BODY_CHARS),
  };
  const msg = (fallback: string): string => (envelope === undefined ? fallback : redactSecrets(envelope, req.token));
  if (status === 401 || status === 403) {
    // The gateway returns 401 for a depleted credit balance too, so the default
    // message names both causes.
    return new SdoAuthError(
      msg("Authentication failed — check your token, plan permissions, and remaining credits."),
      common,
    );
  }
  if (status === 429) {
    const credits = resp.headers.get("scrape.do-remaining-credits");
    return new SdoConcurrencyError(msg("Concurrent-request limit reached."), {
      ...common,
      remainingCredits: credits !== null && /^-?[0-9]+$/.test(credits) ? Number(credits) : undefined,
    });
  }
  if (status === 400) return new SdoValidationError(msg("The gateway rejected the request parameters."), common);
  if (status === CLIENT_CANCELED_STATUS) {
    // The gateway's record of a request the client hung up on: not an upstream failure.
    return new SdoGatewayError(msg(`The request was canceled by the HTTP client (HTTP ${status}).`), common);
  }
  if (status >= 500) return new SdoGatewayError(msg(`Gateway-origin upstream failure (HTTP ${status}).`), common);
  if (status >= 300 && status < 400) {
    return new SdoApiError(msg(`Unexpected redirect (HTTP ${status}); redirects are never followed.`), common);
  }
  return new SdoApiError(msg(`Request failed (HTTP ${status}).`), common);
}

/** Resolves after `ms`, or rejects with the signal's reason when it aborts first. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal!.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export class Transport {
  readonly #opts: TransportOptions;
  readonly #send: Sender;

  constructor(opts: TransportOptions) {
    this.#opts = opts;
    this.#send = opts.fetchImpl ? fetchSender(opts.fetchImpl) : nodeSend;
  }

  async send(req: HttpRequest): Promise<HttpResponse> {
    // A caller header replaces the SDK's own whatever its letter case.
    const headers = mergeHeaders(
      { "User-Agent": this.#opts.userAgent, "Accept-Encoding": this.#opts.acceptEncoding },
      req.headers,
    );
    const timeoutMs = req.timeoutMs ?? effectiveTimeoutMs(this.#opts.timeoutMs, req.gatewayTimeoutMs);
    for (let attempt = 0; ; attempt++) {
      if (req.signal?.aborted) throw aborted(req);
      const deadline = new AbortController();
      // setTimeout fires at once past 2^31-1 ms, so a huge timeout is capped.
      const timer = setTimeout(() => deadline.abort(), Math.min(timeoutMs, MAX_TIMER_MS));
      const signal = req.signal ? AbortSignal.any([deadline.signal, req.signal]) : deadline.signal;
      let outcome: HttpResponse | Retry;
      try {
        outcome = await this.#attempt(req, headers, { signal, deadline: deadline.signal, timeoutMs }, attempt);
      } finally {
        // Only now: the deadline covers the body read, not just the headers.
        clearTimeout(timer);
      }
      if ("body" in outcome) return outcome;
      try {
        await (this.#opts.sleep ?? sleep)(outcome.retryInMs ?? this.#backoff(attempt), req.signal);
      } catch {
        throw aborted(req);
      }
    }
  }

  async #attempt(req: HttpRequest, headers: HeaderMap, at: Attempt, attempt: number): Promise<HttpResponse | Retry> {
    const canRetry = attempt < this.#opts.retries;
    const idempotent = !NON_IDEMPOTENT_METHODS.has(req.method);
    let ex: Exchange;
    try {
      ex = await this.#send({ method: req.method, url: req.url, headers, body: req.body, signal: at.signal });
    } catch (e) {
      const failure = e instanceof SendFailure ? e : new SendFailure(true, e);
      const err = this.#failure(failure.original, req, at);
      // Retried only when the request provably never left: DNS, a refused or
      // timed-out connect, TLS. Anything later may already be running upstream.
      if (!failure.sent && idempotent && canRetry && !(err instanceof SdoAbortError)) return {};
      throw err;
    }

    if (isResult(ex, req)) {
      try {
        const { bytes } = await this.#read(ex, this.#opts.maxResponseBytes, at, false);
        return { status: ex.status, headers: ex.headers, body: bytes };
      } catch (e) {
        // Never retried: the response is here, so the request was delivered
        // (and a 2xx billed); asking again would run it again.
        throw this.#bodyFailure(e, ex, req, at);
      }
    }

    const status = ex.status;
    const retryable = RETRYABLE_STATUSES.has(status) && (idempotent || NON_IDEMPOTENT_RETRY_STATUSES.has(status));
    if (retryable && canRetry && req.noStatusRetry !== true) {
      ex.release();
      const seconds = parseRetryAfter(ex.headers.get("retry-after"));
      return { retryInMs: seconds === undefined ? undefined : retryAfterDelayMs(seconds) };
    }
    // The status is the answer: a body that is too large, cannot be decoded or
    // times out only loses the detail (the envelope needs the whole body).
    let text: string | undefined;
    let complete = false;
    try {
      const limit = Math.min(this.#opts.maxResponseBytes, ERROR_BODY_READ_BYTES);
      const { bytes, truncated } = await this.#read(ex, limit, at, true);
      // ignoreBOM keeps a BOM in the retained body; the envelope parser skips it.
      text = new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes);
      complete = !truncated;
    } catch {
      text = undefined;
    }
    throw buildError(ex, text, complete, req);
  }

  #read(ex: Exchange, limit: number, at: Attempt, truncate: boolean): Promise<CappedBody> {
    const max = this.#opts.maxResponseBytes;
    const raw = rawBody(ex, max);
    const body = ex.encoded ? decodeBody(raw, contentCodings(ex.headers.get("content-encoding")), max) : raw;
    return readCapped(body, limit, { signal: at.signal, truncate, release: () => ex.release() });
  }

  #failure(e: unknown, req: HttpRequest, at: Attempt): SdoTransportError {
    if (req.signal?.aborted) return aborted(req);
    const cause = sanitizeCause(e, req.token);
    if (at.deadline.aborted) {
      return new SdoTimeoutError(
        `Request timed out after ${at.timeoutMs} ms (the per-attempt timeout; set timeoutMs or SDO_TIMEOUT to change it).`,
        { cause },
      );
    }
    return new SdoConnectionError(redactSecrets(`Connection failed: ${cause.message}`, req.token), { cause });
  }

  #bodyFailure(e: unknown, ex: Exchange, req: HttpRequest, at: Attempt): SdoTransportError {
    if (e instanceof SdoResponseTooLargeError) return e;
    if (e instanceof StageTooLarge) return tooLarge(this.#opts.maxResponseBytes);
    if (req.signal?.aborted || at.deadline.aborted || e instanceof ReadFailure) {
      return this.#failure(e instanceof ReadFailure ? e.original : e, req, at);
    }
    // The target writes the header: it is redacted, then cut short.
    let coding = redactSecrets(ex.headers.get("content-encoding") ?? "", req.token);
    if (coding.length > MAX_CODING_IN_MESSAGE) coding = `${coding.slice(0, MAX_CODING_IN_MESSAGE)}…`;
    const cause = sanitizeCause(e, req.token);
    return new SdoTransportError(
      redactSecrets(`The response body could not be decoded (Content-Encoding: ${coding}): ${cause.message}`, req.token),
      { cause },
    );
  }

  #backoff(attempt: number): number {
    const base = this.#opts.backoffMs * 2 ** attempt;
    return Math.min(base + Math.random() * base * 0.2, MAX_BACKOFF_MS);
  }
}

function aborted(req: HttpRequest): SdoAbortError {
  return new SdoAbortError("The request was aborted by the caller's signal.", {
    cause: sanitizeCause(req.signal?.reason, req.token),
  });
}
