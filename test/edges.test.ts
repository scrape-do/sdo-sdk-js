// SPDX-License-Identifier: Apache-2.0
// Behaviours at the edges of the client: entry-point exports, option
// resolution, error-shape fallbacks, and failure paths a happy-path suite
// never reaches.
import zlib from "node:zlib";
import type { CheerioAPI } from "cheerio";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as sdo from "../src/index.js";
import { Client } from "../src/client.js";
import { decodeBody } from "../src/decompress.js";
import {
  SdoAbortError,
  SdoApiError,
  SdoConnectionError,
  SdoGatewayError,
  SdoResponseTooLargeError,
  SdoTimeoutError,
  asyncEnvelopeMessage,
  redactSecrets,
  sanitizeCause,
  syncEnvelopeMessage,
} from "../src/errors.js";
import { ScrapeResult } from "../src/response.js";
import { nodeSend } from "../src/http.js";
import { readCapped } from "../src/transport.js";
import { mockFetch } from "./helpers.js";
import { withServer } from "./server.js";

async function* chunks(...parts: Uint8Array[]): AsyncGenerator<Uint8Array> {
  yield* parts;
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("package entry point", () => {
  it("exports the documented public surface", () => {
    for (const name of [
      "Client", "ScrapeConfig", "ScrapeResult", "TaskResult", "VERSION", "redactSecrets",
      "SdoError", "SdoConfigError", "SdoTransportError", "SdoConnectionError", "SdoTimeoutError",
      "SdoResponseTooLargeError", "SdoAbortError", "SdoApiError", "SdoAuthError", "SdoValidationError",
      "SdoConcurrencyError", "SdoGatewayError",
    ]) {
      expect(sdo, name).toHaveProperty(name);
    }
    expect(sdo).not.toHaveProperty("SdoQuotaError"); // there is no 402 tier
    // AsyncJobs is a type: the only way to get one is client.jobs.
    expect(sdo).not.toHaveProperty("AsyncJobs");
  });
});

describe("client option resolution", () => {
  it("accepts a bare token string", async () => {
    expect(new Client("tok").baseUrl).toBe("https://api.scrape.do");
    await withServer(
      (_req, res) => void res.end("ok"),
      async (server) => {
        vi.stubEnv("SDO_BASE_URL", server.url);
        await new Client("tok").scrape("https://e.com");
        expect(server.requests[0]!.url.startsWith("/?token=tok&")).toBe(true);
      },
    );
  });

  it("treats null options as none, reading the token from SDO_TOKEN", () => {
    expect(() => new Client(null as never)).toThrow("No token provided");
    vi.stubEnv("SDO_TOKEN", "env-token");
    expect(new Client(null as never).baseUrl).toBe("https://api.scrape.do");
  });

  it("reads SDO_TIMEOUT (seconds) when no timeout is passed", async () => {
    vi.stubEnv("SDO_TIMEOUT", "0.05");
    const f = mockFetch(
      (_u, init) =>
        new Promise((_, reject) =>
          init!.signal!.addEventListener("abort", () =>
            reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
          ),
        ),
    );
    const c = new Client({ token: "t", retries: 0, fetchImpl: f });
    await expect(c.scrape("https://e.com")).rejects.toBeInstanceOf(SdoTimeoutError);
  });

  it("clamps a negative retry count so the request is still sent once", async () => {
    const f = mockFetch(() => new Response(null, { status: 503 }));
    const c = new Client({ token: "t", retries: -3, backoffMs: 0, fetchImpl: f });
    await expect(c.scrape("https://e.com")).rejects.toBeInstanceOf(SdoGatewayError);
    expect(f.calls).toHaveLength(1);
  });

  it("uses node:http, never the global fetch, when no fetch is injected", async () => {
    const f = mockFetch(() => new Response("from global"));
    vi.stubGlobal("fetch", f);
    await withServer(
      (req, res) => void res.end(req.url.startsWith("/api/v1/") ? '{"Jobs":[]}' : "from node"),
      async (server) => {
        const c = new Client({ token: "t", retries: 0, baseUrl: server.url, asyncBaseUrl: server.url });
        expect(new TextDecoder().decode((await c.scrape("https://e.com")).bytes())).toBe("from node");
        expect((await c.jobs.list()).jobs).toEqual([]); // jobs use the same transport
        expect(server.requests).toHaveLength(2);
      },
    );
    expect(f.calls).toHaveLength(0);
  });
});

describe("transport failure paths", () => {
  it("retries a fetch failure whose code says nothing was sent, then succeeds", async () => {
    let n = 0;
    const f = mockFetch(() => {
      n += 1;
      if (n === 1) throw new TypeError("fetch failed", { cause: Object.assign(new Error("refused"), { code: "ECONNREFUSED" }) });
      return new Response("ok");
    });
    const c = new Client({ token: "t", retries: 1, backoffMs: 0, fetchImpl: f });
    expect(new TextDecoder().decode((await c.scrape("https://e.com")).bytes())).toBe("ok");
    expect(f.calls).toHaveLength(2);
  });

  it("does not retry a fetch failure that may have reached the server", async () => {
    const f = mockFetch(() => {
      throw new TypeError("fetch failed", { cause: Object.assign(new Error("reset"), { code: "ECONNRESET" }) });
    });
    const c = new Client({ token: "t", retries: 2, backoffMs: 0, fetchImpl: f });
    await expect(c.scrape("https://e.com")).rejects.toThrow("Connection failed: fetch failed");
    expect(f.calls).toHaveLength(1);
  });

  it("maps an unknown 4xx to a generic SdoApiError", async () => {
    const f = mockFetch(() => new Response(null, { status: 418 }));
    const err = await new Client({ token: "t", retries: 0, fetchImpl: f }).scrape("https://e.com").catch((e) => e);
    expect(err).toBeInstanceOf(SdoApiError);
    expect(err.constructor).toBe(SdoApiError);
    expect(err.message).toContain("HTTP 418");
  });

  it("ignores a non-numeric Retry-After and falls back to backoff", async () => {
    const f = mockFetch((_u, _i, i) =>
      i === 0 ? new Response(null, { status: 503, headers: { "retry-after": "soon" } }) : new Response("ok"),
    );
    const res = await new Client({ token: "t", retries: 1, backoffMs: 0, fetchImpl: f }).scrape("https://e.com");
    expect(res.statusCode).toBe(200);
  });

  it("keeps the error body undefined when it cannot be read", async () => {
    const body = new ReadableStream({ start(c) { c.error(new Error("socket reset")); } });
    const f = mockFetch(() => new Response(body, { status: 400 }));
    const err = await new Client({ token: "t", retries: 0, fetchImpl: f }).scrape("https://e.com").catch((e) => e);
    expect(err.statusCode).toBe(400);
    expect(err.body).toBeUndefined();
  });

  it("caps a body at exactly its limit", async () => {
    const body = () => chunks(new Uint8Array(32), new Uint8Array(32));
    await expect(readCapped(body(), 63)).rejects.toBeInstanceOf(SdoResponseTooLargeError);
    expect(await readCapped(body(), 64)).toMatchObject({ truncated: false });
    expect((await readCapped(body(), 64)).bytes).toHaveLength(64);
    expect(await readCapped(body(), 40, { truncate: true })).toMatchObject({ truncated: true });
  });

  it("does not retry a fetch that resolves to something other than a Response", async () => {
    // The failure comes after the call returned, so the request may have left.
    const f = mockFetch(() => undefined as unknown as Response);
    const err = await new Client({ token: "t", retries: 2, backoffMs: 0, fetchImpl: f }).scrape("https://e.com").catch((e) => e);
    expect(err).toBeInstanceOf(SdoConnectionError);
    expect(f.calls).toHaveLength(1);
  });

  it("stops before the backoff wait when the signal aborted while the response arrived", async () => {
    // A minute of backoff: the test times out if the wait does not check the signal first.
    const ac = new AbortController();
    const f = mockFetch(() => {
      ac.abort(new Error("stop"));
      return new Response(null, { status: 503 });
    });
    const c = new Client({ token: "t", retries: 1, backoffMs: 60_000, fetchImpl: f });
    await expect(c.scrape("https://e.com", { signal: ac.signal })).rejects.toBeInstanceOf(SdoAbortError);
    expect(f.calls).toHaveLength(1);
  });

  it("reports the size limit even when the source then fails to close", async () => {
    let closed = 0;
    const source = {
      [Symbol.asyncIterator]: () => ({
        next: async () => ({ done: false as const, value: new Uint8Array(16) }),
        return: async (): Promise<IteratorResult<Uint8Array>> => {
          closed += 1;
          throw new Error("close failed");
        },
      }),
    };
    await expect(readCapped(source, 8)).rejects.toBeInstanceOf(SdoResponseTooLargeError);
    expect(closed).toBe(1);
  });

  it("decodes a compressed body that arrives in many chunks", async () => {
    const packed = zlib.gzipSync("hello, chunked world");
    const pieces = Array.from({ length: packed.length }, (_, i) => packed.subarray(i, i + 1));
    const out = await readCapped(decodeBody(chunks(...pieces), ["gzip"], 1024), 1024);
    expect(new TextDecoder().decode(out.bytes)).toBe("hello, chunked world");
  });

  it("node:http requests \"/\" for a URL with no path", () =>
    withServer(
      (_req, res) => void res.end("ok"),
      async (server) => {
        const ex = await nodeSend({ method: "GET", url: server.url, headers: {}, signal: new AbortController().signal });
        for await (const _ of ex.body);
        expect(ex.status).toBe(200);
        expect(server.requests[0]!.url).toBe("/");
      },
    ));

  it("reads a fetch response without a body as empty", async () => {
    const f = mockFetch(() => new Response(null, { status: 200 }));
    const r = await new Client({ token: "t", retries: 0, fetchImpl: f }).scrape("https://e.com");
    expect(r.bytes()).toHaveLength(0);
  });
});

describe("error envelope parsing", () => {
  it("reads a sync Message string or list of strings, keyed exactly", () => {
    expect(syncEnvelopeMessage(undefined)).toBeUndefined();
    expect(syncEnvelopeMessage("not json")).toBeUndefined();
    expect(syncEnvelopeMessage("null")).toBeUndefined();
    expect(syncEnvelopeMessage('{"Message":[]}')).toBeUndefined();
    expect(syncEnvelopeMessage('{"Message":[1,2]}')).toBeUndefined();
    expect(syncEnvelopeMessage('{"Message":""}')).toBeUndefined();
    expect(syncEnvelopeMessage('{"Message":{"a":1}}')).toBeUndefined();
    expect(syncEnvelopeMessage('{"other":1}')).toBeUndefined();
    expect(syncEnvelopeMessage('{"Message":["a","b"]}')).toBe("a; b");
    // Empty strings are no message; a leading BOM is not part of the JSON.
    expect(syncEnvelopeMessage('{"Message":["a","","b"]}')).toBe("a; b");
    expect(syncEnvelopeMessage('\ufeff{"Message":"bom"}')).toBe("bom");
  });

  it("reads an async Error string", () => {
    expect(asyncEnvelopeMessage('{"Error":"gone","Code":404}')).toBe("gone");
    expect(asyncEnvelopeMessage('{"Error":""}')).toBeUndefined();
    expect(asyncEnvelopeMessage('{"Error":5}')).toBeUndefined();
    expect(asyncEnvelopeMessage('{"Message":"sync shape"}')).toBeUndefined();
    expect(asyncEnvelopeMessage("[]")).toBeUndefined();
  });

  it("defaults billed and retryable to false", () => {
    const e = new SdoApiError("x", { statusCode: 500 });
    expect(e.billed).toBe(false);
    expect(e.isRetryable).toBe(false);
  });
});

describe("response edge cases", () => {
  const make = (headers: Record<string, string>, body = "x") =>
    new ScrapeResult({ content: new TextEncoder().encode(body), statusCode: 200, headers, url: "u" });

  it("rejects malformed metadata values", () => {
    const r = make({
      "scrape.do-request-cost": "abc",
      "scrape.do-remaining-credits": "",
    });
    expect(r.cost).toBeUndefined();
    expect(r.remainingCredits).toBeUndefined();
  });

  it("treats an empty quoted charset as absent", () => {
    const r = make({ "content-type": 'text/html; charset=""' }, "héllo");
    expect(r.text).toBe("héllo");
  });

  it("builds a cheerio selector over the decoded text", async () => {
    const $ = await make({ "content-type": "text/html" }, "<p class='a'>hi</p>").selector<CheerioAPI>();
    expect($("p.a").text()).toBe("hi");
  });
});

describe("async job responses with fields omitted", () => {
  const jobsClient = (payload: unknown, status = 200) =>
    new Client({
      token: "t",
      retries: 0,
      fetchImpl: mockFetch(
        () => new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } }),
      ),
    }).jobs;

  it("defaults absent arrays and flags instead of returning undefined", async () => {
    expect((await jobsClient({ JobID: "j" }).create(["https://e.com"])).taskIds).toEqual([]);
    const st = await jobsClient({ JobID: "j", Status: "queued" }).status("j");
    expect(st.taskIds).toEqual([]);
    expect(st.canceled).toBe(false);
    expect(st.tasks).toEqual([]);
    expect((await jobsClient({}).list()).jobs).toEqual([]);
  });

  it("surfaces a failed cancel as a typed error with the envelope message", async () => {
    const err = await jobsClient({ Error: "job not found", Code: 404 }, 404).cancel("j").catch((e) => e);
    expect(err).toBeInstanceOf(SdoApiError);
    expect(err.message).toBe("job not found");
  });
});

