// SPDX-License-Identifier: Apache-2.0
// Security invariants. These are fixtures, not smoke tests: each one pins a
// guarantee that would otherwise only be checked by reading the code.
import { inspect } from "node:util";
import { describe, expect, it, vi } from "vitest";
import { Client } from "../src/client.js";
import {
  SdoApiError,
  SdoConfigError,
  SdoConnectionError,
  SdoResponseTooLargeError,
  SdoTimeoutError,
} from "../src/errors.js";
import { contentCodings } from "../src/decompress.js";
import { resolveLabel, sniffEncoding } from "../src/decoding.js";
import { parseRetryAfter, readCapped } from "../src/transport.js";
import { VERSION } from "../src/version.js";
import { header, mockFetch, stalledBody } from "./helpers.js";

const TOKEN = "SUPERSECRET/TOKEN+1";
const ENCODED = "SUPERSECRET%2FTOKEN%2B1";

/** Everything a caller could plausibly log from a thrown error. */
function allText(e: unknown): string {
  const err = e as Error & { body?: string };
  return [inspect(err, { depth: 10 }), err.message, err.stack, err.body ?? "", JSON.stringify(err)].join(" ");
}

describe("token redaction", () => {
  it("keeps the token out of transport errors, their stack and their cause chain", async () => {
    const fetchImpl = mockFetch(() => {
      const inner = new Error(`connect ECONNREFUSED for ?token=${ENCODED}`);
      throw new TypeError(`fetch failed: https://api.scrape.do/?token=${TOKEN}&url=x`, { cause: inner });
    });
    const client = new Client({ token: TOKEN, retries: 0, fetchImpl });
    const err = await client.scrape("https://e.com").catch((e) => e);
    expect(err).toBeInstanceOf(SdoConnectionError);
    expect(err.cause).toBeInstanceOf(Error);
    expect(allText(err)).not.toContain(TOKEN);
    expect(allText(err)).not.toContain(ENCODED);
    expect(allText(err)).not.toContain("SUPERSECRET");
  });

  it("keeps an echoed token out of API error messages and retained bodies", async () => {
    const body = JSON.stringify({
      Message: [`Invalid token ${TOKEN}`, `see ?x=${ENCODED}`],
      Request: { token: TOKEN, headers: `X-Token: ${TOKEN}` },
    });
    const fetchImpl = mockFetch(() => new Response(body, { status: 401 }));
    const err = await new Client({ token: TOKEN, retries: 0, fetchImpl }).scrape("https://e.com").catch((e) => e);
    expect(err).toBeInstanceOf(SdoApiError);
    expect(err.message).toBe("Invalid token ***; see ?x=***");
    expect(allText(err)).not.toContain("SUPERSECRET");
  });

  it("keeps the token out of async-API errors and JSON decode failures", async () => {
    const f = mockFetch((_u, _i, i) =>
      i === 0
        ? new Response(`{"Error":"bad X-Token: ${TOKEN}"}`, { status: 403 })
        : new Response(`{"token": "${TOKEN}", oops`, { status: 200 }),
    );
    const jobs = new Client({ token: TOKEN, retries: 0, fetchImpl: f }).jobs;
    const apiErr = await jobs.me().catch((e) => e);
    expect(apiErr.message).toBe("bad X-Token: ***");
    const decodeErr = await jobs.me().catch((e) => e);
    expect(allText(apiErr) + allText(decodeErr)).not.toContain("SUPERSECRET");
  });

  it("never prints the token when a client is logged or serialized", () => {
    const client = new Client({ token: TOKEN });
    const views = [
      inspect(client, { depth: 10, showHidden: true }),
      inspect(client.jobs, { depth: 10, showHidden: true }),
      JSON.stringify(client),
      JSON.stringify(client.jobs),
      String(client),
    ];
    for (const view of views) expect(view).not.toContain("SUPERSECRET");
  });
});

describe("base URLs carry the token only over https", () => {
  for (const baseUrl of ["http://api.scrape.do", "http://localhost.evil.com", "ftp://x", "api.scrape.do"]) {
    it(`rejects ${baseUrl}`, () => {
      expect(() => new Client({ token: TOKEN, baseUrl })).toThrow(SdoConfigError);
      vi.stubEnv("SDO_ASYNC_BASE_URL", baseUrl);
      expect(() => new Client({ token: TOKEN })).toThrow(SdoConfigError);
    });
  }

  it("rejects a base URL with credentials, a query or a fragment", () => {
    for (const baseUrl of ["https://u:p@h.test", "https://h.test/?a=1", "https://h.test/#x"]) {
      expect(() => new Client({ token: TOKEN, baseUrl })).toThrow(SdoConfigError);
    }
  });

  it("keeps a path prefix on both bases", async () => {
    const f = mockFetch(() => new Response("{}", { headers: { "content-type": "application/json" } }));
    const client = new Client({
      token: TOKEN,
      baseUrl: "https://gw.test/prefix/",
      asyncBaseUrl: "https://gw.test/qprefix",
      fetchImpl: f,
    });
    await client.scrape("https://e.com");
    await client.plugin("google/search");
    await client.jobs.me();
    expect(f.calls.map((c) => c.url.split("?")[0])).toEqual([
      "https://gw.test/prefix/",
      "https://gw.test/prefix/plugin/google/search",
      "https://gw.test/qprefix/api/v1/me",
    ]);
  });
});

