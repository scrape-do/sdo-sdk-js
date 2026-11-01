// SPDX-License-Identifier: Apache-2.0
// ScrapeConfig — the single, serializable request spec (mirrors the Python SDK).
import { SdoConfigError } from "./errors.js";
import { checkHeaders } from "./headers.js";
import { canonicalJson, compareCodePoints } from "./json.js";
import { plainObject, rejectUnknownKeys } from "./options.js";
import { validateTargetUrl } from "./urls.js";

export interface ScrapeOptions {
  /** Enable JS rendering: `true` or `"true"`; `false`/`"false"` leave it off. */
  render?: boolean | "true" | "false";
  superProxy?: boolean;
  device?: "desktop" | "mobile" | "tablet";
  /** Gateway-side timeout in milliseconds (5000-120000). */
  timeout?: number;
  /** Gateway retry timeout in milliseconds (5000-55000). Cannot be combined with render. */
  retryTimeout?: number;
  disableRetry?: boolean;
  geoCode?: string;
  /**
   * Route through a random country of a region (europe, asia, africa, oceania,
   * northamerica, southamerica). Requires superProxy; cannot be combined with geoCode.
   */
  regionalGeoCode?: string;
  /** Postal/ZIP code targeting. Requires superProxy and geoCode. */
  zipCode?: string;
  /**
   * Sticky proxy session (the same IP across requests): an integer 0-1000000,
   * as a number or a string of decimal digits (at most 7). `0` is a valid id.
   */
  sessionId?: string | number;
  /**
   * Cookies to pre-set, as the RAW string `name=value; name2=value2`. The gateway
   * expects this URL-encoded and the SDK encodes it as a query value, so
   * pre-encoding it yourself double-encodes and breaks it.
   */
  setCookies?: string;
  /** customHeaders, extraHeaders and forwardHeaders are mutually exclusive. */
  customHeaders?: boolean;
  extraHeaders?: boolean;
  forwardHeaders?: boolean;
  /** Headers sent with the request (forwarded to the target with customHeaders/extraHeaders/forwardHeaders). */
  headers?: Record<string, string>;
  /** Extra wait after page load in milliseconds (0-35000). Needs render. */
  customWait?: number;
  waitSelector?: string;
  waitUntil?: "domcontentloaded" | "load" | "networkidle0" | "networkidle2";
  /**
   * Tri-state. Unset (undefined/null) sends nothing and the gateway's default,
   * true (resources blocked), applies. `true` sends blockResources=true and
   * needs render; `false` sends blockResources=false to load resources, and
   * does not need render.
   */
  blockResources?: boolean;
  playWithBrowser?: Array<Record<string, unknown>>;
  /** WebSocket messages in the JSON response. Needs render and returnJson. */
  showWebsocketRequests?: boolean;
  /** iframe content in the JSON response. Needs render and returnJson. */
  showFrames?: boolean;
  /**
   * The three screenshot options need render and returnJson (the image comes
   * back base64-encoded in the JSON response); only one may be set, and
   * particularScreenshot cannot be combined with playWithBrowser.
   */
  screenshot?: boolean;
  fullScreenshot?: boolean;
  /** CSS selector of the element to capture. */
  particularScreenshot?: string;
  /** Viewport height in px. Needs render. */
  height?: number;
  /** Viewport width in px. Needs render. */
  width?: number;
  output?: "raw" | "markdown";
  /**
   * Return the network requests and page content as JSON. With render it
   * carries the browser's XHR/fetch requests; without render the gateway wraps
   * the plain response in the same JSON envelope.
   */
  returnJson?: boolean;
  /** Return the target's original Set-Cookie header instead of Scrape.do-Cookies; the body is unchanged. */
  pureCookies?: boolean;
  disableRedirection?: boolean;
  transparentResponse?: boolean;
  /**
   * Escape hatch for any parameter not modelled above, sent verbatim after the
   * typed ones (sorted by key). Booleans are sent as "true"/"false", numbers in
   * their JavaScript form; null and undefined are skipped. `token` and `url`
   * are reserved.
   */
  extraParams?: Record<string, unknown>;
}

type Kind =
  | { t: "bool" }
  // A boolean whose false is sent too (unset is undefined/null).
  | { t: "tribool" }
  | { t: "int"; min?: number; max?: number }
  | { t: "string" }
  // sessionId: an integer 0-1000000, as a number or a string of digits.
  | { t: "session" }
  | { t: "enum"; values: readonly string[] }
  // A JSON array, sent as canonical JSON.
  | { t: "json" };