describe("plugin edge cases", () => {
  it("rejects a missing route", async () => {
    const f = mockFetch(() => new Response("{}"));
    const c = new Client({ token: "t", retries: 0, fetchImpl: f });
    await expect(c.plugin(undefined as unknown as string)).rejects.toThrow("Invalid plugin route");
    expect(f.calls).toHaveLength(0);
  });

  it("returns a pluginResult without a content type as raw bytes", async () => {
    const f = mockFetch(() => new Response(new Uint8Array([1, 2, 3]), { headers: { "scrape.do-request-cost": "2" } }));
    const res = await new Client({ token: "t", retries: 0, fetchImpl: f }).pluginResult("google/shopping");
    expect(res.contentType).toBeUndefined();
    expect(res.bytes()).toEqual(new Uint8Array([1, 2, 3]));
    expect(res.cost).toBe(2);
  });

  it("forwards an explicit false and returns bytes when there is no content type", async () => {
    const f = mockFetch(() => new Response(new Uint8Array([1, 2, 3])));
    const c = new Client({ token: "t", retries: 0, fetchImpl: f });
    const out = await c.plugin("google/shopping", { safe: false, skip: null });
    expect(new URL(f.calls[0]!.url).searchParams.get("safe")).toBe("false");
    expect(new URL(f.calls[0]!.url).searchParams.has("skip")).toBe(false);
    expect(out).toEqual(new Uint8Array([1, 2, 3]));
  });
});