describe("the async API never follows a redirect", () => {
  it("raises on a cross-origin 302 and sends X-Token nowhere else", async () => {
    const f = mockFetch(
      () => new Response(null, { status: 302, headers: { location: "https://evil.test/steal" } }),
    );
    const err = await new Client({ token: TOKEN, retries: 2, fetchImpl: f }).jobs.list().catch((e) => e);
    expect(err).toBeInstanceOf(SdoApiError);
    expect(err.statusCode).toBe(302);
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]!.init?.redirect).toBe("manual");
    expect(new URL(f.calls[0]!.url).origin).toBe("https://q.scrape.do");
    expect(header(f.calls[0]!.init, "x-token")).toBe(TOKEN);
  });

  it("rejects ids that would reshape the path before any request", async () => {
    const f = mockFetch(() => new Response("{}"));
    const jobs = new Client({ token: TOKEN, fetchImpl: f }).jobs;
    for (const id of ["../me", "a?b", "a#b", "%2e%2e", "a/b"]) {
      await expect(jobs.cancel(id)).rejects.toBeInstanceOf(SdoConfigError);
    }
    expect(f.calls).toHaveLength(0);
  });
});

describe("bounded reads on every path", () => {
  const big = () => new Uint8Array(4 * 1024 * 1024);

  it("refuses a scrape body past the ceiling", async () => {
    const fetchImpl = mockFetch(() => new Response(big(), { status: 200 }));
    const client = new Client({ token: TOKEN, retries: 0, maxResponseBytes: 1024 * 1024, fetchImpl });
    await expect(client.scrape("https://e.com")).rejects.toBeInstanceOf(SdoResponseTooLargeError);
  });

  it("refuses an async job result past the ceiling", async () => {
    const fetchImpl = mockFetch(() => new Response(big(), { status: 200 }));
    const client = new Client({ token: TOKEN, retries: 0, maxResponseBytes: 1024 * 1024, fetchImpl });
    await expect(client.jobs.result("j", "t")).rejects.toBeInstanceOf(SdoResponseTooLargeError);
  });

  it("reads only a bounded prefix of an error body and still reports the status", async () => {
    let pulled = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(c) {
        pulled += 1;
        c.enqueue(new Uint8Array(16 * 1024).fill(0x78));
      },
    });
    const f = mockFetch(() => new Response(body, { status: 500 }));
    const err = await new Client({ token: TOKEN, retries: 0, fetchImpl: f }).scrape("https://e.com").catch((e) => e);
    expect(err.statusCode).toBe(500);
    expect(err.body).toHaveLength(2048);
    expect(pulled).toBeLessThan(10);
  });

  it("still returns a body under the ceiling", async () => {
    const payload = new TextEncoder().encode("<html>ok</html>");
    const fetchImpl = mockFetch(() => new Response(payload, { status: 200 }));
    const client = new Client({ token: TOKEN, retries: 0, maxResponseBytes: 1024 * 1024, fetchImpl });
    expect((await client.scrape("https://e.com")).bytes()).toEqual(payload);
  });

  it("aborts a stream mid-flight rather than buffering it all", async () => {
    let chunksPulled = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        chunksPulled += 1;
        controller.enqueue(new Uint8Array(64 * 1024));
      },
    });
    const stream = body as unknown as AsyncIterable<Uint8Array>;
    await expect(readCapped(stream, 256 * 1024)).rejects.toBeInstanceOf(SdoResponseTooLargeError);
    expect(chunksPulled).toBeLessThan(16);
  });
});

describe("the timeout is a total deadline", () => {
  const stalled = () => mockFetch(() => new Response(stalledBody(), { status: 200 }));

  it("covers a scrape body that stops arriving after the headers", async () => {
    const client = new Client({ token: TOKEN, retries: 0, timeoutMs: 50, fetchImpl: stalled() });
    await expect(client.scrape("https://e.com")).rejects.toBeInstanceOf(SdoTimeoutError);
  });

  it("covers an async job body that stops arriving", async () => {
    const client = new Client({ token: TOKEN, retries: 0, timeoutMs: 50, fetchImpl: stalled() });
    await expect(client.jobs.me()).rejects.toBeInstanceOf(SdoTimeoutError);
  });
});