interface Param {
  opt: keyof ScrapeOptions;
  wire: string;
  kind: Kind;
  renderOnly?: boolean;
}

const BOOL: Kind = { t: "bool" };
const STRING: Kind = { t: "string" };
const INT: Kind = { t: "int" };

// Every public parameter after `url` and `render`, in the spec's order. The
// order is part of the contract: all three SDKs emit this same sequence and the
// conformance corpus pins it.
const PARAMS: readonly Param[] = [
  { opt: "superProxy", wire: "super", kind: BOOL },
  { opt: "device", wire: "device", kind: { t: "enum", values: ["desktop", "mobile", "tablet"] } },
  { opt: "timeout", wire: "timeout", kind: { t: "int", min: 5000, max: 120000 } },
  { opt: "retryTimeout", wire: "retryTimeout", kind: { t: "int", min: 5000, max: 55000 } },
  { opt: "disableRetry", wire: "disableRetry", kind: BOOL },
  // Free-form codes: sent exactly as given (the gateway normalizes them).
  { opt: "geoCode", wire: "geoCode", kind: STRING },
  { opt: "regionalGeoCode", wire: "regionalGeoCode", kind: STRING },
  { opt: "zipCode", wire: "zipCode", kind: STRING },
  { opt: "sessionId", wire: "sessionId", kind: { t: "session" } },
  { opt: "setCookies", wire: "setCookies", kind: STRING },
  { opt: "customHeaders", wire: "customHeaders", kind: BOOL },
  { opt: "extraHeaders", wire: "extraHeaders", kind: BOOL },
  { opt: "forwardHeaders", wire: "forwardHeaders", kind: BOOL },
  { opt: "customWait", wire: "customWait", kind: { t: "int", min: 0, max: 35000 }, renderOnly: true },
  { opt: "waitSelector", wire: "waitSelector", kind: STRING, renderOnly: true },
  {
    opt: "waitUntil",
    wire: "waitUntil",
    kind: { t: "enum", values: ["domcontentloaded", "load", "networkidle0", "networkidle2"] },
    renderOnly: true,
  },
  // Render-only when true; an explicit false needs no render (see encodeParam).
  { opt: "blockResources", wire: "blockResources", kind: { t: "tribool" }, renderOnly: true },
  { opt: "playWithBrowser", wire: "playWithBrowser", kind: { t: "json" }, renderOnly: true },
  { opt: "showWebsocketRequests", wire: "showWebsocketRequests", kind: BOOL, renderOnly: true },
  { opt: "showFrames", wire: "showFrames", kind: BOOL, renderOnly: true },
  { opt: "screenshot", wire: "screenShot", kind: BOOL, renderOnly: true },
  { opt: "fullScreenshot", wire: "fullScreenShot", kind: BOOL, renderOnly: true },
  { opt: "particularScreenshot", wire: "particularScreenShot", kind: STRING, renderOnly: true },
  { opt: "height", wire: "height", kind: INT, renderOnly: true },
  { opt: "width", wire: "width", kind: INT, renderOnly: true },
  { opt: "output", wire: "output", kind: { t: "enum", values: ["raw", "markdown"] } },
  { opt: "returnJson", wire: "returnJSON", kind: BOOL },
  { opt: "pureCookies", wire: "pureCookies", kind: BOOL },
  { opt: "disableRedirection", wire: "disableRedirection", kind: BOOL },
  { opt: "transparentResponse", wire: "transparentResponse", kind: BOOL },
];

const RENDER_VALUES = ["true", "false"];
const MAX_SESSION_ID = 1_000_000;
// Decimal digits, at most 7 (the gateway's length limit for sessionId).
const SESSION_ID = /^[0-9]{1,7}$/;
const RESERVED_EXTRA = new Set(["token", "url"]);
// A query parameter name the API could mean: a letter, then letters, digits,
// "_", "." or "-". Anything else ("a&token=x", "q ", "x[]") is not a parameter
// the API takes, so it is refused rather than percent-encoded and sent.
export const PARAM_NAME = /^[A-Za-z][A-Za-z0-9_.-]*$/;

