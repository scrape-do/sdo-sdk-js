// SPDX-License-Identifier: Apache-2.0
// Option objects are checked for unknown keys: a misspelled option (`renderr`,
// `geo_code`, the wire name `super`) must fail loudly rather than send a billed
// request without it. TypeScript's excess-property check only covers object
// literals, so options built at runtime (or plain JavaScript) need this.
import { SdoConfigError } from "./errors.js";

const fold = (key: string): string => key.toLowerCase().replace(/[-_]/g, "");

/** A plain object's own keys, or a config error naming what was expected. */
export function plainObject(value: unknown, what: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new SdoConfigError(`${what} must be a plain object.`);
  }
  return value as Record<string, unknown>;
}

/**
 * Throws SdoConfigError listing every key of `options` that is not in `allowed`.
 * A key that differs from an allowed one only by case, `_` or `-` (or matches an
 * alias such as a wire name) gets a "did you mean" hint.
 */
export function rejectUnknownKeys(
  options: Record<string, unknown>,
  allowed: readonly string[],
  what: string,
  aliases: ReadonlyArray<readonly [string, string]> = [],
  hint = "",
): void {
  const known = new Set(allowed);
  const unknown = Object.keys(options).filter((k) => !known.has(k));
  if (unknown.length === 0) return;
  const suggest = new Map<string, string>();
  for (const name of allowed) suggest.set(fold(name), name);
  for (const [alias, name] of aliases) suggest.set(fold(alias), name);
  const listed = unknown.map((k) => {
    const near = suggest.get(fold(k));
    return near === undefined ? `'${k}'` : `'${k}' (did you mean '${near}'?)`;
  });
  throw new SdoConfigError(`Unknown ${what}: ${listed.join(", ")}.${hint}`);
}
