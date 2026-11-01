// SPDX-License-Identifier: Apache-2.0
// Request headers: validated before anything is sent, merged case-insensitively.
//
// A caller's header replaces the SDK's own (User-Agent, Accept-Encoding) whatever
// the letter case of its name, so it is sent exactly once and never comma-merged.
// A header the HTTP layer would refuse is a config error here, before the first
// attempt, instead of a connection failure that the retry loop would repeat.
import { SdoConfigError } from "./errors.js";

export type HeaderMap = Record<string, string>;

// RFC 9110 §5.6.2 token.
const NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
// Printable ASCII, space and horizontal tab: no CR, LF, NUL, other controls or non-ASCII.
const VALUE = /^[\t\x20-\x7e]*$/;
// Framing and routing belong to the HTTP layer.
const FORBIDDEN = new Set(["host", "content-length", "transfer-encoding", "connection"]);

/** Validate caller-supplied headers and return them as a plain map. */
export function checkHeaders(headers: unknown, what = "headers"): HeaderMap {
  if (headers === undefined || headers === null) return {};
  let entries: Array<[string, unknown]> = [];
  if (headers instanceof Headers) headers.forEach((value, name) => entries.push([name, value]));
  else if (typeof headers === "object" && !Array.isArray(headers)) entries = Object.entries(headers);
  else throw new SdoConfigError(`${what} must be a plain object mapping header names to string values.`);
  const out: HeaderMap = {};
  for (const [name, value] of entries) {
    if (!NAME.test(name)) {
      throw new SdoConfigError(
        `Invalid header name ${JSON.stringify(name)} in ${what}: it must be an RFC 9110 token ` +
          "(letters, digits and !#$%&'*+-.^_`|~).",
      );
    }
    if (FORBIDDEN.has(name.toLowerCase())) {
      throw new SdoConfigError(`The '${name}' header is managed by the HTTP layer and cannot be set.`);
    }
    // The value is not echoed: it may be a credential.
    if (typeof value !== "string" || !VALUE.test(value)) {
      throw new SdoConfigError(
        `Invalid value for header '${name}': it must be a string of printable ASCII characters, ` +
          "spaces and tabs (no CR, LF, NUL or non-ASCII).",
      );
    }
    out[name] = value;
  }
  return out;
}

/** Merge header maps in order: a later name replaces an earlier one whatever its letter case. */
export function mergeHeaders(...maps: ReadonlyArray<HeaderMap | undefined>): HeaderMap {
  const byName = new Map<string, readonly [string, string]>();
  for (const map of maps) {
    if (map) for (const [name, value] of Object.entries(map)) byName.set(name.toLowerCase(), [name, value]);
  }
  return Object.fromEntries(byName.values());
}

/**
 * `s` without leading and trailing characters from `chars` (pass `start` false
 * to keep the leading ones). An index loop, not a regex: an alternation such as
 * /^[ \t]+|[ \t]+$/g rescans the run of whitespace from every position, which is
 * quadratic on a long header a target controls.
 */
export function trimChars(s: string, chars: string, start = true): string {
  let i = 0;
  let j = s.length;
  if (start) while (i < j && chars.includes(s[i]!)) i += 1;
  while (j > i && chars.includes(s[j - 1]!)) j -= 1;
  return i === 0 && j === s.length ? s : s.slice(i, j);
}

/** The largest cost read: 2^53-1, the largest integer every SDK holds exactly. */
export const MAX_REQUEST_COST = Number.MAX_SAFE_INTEGER;

/**
 * Scrape.do-Request-Cost as a number, or undefined when it is not one value of
 * ASCII digits (spaces and tabs trimmed) of at most 2^53-1. A repeated header
 * arrives comma-joined and is refused.
 */
export function parseRequestCost(raw: string | null | undefined): number | undefined {
  if (raw === null || raw === undefined) return undefined;
  const trimmed = trimChars(raw, " \t");
  if (!/^[0-9]+$/.test(trimmed)) return undefined;
  const cost = Number(trimmed);
  return cost <= MAX_REQUEST_COST ? cost : undefined;
}

/** Whether a header is present, compared case-insensitively. */
export function hasHeader(headers: HeaderMap, name: string): boolean {
  const lower = name.toLowerCase();
  return Object.keys(headers).some((k) => k.toLowerCase() === lower);
}
