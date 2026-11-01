// SPDX-License-Identifier: Apache-2.0
// ScrapeResult — the body is already decompressed by the transport.
import { decodeText } from "./decoding.js";
import { sanitizeCause, SdoConfigError } from "./errors.js";
import { parseRequestCost } from "./headers.js";
import { parseJsonBody } from "./json.js";

/**
 * What a ScrapeResult is built from. The SDK builds its own; building one by
 * hand is meant for tests. (A hand-built result decodes EUC-KR, Big5 and
 * Shift_JIS text with the runtime's TextDecoder until the SDK has loaded its
 * WHATWG tables, which it does before returning any such result of its own.)
 */
export interface ScrapeResultInit {
  content: Uint8Array;
  statusCode: number;
  /** Response headers; a name may carry several values (e.g. set-cookie). */
  headers: Headers | Record<string, string | string[]>;
  url: string;
}

function collectHeaders(headers: ScrapeResultInit["headers"]): Map<string, string[]> {
  const values = new Map<string, string[]>();
  const add = (name: string, value: string): void => {
    const key = name.toLowerCase();
    values.set(key, [...(values.get(key) ?? []), value]);
  };
  if (headers instanceof Headers) {
    // fetch joins repeated headers with ", ", which is lossy for Set-Cookie
    // (cookie dates contain commas); getSetCookie keeps them apart.
    headers.forEach((v, k) => k !== "set-cookie" && add(k, v));
    for (const cookie of headers.getSetCookie()) add("set-cookie", cookie);
  } else {
    for (const [k, v] of Object.entries(headers)) for (const one of Array.isArray(v) ? v : [v]) add(k, one);
  }
  return values;
}

export class ScrapeResult {
  readonly statusCode: number;
  /** Header name (lowercase) -> value; repeated headers are joined with ", ". See headerValues(). */
  readonly headers: Record<string, string>;
  /** The scraped target URL; "" for a plugin result. */
  readonly url: string;
  readonly #content: Uint8Array;
  readonly #values: Map<string, string[]>;
  #text?: string;

  constructor(init: ScrapeResultInit) {
    this.#content = init.content;
    this.statusCode = init.statusCode;
    this.#values = collectHeaders(init.headers);
    this.headers = {};
    for (const [k, v] of this.#values) this.headers[k] = v.join(", ");
    this.url = init.url;
  }

  /** Every value of a header, in order (e.g. each Set-Cookie line); [] when absent. */
  headerValues(name: string): string[] {
    return [...(this.#values.get(name.toLowerCase()) ?? [])];
  }

  /**
   * Scrape.do-Request-Cost, the authoritative charge: one value of ASCII digits
   * (spaces and tabs trimmed) of at most 2^53-1, else undefined.
   */
  get cost(): number | undefined {
    return parseRequestCost(this.headers["scrape.do-request-cost"]);
  }

  get remainingCredits(): number | undefined {
    const raw = this.headers["scrape.do-remaining-credits"];
    return raw && /^-?\d+$/.test(raw) ? Number(raw) : undefined;
  }

  /** The upstream target's own status code before any gateway retry/normalization. */
  get initialStatusCode(): number | undefined {
    const raw = this.headers["scrape.do-initial-status-code"];
    return raw && /^\d+$/.test(raw) ? Number(raw) : undefined;
  }

  /** The originally requested target URL, as echoed by the gateway. */
  get targetUrl(): string | undefined {
    return this.headers["scrape.do-target-url"];
  }

  /**
   * The Location the target answered with when redirects were not followed
   * (disableRedirection), from Scrape.do-Target-Redirected-Location.
   */
  get targetRedirectedLocation(): string | undefined {
    return this.headers["scrape.do-target-redirected-location"];
  }

  /** The final URL after redirects were followed. */
  get resolvedUrl(): string | undefined {
    return this.headers["scrape.do-resolved-url"];
  }

  /** The cookies the gateway captured for the session. */
  get cookies(): string | undefined {
    return this.headers["scrape.do-cookies"];
  }

  get contentType(): string | undefined {
    return this.headers["content-type"];
  }

  /** The raw, decompressed payload (transparent decompression). */
  bytes(): Uint8Array {
    return this.#content;
  }

  /** The body as text, decoded with the WHATWG ladder (BOM, charset label, JSON, <meta>, UTF-8). */
  get text(): string {
    this.#text ??= decodeText(this.#content, this.contentType);
    return this.#text;
  }

  /**
   * The body parsed as JSON: UTF-8 (invalid bytes become U+FFFD, a leading BOM
   * is ignored). NaN, Infinity, a number that overflows a double, an empty body
   * or trailing text throw SdoTransportError.
   */
  json<T = unknown>(): T {
    return parseJsonBody(this.#content, "The response body") as T;
  }

  /**
   * A cheerio API loaded with `text`, for CSS extraction. Needs the optional
   * peer dependency `cheerio`. Its type is not referenced here (so the SDK's
   * types compile without cheerio installed); name it where you use it:
   * `const $ = await result.selector<CheerioAPI>()` with
   * `import type { CheerioAPI } from "cheerio"`.
   */
  async selector<T = unknown>(): Promise<T> {
    let cheerio: { load(html: string): unknown };
    try {
      cheerio = (await import("cheerio")) as { load(html: string): unknown };
    } catch (e) {
      throw new SdoConfigError("selector() needs the optional peer dependency 'cheerio': npm install cheerio", {
        cause: sanitizeCause(e),
      });
    }
    return cheerio.load(this.text) as T;
  }
}
