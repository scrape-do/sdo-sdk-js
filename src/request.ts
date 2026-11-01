// SPDX-License-Identifier: Apache-2.0
// The HTTP method, body and headers a scrape is sent with (the gateway relays
// them to the target).
import { SdoConfigError } from "./errors.js";
import { checkHeaders, hasHeader, mergeHeaders, type HeaderMap } from "./headers.js";
import { canonicalJson } from "./json.js";

export interface RequestOptions {
  /** HTTP method (case-insensitive). Default GET, or POST when a body is given. */
  method?: string;
  /** A JSON body, sent as canonical JSON with Content-Type application/json. */
  json?: unknown;
  /** A raw body, sent as-is (a string is UTF-8 encoded). No Content-Type is added. */
  data?: string | Uint8Array | ArrayBuffer;
  /**
   * Request headers. Names are case-insensitive and a value here replaces the
   * SDK's own (User-Agent, Accept-Encoding); a Content-Type given here always
   * wins. Names must be RFC 9110 tokens and values printable ASCII; Host,
   * Content-Length, Transfer-Encoding and Connection cannot be set.
   */
  headers?: Record<string, string>;
  /**
   * Aborts the call: the request in flight, reading its body, or the wait
   * before a retry. The call then rejects with `SdoAbortError`.
   */
  signal?: AbortSignal;
}

/** Every key a RequestOptions object may carry. */
export const REQUEST_OPTION_KEYS: readonly string[] = ["method", "json", "data", "headers", "signal"];

/** A caller's AbortSignal, or a config error for anything else. */
export function checkSignal(signal: unknown): AbortSignal | undefined {
  if (signal === undefined || signal === null) return undefined;
  if (!(signal instanceof AbortSignal)) throw new SdoConfigError("signal must be an AbortSignal.");
  return signal;
}

const METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]);

export interface PreparedRequest {
  method: string;
  headers: HeaderMap;
  body?: Uint8Array;
}

/** Validate the request inputs and build the method, headers and body bytes. */
export function prepareRequest(req: RequestOptions, baseHeaders?: Record<string, string>): PreparedRequest {
  const headers = mergeHeaders(checkHeaders(baseHeaders), checkHeaders(req.headers));
  const hasJson = req.json !== undefined && req.json !== null;
  const hasData = req.data !== undefined && req.data !== null;
  if (hasJson && hasData) throw new SdoConfigError("Pass either json or data as the request body, not both.");

  let method: string;
  if (req.method === undefined || req.method === null) {
    method = hasJson || hasData ? "POST" : "GET";
  } else {
    method = typeof req.method === "string" ? req.method.toUpperCase() : "";
    if (!METHODS.has(method)) {
      throw new SdoConfigError(
        `Unsupported HTTP method ${JSON.stringify(req.method)}; use one of ${[...METHODS].join(", ")}.`,
      );
    }
  }
  if ((hasJson || hasData) && (method === "GET" || method === "HEAD")) {
    throw new SdoConfigError(`A ${method} request cannot carry a body.`);
  }

  let body: Uint8Array | undefined;
  if (hasJson) {
    body = new TextEncoder().encode(canonicalJson(req.json));
    if (!hasHeader(headers, "content-type")) headers["Content-Type"] = "application/json";
  } else if (typeof req.data === "string") {
    body = new TextEncoder().encode(req.data);
  } else if (req.data instanceof Uint8Array) {
    body = req.data;
  } else if (req.data instanceof ArrayBuffer) {
    body = new Uint8Array(req.data);
  } else if (hasData) {
    throw new SdoConfigError("data must be a string, Uint8Array or ArrayBuffer.");
  }
  return body === undefined ? { method, headers } : { method, headers, body };
}
