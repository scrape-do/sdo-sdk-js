// SPDX-License-Identifier: Apache-2.0
// Usage statistics: GET <base URL>/info (docs: API Response > Usage Statistics).
import { SdoTransportError } from "./errors.js";
import { parseJsonBody } from "./json.js";

/** The account's usage snapshot. When the subscription is not active, every count is 0. */
export interface Usage {
  /** Whether the subscription is active. */
  isActive: boolean;
  /** The plan's concurrent-request limit. */
  concurrentRequest: number;
  /** The plan's monthly request limit. */
  maxMonthlyRequest: number;
  /** How many more requests may run right now. */
  remainingConcurrentRequest: number;
  /** How many requests are left this month. */
  remainingMonthlyRequest: number;
}

const COUNTS = [
  ["ConcurrentRequest", "concurrentRequest"],
  ["MaxMonthlyRequest", "maxMonthlyRequest"],
  ["RemainingConcurrentRequest", "remainingConcurrentRequest"],
  ["RemainingMonthlyRequest", "remainingMonthlyRequest"],
] as const;

/** Read the /info body: a JSON object with every field, IsActive a boolean and the counts integers. */
export function parseUsage(body: Uint8Array, token: string): Usage {
  const raw = parseJsonBody(body, "The usage response", token);
  const invalid = (why: string): SdoTransportError =>
    new SdoTransportError(`The usage response is not the expected JSON object: ${why}.`);
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw invalid("not a JSON object");
  const obj = raw as Record<string, unknown>;
  if (typeof obj.IsActive !== "boolean") throw invalid("IsActive is missing or not a boolean");
  const usage: Partial<Usage> = { isActive: obj.IsActive };
  for (const [wire, field] of COUNTS) {
    const v = obj[wire];
    if (typeof v !== "number" || !Number.isSafeInteger(v)) throw invalid(`${wire} is missing or not an integer`);
    usage[field] = v;
  }
  return usage as Usage;
}