describe("remaining small contracts", () => {
  it("treats null ScrapeConfig options as none", () => {
    expect(new sdo.ScrapeConfig("https://e.com", null as never).toParams()).toEqual([["url", "https://e.com"]]);
  });

  it("skips null and undefined extraParams values", () => {
    const params = new sdo.ScrapeConfig("https://e.com", { extraParams: { a: null, b: undefined, c: "1" } }).toParams();
    expect(params).toEqual([["url", "https://e.com"], ["c", "1"]]);
  });

  it("decodes a body with no content type as UTF-8", () => {
    const r = new ScrapeResult({ content: new TextEncoder().encode("héllo"), statusCode: 200, headers: {}, url: "u" });
    expect(r.text).toBe("héllo");
  });

  it("parses remaining credits on a 429 only when numeric", async () => {
    const mk = (credits?: string) =>
      new Client({
        token: "t",
        retries: 0,
        fetchImpl: mockFetch(
          () =>
            new Response(null, {
              status: 429,
              headers: credits === undefined ? {} : { "scrape.do-remaining-credits": credits },
            }),
        ),
      })
        .scrape("https://e.com")
        .catch((e) => e);
    expect((await mk("12")).remainingCredits).toBe(12);
    expect((await mk("lots")).remainingCredits).toBeUndefined();
    expect((await mk()).remainingCredits).toBeUndefined();
  });

  it("explains how to install cheerio when it is missing", async () => {
    vi.resetModules();
    vi.doMock("cheerio", () => {
      throw new Error("Cannot find module 'cheerio'");
    });
    const { ScrapeResult: Fresh } = await import("../src/response.js");
    const { SdoConfigError: FreshConfigError } = await import("../src/errors.js");
    const r = new Fresh({ content: new Uint8Array(), statusCode: 200, headers: {}, url: "u" });
    const err = await r.selector().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FreshConfigError);
    expect((err as Error).message).toContain("npm install cheerio");
    vi.doUnmock("cheerio");
  });
});

describe("redaction helpers", () => {
  it("copies a cause without the token, keeping its name, code and a bounded chain", () => {
    const deep = new Error("level 4 TOKEN-12345");
    let chain: Error = deep;
    for (let i = 3; i >= 0; i--) chain = Object.assign(new Error(`level ${i} TOKEN-12345`, { cause: chain }), { code: `E${i}` });
    const copy = sanitizeCause(chain, "TOKEN-12345");
    expect(copy.message).toBe("level 0 ***");
    expect((copy as Error & { code?: string }).code).toBe("E0");
    let depth = 0;
    for (let c: unknown = copy; c instanceof Error; c = c.cause) depth += 1;
    expect(depth).toBe(4);
    expect(sanitizeCause("plain token=abc").message).toBe("plain token=***");
    const noStack = new Error("x");
    noStack.stack = undefined;
    expect(sanitizeCause(noStack).stack).toBeUndefined();
  });

  it("still masks a token that cannot be URI-encoded", () => {
    const token = "abc\uD800defgh";
    expect(redactSecrets(`x ${token} y`, token)).toBe("x *** y");
  });
});
