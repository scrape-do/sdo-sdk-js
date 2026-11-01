// SPDX-License-Identifier: Apache-2.0
// URL rules enforced before any request is made.
//
// Both checks are string grammars, not a URL parser: the WHATWG parser accepts
// `https:e.com`, `https:///e.com` and `https:\e.com` for special schemes and
// would let them through, while it rejects inputs the gateway can take.
//
//   url       = scheme "://" authority [ ("/" | "?" | "#") rest ]
//   scheme    = "http" | "https"                (any letter case)
//   authority = [ userinfo "@" ] host [ ":" port ]    (up to the first / ? #)
//   host      = a non-empty string, or "[" ... "]"
//   port      = 1-65535
//
// No whitespace, control character or backslash may appear anywhere.
import { redactSecrets, SdoConfigError } from "./errors.js";

// Plain http is allowed only where the token cannot leave the machine.
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
const SCHEME = /^(https?):\/\//i;
// `\s` covers ASCII and Unicode whitespace; C0 and C1 controls, DEL, backslash.
const FORBIDDEN_CHAR = /[\s\x00-\x1f\x7f-\x9f\\]/;
const LONE_SURROGATE = /\p{Cs}/u;

interface Parts {
  scheme: string;
  userinfo?: string;
  host: string;
  /** Everything after the authority: path, query and fragment. */
  rest: string;
}

function validPort(port: string): boolean {
  return /^[0-9]{1,5}$/.test(port) && Number(port) >= 1 && Number(port) <= 65535;
}

function split(raw: unknown): Parts | undefined {
  if (typeof raw !== "string" || FORBIDDEN_CHAR.test(raw) || LONE_SURROGATE.test(raw)) return undefined;
  const scheme = SCHEME.exec(raw);
  if (!scheme) return undefined;
  const after = raw.slice(scheme[0].length);
  const end = after.search(/[/?#]/);
  const authority = end < 0 ? after : after.slice(0, end);
  const at = authority.lastIndexOf("@");
  const hostPort = authority.slice(at + 1);
  let host = hostPort;
  let port: string | undefined;
  if (hostPort.startsWith("[")) {
    const close = hostPort.indexOf("]");
    if (close < 0) return undefined;
    host = hostPort.slice(0, close + 1);
    const tail = hostPort.slice(close + 1);
    if (tail !== "") {
      if (tail[0] !== ":") return undefined;
      port = tail.slice(1);
    }
  } else {
    const colon = hostPort.lastIndexOf(":");
    if (colon >= 0) {
      host = hostPort.slice(0, colon);
      port = hostPort.slice(colon + 1);
    }
  }
  if (host === "" || host === "[]" || (port !== undefined && !validPort(port))) return undefined;
  return {
    scheme: scheme[1]!.toLowerCase(),
    ...(at < 0 ? {} : { userinfo: authority.slice(0, at) }),
    host,
    rest: end < 0 ? "" : after.slice(end),
  };
}

/** A URL safe to put in an error message: any userinfo is masked and credential shapes redacted. */
function shown(raw: string): string {
  return JSON.stringify(redactSecrets(raw.replace(/^([^/]*\/\/)[^/?#]*@/, "$1***@")));
}

/**
 * Validate an API base URL and return it without a trailing slash, keeping any
 * path prefix (a reverse proxy mounted under /gw keeps /gw).
 *
 * The token travels with every request to this base, so it must be https: http
 * is accepted only for a loopback host or when the caller opts in explicitly.
 * A query, a fragment, a trailing "?" or credentials are refused: the SDK
 * appends its own path and query.
 */
export function normalizeBaseUrl(raw: string, what: string, allowInsecureHttp: boolean): string {
  const parts = split(raw);
  if (parts === undefined) {
    throw new SdoConfigError(
      `${what} must be an absolute https:// URL (scheme, host, optional port and path prefix), got ${shown(String(raw))}.`,
    );
  }
  if (parts.userinfo !== undefined || /[?#]/.test(parts.rest)) {
    throw new SdoConfigError(`${what} must not carry credentials, a query or a fragment, got ${shown(raw)}.`);
  }
  if (parts.scheme === "http" && !allowInsecureHttp && !LOOPBACK_HOSTS.has(parts.host.toLowerCase())) {
    throw new SdoConfigError(
      `${what} must use https:// (the API token is sent with every request); plain http is only ` +
        `accepted for localhost, 127.0.0.1 and ::1, or with allowInsecureHttp: true. Got ${shown(raw)}.`,
    );
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new SdoConfigError(`${what} has a host that is not a valid hostname, got ${shown(raw)}.`);
  }
  return url.origin + url.pathname.replace(/\/+$/, "");
}

/**
 * The scrape target must be an absolute http(s) URL with a host (the grammar
 * above). The gateway is the real boundary; this only stops obvious mistakes
 * before a billed request is made. The URL is otherwise sent exactly as given.
 */
export function validateTargetUrl(raw: unknown): string {
  if (split(raw) === undefined) {
    throw new SdoConfigError(
      `The target url must be an absolute http:// or https:// URL with a host and no whitespace, ` +
        `control character or backslash, got ${typeof raw === "string" ? shown(raw) : String(raw)}.`,
    );
  }
  return raw as string;
}