/** Every key a ScrapeOptions object may carry. */
export const SCRAPE_OPTION_KEYS: readonly string[] = ["render", ...PARAMS.map((p) => p.opt), "headers", "extraParams"];
// Wire names (`super`, `screenShot`, ...) get a "did you mean" hint too.
const WIRE_ALIASES: ReadonlyArray<readonly [string, string]> = PARAMS.map((p) => [p.wire, p.opt]);

/** Throws SdoConfigError naming every key of `options` that is not a scrape option (or one of `also`). */
export function rejectUnknownScrapeOptions(options: Record<string, unknown>, also: readonly string[] = []): void {
  rejectUnknownKeys(
    options,
    [...SCRAPE_OPTION_KEYS, ...also],
    "scrape option(s)",
    WIRE_ALIASES,
    " Send a parameter the SDK does not model through extraParams.",
  );
}

function invalid(name: string, expected: string, value: unknown): SdoConfigError {
  const shown = typeof value === "string" ? JSON.stringify(value) : Array.isArray(value) ? "an array" : String(value);
  return new SdoConfigError(`'${name}' must be ${expected}, got ${shown}.`);
}

/**
 * The wire values of one typed parameter, or undefined when it is unset.
 *
 * Unset means omitted, never sent: undefined/null, false, 0, "" and an empty
 * list or object. Unset values are not validated, so `timeout: 0` is not a
 * range error and `screenshot: false` does not need render. A tri-state boolean
 * (blockResources) is the exception: its false is sent.
 */
function encodeParam(p: Param, value: unknown): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  const k = p.kind;
  switch (k.t) {
    case "bool":
      if (typeof value !== "boolean") throw invalid(p.opt, "a boolean", value);
      return value ? ["true"] : undefined;
    case "tribool":
      if (typeof value !== "boolean") throw invalid(p.opt, "a boolean", value);
      return [value ? "true" : "false"];
    case "int": {
      if (value === 0) return undefined;
      if (typeof value !== "number" || !Number.isSafeInteger(value)) throw invalid(p.opt, "an integer", value);
      if ((k.min !== undefined && value < k.min) || (k.max !== undefined && value > k.max)) {
        // Name the unit: `timeout: 30` meaning 30 seconds is the classic mistake.
        throw new SdoConfigError(
          `'${p.opt}' must be between ${k.min} and ${k.max} milliseconds, got ${value}. ` +
            `It is the gateway-side value in ms; the client's own timeout is ClientOptions.timeoutMs.`,
        );
      }
      return [String(value)];
    }
    case "string":
      if (typeof value !== "string") throw invalid(p.opt, "a string", value);
      return value === "" ? undefined : [value];
    case "session": {
      // An id, not a quantity: 0 is sent, only undefined/null and "" are unset.
      if (value === "") return undefined;
      const ok =
        typeof value === "number"
          ? Number.isSafeInteger(value) && value >= 0 && value <= MAX_SESSION_ID
          : typeof value === "string" && SESSION_ID.test(value) && Number(value) <= MAX_SESSION_ID;
      if (!ok) throw invalid(p.opt, "an integer from 0 to 1000000 (a number or decimal digits)", value);
      return [String(value)];
    }
    case "enum": {
      if (value === "") return undefined;
      const lower = typeof value === "string" ? value.toLowerCase() : undefined;
      if (lower === undefined || !k.values.includes(lower)) throw invalid(p.opt, `one of ${k.values.join(", ")}`, value);
      return [lower];
    }
    case "json":
      if (!Array.isArray(value)) throw invalid(p.opt, "an array", value);
      return value.length === 0 ? undefined : [canonicalJson(value)];
  }
}

/** `render` as sent on the wire ("true"), or undefined when rendering is off. */
function encodeRender(value: unknown): string | undefined {
  if (value === undefined || value === null || value === false || value === "") return undefined;
  if (value === true) return "true";
  const lower = typeof value === "string" ? value.toLowerCase() : undefined;
  if (lower === undefined || !RENDER_VALUES.includes(lower)) throw invalid("render", "true or false", value);
  // "false" is the same request as no render at all.
  return lower === "false" ? undefined : lower;
}

/**
 * The documented rules that tie parameters together, each of which the gateway
 * rejects with a 400 (or, for zipCode and particularScreenshot with
 * playWithBrowser, documents as invalid). `sent` holds the options that are
 * set; `rendering` is whether render is on.
 */
