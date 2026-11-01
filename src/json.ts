// SPDX-License-Identifier: Apache-2.0
// JSON in both directions. Canonical JSON is the one encoding every sdo SDK
// produces byte-for-byte for JSON-valued parameters, JSON request bodies and the
// async job body; parseJsonBody is the one way a response body is read as JSON.
//
// Compact; object keys sorted by Unicode code point; no HTML escaping; U+2028
// and U+2029 literal; numbers in ECMAScript Number::toString form. JSON.stringify
// already gets strings and numbers right, but it emits keys in insertion order
// (integer-like keys first) and Array.prototype.sort compares UTF-16 code units,
// which puts an astral key such as U+1F600 before U+FF5E. Keys are therefore
// sorted and written here by hand.
import { sanitizeCause, SdoConfigError, SdoTransportError } from "./errors.js";

/** Compare two strings by Unicode code point (not UTF-16 code unit). */
export function compareCodePoints(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a.charCodeAt(i) !== b.charCodeAt(i)) {
      // At the first differing unit, the full code point decides; a surrogate
      // pair yields its astral value, which sorts above every BMP character.
      return (a.codePointAt(i) as number) - (b.codePointAt(i) as number);
    }
  }
  return a.length - b.length;
}

/** Serialize a value as canonical JSON. Throws SdoConfigError for values JSON cannot represent. */
export function canonicalJson(value: unknown): string {
  try {
    return encode(value, new Set());
  } catch (e) {
    // A value nested deeper than the call stack allows.
    if (e instanceof RangeError) throw new SdoConfigError("JSON cannot represent a value nested this deeply.");
    throw e;
  }
}

function encode(value: unknown, seen: Set<object>): string {
  if (value !== null && typeof value === "object" && typeof (value as { toJSON?: unknown }).toJSON === "function") {
    value = (value as { toJSON: () => unknown }).toJSON();
  }
  if (value === null) return "null";
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isFinite(value)) throw new SdoConfigError(`JSON cannot represent the number ${value}.`);
      return JSON.stringify(value); // ECMAScript Number::toString; -0 -> "0"
    case "string":
      return JSON.stringify(value);
    case "object":
      break;
    default:
      throw new SdoConfigError(`JSON cannot represent a value of type ${typeof value}.`);
  }
  const obj = value as object;
  if (seen.has(obj)) throw new SdoConfigError("JSON cannot represent a circular structure.");
  seen.add(obj);
  let out: string;
  if (Array.isArray(obj)) {
    // As JSON.stringify: an array hole or unrepresentable element becomes null.
    out = "[" + obj.map((v) => (isSkippable(v) ? "null" : encode(v, seen))).join(",") + "]";
  } else {
    const rec = obj as Record<string, unknown>;
    const keys = Object.keys(rec)
      .filter((k) => !isSkippable(rec[k]))
      .sort(compareCodePoints);
    out = "{" + keys.map((k) => JSON.stringify(k) + ":" + encode(rec[k], seen)).join(",") + "}";
  }
  seen.delete(obj);
  return out;
}

// Members JSON.stringify drops from objects (and writes as null in arrays).
function isSkippable(v: unknown): boolean {
  return v === undefined || typeof v === "function" || typeof v === "symbol";
}

/**
 * Parse a response body as JSON (`.json()`, plugin and job responses alike).
 *
 * UTF-8, with invalid bytes replaced by U+FFFD and a leading BOM ignored. A number
 * that overflows a double (`1e400`) is rejected like NaN and Infinity, which
 * JSON.parse already refuses. Every failure, nesting limits included, is a
 * SdoTransportError whose message names `what`.
 */
export function parseJsonBody(bytes: Uint8Array, what: string, token?: string): unknown {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8").decode(bytes));
  } catch (e) {
    throw new SdoTransportError(`${what} is not valid JSON.`, { cause: sanitizeCause(e, token) });
  }
  // Iterative, so a deeply nested document cannot overflow the stack here.
  const stack: unknown[] = [value];
  while (stack.length > 0) {
    const v = stack.pop();
    if (typeof v === "number" && !Number.isFinite(v)) {
      throw new SdoTransportError(`${what} is not valid JSON: a number overflows a double.`);
    }
    if (v !== null && typeof v === "object") for (const child of Object.values(v)) stack.push(child);
  }
  return value;
}