describe("connections are released", () => {
  function tracked(status: number, headers: Record<string, string> = {}) {
    const cancelled: number[] = [];
    const f = mockFetch((_u, _i, i) => {
      const body = new ReadableStream<Uint8Array>({
        pull(c) {
          c.enqueue(new Uint8Array(1024));
        },
        cancel() {
          cancelled.push(i);
        },
      });
      return new Response(body, { status, headers });
    });
    return { f, cancelled };
  }

  it("cancels the body of a response that is retried", async () => {
    const { f, cancelled } = tracked(503);
    await new Client({ token: TOKEN, retries: 2, backoffMs: 0, maxResponseBytes: 4096, fetchImpl: f })
      .scrape("https://e.com")
      .catch(() => undefined);
    expect(f.calls).toHaveLength(3);
    await vi.waitFor(() => expect(cancelled).toEqual([0, 1, 2]));
  });

  it("cancels a body that crosses the ceiling", async () => {
    const { f, cancelled } = tracked(200);
    const client = new Client({ token: TOKEN, retries: 0, maxResponseBytes: 4096, fetchImpl: f });
    await expect(client.scrape("https://e.com")).rejects.toBeInstanceOf(SdoResponseTooLargeError);
    await vi.waitFor(() => expect(cancelled).toEqual([0]));
  });
});

describe("plugin route validation", () => {
  for (const route of ["../", "..%2f..", "x#", "x?token=evil", "a/../b", "Google/Shopping", "", "/google/x"]) {
    it(`rejects ${JSON.stringify(route)} before any request`, async () => {
      const fetchImpl = mockFetch(() => new Response("{}", { status: 200 }));
      const client = new Client({ token: TOKEN, retries: 0, fetchImpl });
      await expect(client.plugin(route, { q: "1" })).rejects.toBeInstanceOf(SdoConfigError);
      expect(fetchImpl.calls).toHaveLength(0);
    });
  }
});

describe("parameter names", () => {
  const BAD = ["a&token=x", "x y", "q[]", "1abc", "_x", "a=b", "a\nb", "\u00e9t\u00e9", "a%26b"];

  for (const key of BAD) {
    it(`rejects extraParams key ${JSON.stringify(key)} before any request`, async () => {
      const fetchImpl = mockFetch(() => new Response("ok"));
      const client = new Client({ token: TOKEN, retries: 0, fetchImpl });
      await expect(client.scrape("https://e.com", { extraParams: { [key]: "1" } })).rejects.toThrow(
        /extraParams key .* is not a valid parameter name/,
      );
      expect(fetchImpl.calls).toHaveLength(0);
    });

    it(`rejects plugin parameter ${JSON.stringify(key)} before any request`, async () => {
      const fetchImpl = mockFetch(() => new Response("{}"));
      const client = new Client({ token: TOKEN, retries: 0, fetchImpl });
      await expect(client.plugin("google/search", { [key]: "1" })).rejects.toThrow(/is not a valid parameter name/);
      expect(fetchImpl.calls).toHaveLength(0);
    });
  }

  it("accepts the documented shapes", async () => {
    const fetchImpl = mockFetch(() => new Response("{}"));
    const client = new Client({ token: TOKEN, retries: 0, fetchImpl });
    await client.scrape("https://e.com", { extraParams: { brandNewParam: "1", "a.b-c_d": "2" } });
    await client.plugin("google/search", { q: "x", hl: "en", include_airlines: "TK", "x.y-z": 1 });
    expect(fetchImpl.calls).toHaveLength(2);
  });
});

describe("target-controlled headers are trimmed in linear time", () => {
  // "x" + 64 KiB of spaces + "x": an alternation like /^[ \t]+|[ \t]+$/g
  // rescans the run from every position and took seconds here.
  const pad = " ".repeat(64 * 1024);
  const inner = `x${pad}x`;
  const cases: Array<[string, () => unknown]> = [
    ["Retry-After", () => parseRetryAfter(inner)],
    ["Content-Encoding", () => contentCodings(`gzip,${inner}`)],
    ["Content-Type essence", () => sniffEncoding(new Uint8Array(), `text/html${inner}`)],
    ["Content-Type charset", () => sniffEncoding(new Uint8Array(), `text/html; charset=${inner}`)],
    ["charset label", () => resolveLabel(inner)],
  ];
  for (const [name, run] of cases) {
    it(name, () => {
      const t0 = performance.now();
      run();
      expect(performance.now() - t0).toBeLessThan(50);
    });
  }

  it("still trims", () => {
    expect(parseRetryAfter(` \t7${pad}`)).toBe(7);
    expect(contentCodings(` gzip${pad}, \tbr `)).toEqual(["br", "gzip"]);
    expect(resolveLabel(`${pad}latin1\f`)).toBe("windows-1252");
    expect(sniffEncoding(new Uint8Array(), `text/plain; charset=latin1${pad}`).encoding).toBe("windows-1252");
  });
});

describe("User-Agent", () => {
  it("carries no suffix beyond the version", async () => {
    // No OS, no runtime version: anything appended is client fingerprinting.
    const fetchImpl = mockFetch(() => new Response("ok"));
    await new Client({ token: TOKEN, retries: 0, fetchImpl }).scrape("https://e.com");
    expect(header(fetchImpl.calls[0]!.init, "user-agent")).toBe(`sdo-sdk-js/${VERSION}`);
  });
});