function checkDependencies(sent: ReadonlySet<keyof ScrapeOptions>, rendering: boolean): void {
  const fail = (message: string): never => {
    throw new SdoConfigError(message);
  };
  const count = (...opts: Array<keyof ScrapeOptions>): number => opts.filter((o) => sent.has(o)).length;
  if (sent.has("regionalGeoCode")) {
    if (!sent.has("superProxy")) fail("'regionalGeoCode' requires superProxy: true.");
    if (sent.has("geoCode")) fail("'regionalGeoCode' and 'geoCode' cannot be combined; set only one of them.");
  }
  if (sent.has("zipCode") && !(sent.has("superProxy") && sent.has("geoCode"))) {
    fail("'zipCode' requires superProxy: true and a geoCode (the country of the postal code).");
  }
  if (count("customHeaders", "extraHeaders", "forwardHeaders") > 1) {
    fail("'customHeaders', 'extraHeaders' and 'forwardHeaders' cannot be combined; set only one of them.");
  }
  if (sent.has("retryTimeout") && rendering) fail("'retryTimeout' cannot be combined with render.");
  if (count("screenshot", "fullScreenshot", "particularScreenshot") > 1) {
    fail("'screenshot', 'fullScreenshot' and 'particularScreenshot' cannot be combined; set only one of them.");
  }
  if (!sent.has("returnJson")) {
    for (const opt of [
      "showWebsocketRequests",
      "showFrames",
      "screenshot",
      "fullScreenshot",
      "particularScreenshot",
    ] as const) {
      if (sent.has(opt)) fail(`'${opt}' requires returnJson: true (its output is part of the JSON response).`);
    }
  }
  if (sent.has("particularScreenshot") && sent.has("playWithBrowser")) {
    fail(
      "'particularScreenshot' cannot be combined with playWithBrowser; " +
        'add a { Action: "ScreenShot", particularScreenShot: "<selector>" } action instead.',
    );
  }
}

function encodeExtra(key: string, value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") return value;
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  throw invalid(`extraParams.${key}`, "a string, finite number or boolean", value);
}

export class ScrapeConfig {
  readonly url: string;
  readonly options: ScrapeOptions;

  constructor(url: string, options: ScrapeOptions = {}) {
    this.url = validateTargetUrl(url);
    // A copy, so later edits to the caller's object cannot bypass validation.
    this.options = { ...plainObject(options ?? {}, "ScrapeConfig options") };
    this.validate();
  }

  /** Throws SdoConfigError when the options cannot form a valid request. */
  validate(): void {
    this.toParams();
    checkHeaders(this.options.headers);
  }

  /** The query pairs after the token: url, typed params in spec order, then extraParams sorted by key. */
  toParams(): Array<[string, string]> {
    const o = this.options as Record<string, unknown>;
    rejectUnknownScrapeOptions(o);
    const out: Array<[string, string]> = [["url", this.url]];

    const render = encodeRender(o.render);
    if (render !== undefined) out.push(["render", render]);
    const sent = new Set<keyof ScrapeOptions>();

    for (const p of PARAMS) {
      const values = encodeParam(p, o[p.opt]);
      if (values === undefined) continue;
      // A tri-state false turns the render-only feature off, so it needs no render.
      const needsRender = p.renderOnly && !(p.kind.t === "tribool" && values[0] === "false");
      if (needsRender && render === undefined) {
        throw new SdoConfigError(`'${p.opt}' requires render to be enabled (set render: true).`);
      }
      sent.add(p.opt);
      for (const v of values) out.push([p.wire, v]);
    }
    checkDependencies(sent, render !== undefined);

    const extra = o.extraParams;
    if (extra !== undefined && extra !== null) {
      if (typeof extra !== "object" || Array.isArray(extra)) throw invalid("extraParams", "a plain object", extra);
      const rec = extra as Record<string, unknown>;
      for (const key of Object.keys(rec).sort(compareCodePoints)) {
        if (key === "") throw new SdoConfigError("extraParams keys cannot be empty.");
        // The token only comes from the client and the url from ScrapeConfig.url.
        if (RESERVED_EXTRA.has(key.toLowerCase())) {
          throw new SdoConfigError(`extraParams cannot set the reserved key '${key}'.`);
        }
        if (!PARAM_NAME.test(key)) {
          throw new SdoConfigError(
            `extraParams key ${JSON.stringify(key)} is not a valid parameter name: ` +
              `use letters, digits, "_", "." or "-", starting with a letter.`,
          );
        }
        const value = encodeExtra(key, rec[key]);
        if (value !== undefined) out.push([key, value]);
      }
    }
    return out;
  }
}
