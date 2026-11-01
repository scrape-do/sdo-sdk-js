// SPDX-License-Identifier: Apache-2.0
// The normative wire encoding of a query string, built by hand.
//
// URLSearchParams is not used: it keeps `*` literal and writes a space as `+`,
// so the bytes on the wire would differ from the Python and Go SDKs. Here every
// key and value is UTF-8 encoded, RFC 3986 unreserved characters
// (A-Z a-z 0-9 - . _ ~) stay literal, and every other byte becomes %XX with
// uppercase hex (a space is %20).

const UNRESERVED = /^[A-Za-z0-9\-._~]$/;
const encoder = new TextEncoder();

/** Percent-encode one query component (RFC 3986 unreserved kept, UTF-8, uppercase hex). */
export function pctEncode(s: string): string {
  let out = "";
  for (const byte of encoder.encode(s)) {
    const ch = String.fromCharCode(byte);
    out += UNRESERVED.test(ch) ? ch : "%" + byte.toString(16).toUpperCase().padStart(2, "0");
  }
  return out;
}

/** Join (key, value) pairs into a query string, in the given order. */
export function buildQuery(pairs: ReadonlyArray<readonly [string, string]>): string {
  return pairs.map(([k, v]) => `${pctEncode(k)}=${pctEncode(v)}`).join("&");
}
