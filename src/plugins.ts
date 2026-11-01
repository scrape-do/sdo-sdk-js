// SPDX-License-Identifier: Apache-2.0
// Generic plugin core: any documented plugin is callable the day it ships.
import { PARAM_NAME } from "./config.js";
import { SdoConfigError } from "./errors.js";
import { canonicalJson, compareCodePoints, parseJsonBody } from "./json.js";
import { buildQuery } from "./query.js";
import type { HttpResponse, Transport } from "./transport.js";

// Plugin routes reach this function from callers — including the MCP server,
// where an LLM chooses the value. Validating before it enters the URL path stops
// traversal ("../"), query injection ("x?token=") and fragment truncation ("x#")
// from reshaping the request. Mirrors the spec's plugin_route_pattern; a JS `$`
// (no `m` flag) matches only at the very end, so "x\n" is rejected too.
export const ROUTE_PATTERN = /^[a-z0-9]+(?:[/-][a-z0-9]+)*$/;

/**
 * Routes served under a different path. The Amazon raw-HTML plugin is the
 * group root /plugin/amazon/, and the gateway answers /plugin/amazon with a
 * redirect the SDK never follows; its documented spelling "amazon/" works too.
 */
const ROUTE_PATHS: ReadonlyMap<string, string> = new Map([
  ["amazon", "amazon/"],
  ["amazon/", "amazon/"],
]);

/** The validated path under /plugin/ for a route. */
function validateRoute(route: unknown): string {
  if (typeof route === "string" && ROUTE_PATHS.has(route)) return ROUTE_PATHS.get(route)!;
  if (typeof route !== "string" || !ROUTE_PATTERN.test(route)) {
    throw new SdoConfigError(
      `Invalid plugin route ${JSON.stringify(route)}. Routes look like 'google/shopping': ` +
        `lowercase letters and digits, separated by '/' or '-'.`,
    );
  }
  return route;
}

function literal(key: string, value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") return value;
  // Unlike ScrapeConfig, a plugin boolean is always sent: false is meaningful.
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  // An object travels as canonical JSON.
  if (typeof value === "object" && !Array.isArray(value)) return canonicalJson(value);
  throw new SdoConfigError(
    `Plugin parameter '${key}' must be a string, finite number, boolean, object or a list of them.`,
  );
}

/**
 * Query pairs for a plugin call: token first, then keys sorted by code point.
 * A list repeats the key per element (a nested list is refused), an object is
 * sent as canonical JSON, null is skipped. An empty key and `token` (any case)
 * are refused: the token only comes from the client; so is a key outside
 * PARAM_NAME.
 */
export function pluginQuery(token: string, params: Record<string, unknown>): Array<[string, string]> {
  if (params === null || typeof params !== "object" || Array.isArray(params)) {
    throw new SdoConfigError("Plugin parameters must be a plain object.");
  }
  const pairs: Array<[string, string]> = [["token", token]];
  for (const key of Object.keys(params).sort(compareCodePoints)) {
    if (key === "") throw new SdoConfigError("Plugin parameter names cannot be empty.");
    if (key.toLowerCase() === "token") {
      throw new SdoConfigError(`Plugin parameters cannot set the reserved key '${key}'; the token comes from the client.`);
    }
    if (!PARAM_NAME.test(key)) {
      throw new SdoConfigError(
        `Plugin parameter name ${JSON.stringify(key)} is not a valid parameter name: ` +
          `use letters, digits, "_", "." or "-", starting with a letter.`,
      );
    }
    const value = params[key];
    for (const item of Array.isArray(value) ? value : [value]) {
      if (Array.isArray(item)) throw new SdoConfigError(`Plugin parameter '${key}' cannot be a nested list.`);
      const v = literal(key, item);
      if (v !== undefined) pairs.push([key, v]);
    }
  }
  return pairs;
}

/**
 * The plugin's `timeout` param (ms) when it is sent once as a positive integer
 * (ASCII digits), else undefined.
 */
export function pluginTimeoutMs(pairs: ReadonlyArray<readonly [string, string]>): number | undefined {
  const values = pairs.filter(([k]) => k === "timeout").map(([, v]) => v);
  if (values.length !== 1 || !/^[0-9]+$/.test(values[0]!)) return undefined;
  const ms = Number(values[0]);
  return ms > 0 ? ms : undefined;
}

/** Call a plugin and return the delivered response (status, headers and body). */
export async function pluginResponse(
  transport: Transport,
  baseUrl: string,
  token: string,
  route: string,
  params: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<HttpResponse> {
  const path = "/plugin/" + validateRoute(route);
  const pairs = pluginQuery(token, params);
  const url = `${baseUrl}${path}?${buildQuery(pairs)}`;
  return transport.send({
    method: "GET",
    url,
    token,
    api: "sync",
    signal,
    // Like a scrape's `timeout`, the plugin's own waits for that plus a margin.
    gatewayTimeoutMs: pluginTimeoutMs(pairs),
  });
}

/** A plugin response's payload: parsed JSON when the Content-Type says JSON, else the bytes. */
export function pluginOutput(resp: HttpResponse, token: string): unknown {
  const ct = (resp.headers.get("content-type") ?? "").toLowerCase();
  if (!ct.includes("json")) return resp.body;
  return parseJsonBody(resp.body, "The plugin response", token);
}

export async function callPlugin(
  transport: Transport,
  baseUrl: string,
  token: string,
  route: string,
  params: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<unknown> {
  return pluginOutput(await pluginResponse(transport, baseUrl, token, route, params, signal), token);
}
