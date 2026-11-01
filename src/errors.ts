// SPDX-License-Identifier: Apache-2.0
// The single, normative error taxonomy (mirrors the Python SDK). Every failure
// the SDK raises is one of these, so `catch (e) { if (e instanceof SdoError) }`
// sees network failures, oversized or undecodable bodies and HTTP errors alike.
//
//   SdoError                     base — catch-all
//   ├── SdoConfigError           client-side misconfiguration (no HTTP call)
//   ├── SdoTransportError        no usable HTTP response (also: a body that cannot be
//   │   │                        decompressed, or that is not valid JSON)
//   │   ├── SdoConnectionError
//   │   ├── SdoTimeoutError
//   │   ├── SdoResponseTooLargeError
//   │   └── SdoAbortError        the caller's AbortSignal fired
//   └── SdoApiError              the gateway returned an error status
//       ├── SdoAuthError         401/403 (also: credit exhausted)
//       ├── SdoValidationError   400
//       ├── SdoConcurrencyError  429 (remainingCredits)
//       └── SdoGatewayError      5xx
import { pctEncode } from "./query.js";

const MASK = "***";
// A short token would shred ordinary text ("ab" occurs in "tab"), so literal
// matching only applies from this length up.
const LITERAL_MIN_LENGTH = 8;
// Credential-shaped values from any source, applied in this order. `\b` is an
// ASCII word boundary (no `u` flag), so "mytoken=" is not a credential, and
// whitespace is ASCII only ([ \t\n\r\f\v], as the spec's reference): JavaScript's
// `\s` would also stop at U+00A0 or U+3000.
const SHAPES: ReadonlyArray<readonly [RegExp, string]> = [
  [/\b((?:token|api[-_]?key|access[-_]?token)=)[^&\t\n\v\f\r "']+/gi, `$1${MASK}`],
  [/("(?:token|api[-_]?key|access[-_]?token)"[\t\n\v\f\r ]*:[\t\n\v\f\r ]*")[^"]*(")/gi, `$1${MASK}$2`],
  [/\b(x-token[\t\n\v\f\r ]*:[\t\n\v\f\r ]*)[^\t\n\v\f\r ,;]+/gi, `$1${MASK}`],
];

/**
 * Mask credentials in text that is about to become part of an error.
 *
 * The client's own `token` (when at least 8 characters) is replaced literally
 * and in its percent-encoded form, wherever it appears. Credential-shaped values
 * are masked whatever their source: `token=…` / `api_key=…` / `access-token=…`,
 * a JSON `"token": "…"` field, and an `X-Token: …` header line.
 */
export function redactSecrets(text: string, token?: string): string {
  let out = text;
  if (token !== undefined && token.length >= LITERAL_MIN_LENGTH) {
    for (const form of literalForms(token)) out = out.split(form).join(MASK);
  }
  for (const [pattern, replacement] of SHAPES) out = out.replace(pattern, replacement);
  return out;
}

function literalForms(token: string): string[] {
  const forms = new Set([token, pctEncode(token)]);
  try {
    // encodeURIComponent keeps !'()* literal, so an echo built with it differs.
    forms.add(encodeURIComponent(token));
  } catch {
    // A lone surrogate cannot be URI-encoded; the other forms still apply.
  }
  return [...forms];
}

/**
 * A detached copy of an underlying error whose message and stack cannot carry
 * the token. The original object is not kept: fetch errors hang request details
 * off nested properties that a logger would happily print.
 */
export function sanitizeCause(cause: unknown, token?: string, depth = 0): Error {
  if (!(cause instanceof Error)) return new Error(redactSecrets(String(cause), token));
  const copy = new Error(redactSecrets(cause.message, token));
  copy.name = cause.name;
  copy.stack = cause.stack === undefined ? undefined : redactSecrets(cause.stack, token);
  const code = (cause as { code?: unknown }).code;
  if (typeof code === "string") Object.assign(copy, { code: redactSecrets(code, token) });
  if (cause.cause !== undefined && depth < 3) copy.cause = sanitizeCause(cause.cause, token, depth + 1);
  return copy;
}

export interface SdoErrorOptions {
  /** The underlying error. The SDK only ever passes a redacted copy. */
  cause?: unknown;
}

export class SdoError extends Error {
  constructor(message: string, opts: SdoErrorOptions = {}) {
    super(message, opts.cause === undefined ? undefined : { cause: opts.cause });
    this.name = new.target.name;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class SdoConfigError extends SdoError {}

export class SdoTransportError extends SdoError {}
export class SdoConnectionError extends SdoTransportError {}
export class SdoTimeoutError extends SdoTransportError {}

/**
 * The caller's `AbortSignal` fired. The request (or the wait before a retry) was
 * abandoned and is never retried; `cause` holds the signal's reason.
 */
export class SdoAbortError extends SdoTransportError {}

/**
 * The response exceeded the client's size ceiling.
 *
 * Transparent decompression is an attack surface: the scraped target controls
 * the body, so a small compressed payload can inflate without bound. Reading is
 * capped and aborts as soon as the ceiling is crossed, before the full buffer is
 * materialized.
 */
export class SdoResponseTooLargeError extends SdoTransportError {
  /** The byte ceiling that was exceeded. */
  readonly limit: number;
  constructor(message: string, limit: number) {
    super(message);
    this.limit = limit;
  }
}

export interface ApiErrorOptions extends SdoErrorOptions {
  statusCode: number;
  billed?: boolean;
  /** Scrape.do-Request-Cost, when it was one readable integer. */
  cost?: number;
  isRetryable?: boolean;
  retryAfter?: number;
  /** The error body, redacted and truncated to 2048 characters. */
  body?: string;
}

export class SdoApiError extends SdoError {
  readonly statusCode: number;
  /**
   * Whether the gateway charged for the response: Scrape.do-Request-Cost when
   * readable (0 is not billed), else the documented status table. Never for
   * the async job API.
   */
  readonly billed: boolean;
  /**
   * Scrape.do-Request-Cost, read like ScrapeResult.cost (undefined when absent
   * or unreadable, and for the job API). An error's cost is 0: a positive cost
   * makes the response a result.
   */
  readonly cost?: number;
  readonly isRetryable: boolean;
  readonly retryAfter?: number;
  readonly body?: string;

  constructor(message: string, opts: ApiErrorOptions) {
    super(message, opts);
    this.statusCode = opts.statusCode;
    this.billed = opts.billed ?? false;
    this.cost = opts.cost;
    this.isRetryable = opts.isRetryable ?? false;
    this.retryAfter = opts.retryAfter;
    this.body = opts.body;
  }
}

/**
 * 401/403 — the token is missing, invalid, not permitted, or the account's
 * monthly credit balance is exhausted. The gateway has no separate 402 tier: a
 * depleted balance also returns 401, so the two are told apart by the message.
 */
export class SdoAuthError extends SdoApiError {}
export class SdoValidationError extends SdoApiError {}
export class SdoGatewayError extends SdoApiError {}

export class SdoConcurrencyError extends SdoApiError {
  readonly remainingCredits?: number;

  constructor(message: string, opts: ApiErrorOptions & { remainingCredits?: number }) {
    super(message, opts);
    this.remainingCredits = opts.remainingCredits;
  }
}

function parseObject(body: string | undefined): Record<string, unknown> | undefined {
  if (!body) return undefined;
  let parsed: unknown;
  try {
    // A leading UTF-8 BOM is not part of the JSON text.
    parsed = JSON.parse(body.charCodeAt(0) === 0xfeff ? body.slice(1) : body);
  } catch {
    return undefined;
  }
  return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : undefined;
}

/**
 * The message of a sync-gateway error envelope: a `message` key, else an
 * `error` key, each matched in any ASCII letter case — the gateway writes
 * `{"Message": ["…", …]}`, a plugin `{"error": "code", "message": "text"}`. The
 * value is a string, or a list whose non-empty string elements are joined with
 * "; ". When several keys match one name they are tried in byte order
 * ("Message" before "message"); one that yields nothing falls through to the
 * next, then to `error`. The body is parsed before any truncation. Returns
 * undefined when there is no usable envelope (an empty message included), so
 * the caller falls back to its default.
 */
export function syncEnvelopeMessage(body: string | undefined): string | undefined {
  const obj = parseObject(body);
  if (!obj) return undefined;
  // Matching keys are ASCII letters only, so the default sort is byte order.
  const keys = Object.keys(obj).sort();
  for (const name of ["message", "error"]) {
    for (const key of keys) {
      if (asciiLower(key) !== name) continue;
      const text = envelopeText(obj[key]);
      if (text !== undefined) return text;
    }
  }
  return undefined;
}

function envelopeText(value: unknown): string | undefined {
  const text = Array.isArray(value)
    ? value.filter((m): m is string => typeof m === "string" && m !== "").join("; ")
    : typeof value === "string"
      ? value
      : "";
  return text === "" ? undefined : text;
}

/** Lowercases A-Z only (toLowerCase would also fold "İ" or the Kelvin sign). */
function asciiLower(s: string): string {
  return s.replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32));
}

/** The message of an async-API error envelope: `{"Error": "…", "Code": n}`. Only `Error` is read. */
export function asyncEnvelopeMessage(body: string | undefined): string | undefined {
  const obj = parseObject(body);
  const msg = obj?.Error;
  return typeof msg === "string" && msg !== "" ? msg : undefined;
}
