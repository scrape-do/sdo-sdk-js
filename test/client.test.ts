// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from "vitest";
import { Client } from "../src/client.js";
import { ScrapeConfig } from "../src/config.js";
import { SdoConfigError } from "../src/errors.js";
import { header, mockFetch, params } from "./helpers.js";

describe("Client", () => {
  it("builds the request and result", async () => {
    const fetchImpl = mockFetch(
      () =>
        new Response("<html>ok</html>", {
          status: 200,
          headers: { "Scrape.do-Request-Cost": "5", "Content-Type": "text/html" },
        }),
    );
    const client = new Client({ token: "TKN", fetchImpl });
    const result = await client.scrape("https://example.com", { render: true, geoCode: "us" });

    expect(result.statusCode).toBe(200);
    expect(result.text).toContain("ok");
    expect(result.cost).toBe(5);

    const init = fetchImpl.calls[0]!.init;
    expect(header(init, "Accept-Encoding")).toBe("gzip, deflate, br");
    expect(header(init, "User-Agent")).toMatch(/^sdo-sdk-js\//);
    const p = params(fetchImpl.calls[0]!.url);
    expect(p.get("token")).toBe("TKN");
    expect(p.get("url")).toBe("https://example.com");
    expect(p.get("render")).toBe("true");
    expect(p.get("geoCode")).toBe("us");
  });

  it("accepts a ScrapeConfig", async () => {
    const fetchImpl = mockFetch(() => new Response("x", { status: 200 }));
    const client = new Client({ token: "t", fetchImpl });
    await client.scrape(new ScrapeConfig("https://e.com", { superProxy: true }));
    expect(params(fetchImpl.calls[0]!.url).get("super")).toBe("true");
  });

  it("prefers the explicit token over the env var", async () => {
    vi.stubEnv("SDO_TOKEN", "envtok");
    const fetchImpl = mockFetch(() => new Response("x", { status: 200 }));
    const client = new Client({ token: "paramtok", fetchImpl });
    await client.scrape("https://e.com");
    expect(params(fetchImpl.calls[0]!.url).get("token")).toBe("paramtok");
  });

  it("uses the env token when none is passed", async () => {
    vi.stubEnv("SDO_TOKEN", "envtok");
    const fetchImpl = mockFetch(() => new Response("x", { status: 200 }));
    const client = new Client({ fetchImpl });
    await client.scrape("https://e.com");
    expect(params(fetchImpl.calls[0]!.url).get("token")).toBe("envtok");
  });

  it("trims surrounding ASCII whitespace from the token", async () => {
    const fetchImpl = mockFetch(() => new Response("x", { status: 200 }));
    const client = new Client({ token: " \t\n\v\f\rTKN\r\n ", fetchImpl });
    await client.scrape("https://e.com");
    expect(params(fetchImpl.calls[0]!.url).get("token")).toBe("TKN");
  });

  it("treats a whitespace-only token as not given", async () => {
    vi.stubEnv("SDO_TOKEN", "envtok");
    const fetchImpl = mockFetch(() => new Response("x", { status: 200 }));
    const client = new Client({ token: " \t\r\n", fetchImpl });
    await client.scrape("https://e.com");
    expect(params(fetchImpl.calls[0]!.url).get("token")).toBe("envtok");
  });

  it("rejects a long inner whitespace run quickly", () => {
    const started = Date.now();
    expect(() => new Client({ token: `a${"\t".repeat(200_000)}a` })).toThrow(SdoConfigError);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("throws when no token is available", () => {
    expect(() => new Client()).toThrow(SdoConfigError);
  });

  it("preferBrotli advertises br alone", async () => {
    const fetchImpl = mockFetch(() => new Response("x", { status: 200 }));
    const client = new Client({ token: "t", preferBrotli: true, fetchImpl });
    await client.scrape("https://e.com");
    expect(header(fetchImpl.calls[0]!.init, "Accept-Encoding")).toBe("br");
  });

  it("honors a base url override", async () => {
    const fetchImpl = mockFetch(() => new Response("x", { status: 200 }));
    const client = new Client({ token: "t", baseUrl: "https://proxy.internal", fetchImpl });
    await client.scrape("https://e.com");
    expect(fetchImpl.calls[0]!.url.startsWith("https://proxy.internal/")).toBe(true);
  });

  it("calls a plugin and returns JSON", async () => {
    const fetchImpl = mockFetch(
      () => new Response(JSON.stringify({ results: [1, 2] }), { status: 200, headers: { "Content-Type": "application/json" } }),
    );
    const client = new Client({ token: "t", fetchImpl });
    const data = await client.plugin("google/shopping", { q: "laptop", gl: "us" });
    expect(data).toEqual({ results: [1, 2] });
    expect(fetchImpl.calls[0]!.url).toContain("/plugin/google/shopping");
    expect(params(fetchImpl.calls[0]!.url).get("q")).toBe("laptop");
  });
});

describe("Client option validation", () => {
  it.each([
    ["timeoutMs 0", { timeoutMs: 0 }],
    ["timeoutMs NaN", { timeoutMs: Number.NaN }],
    ["retries NaN", { retries: Number.NaN }],
    ["backoffMs Infinity", { backoffMs: Number.POSITIVE_INFINITY }],
    ["maxResponseBytes 0", { maxResponseBytes: 0 }],
  ])("rejects %s", (_name, options) => {
    expect(() => new Client({ token: "t", ...options })).toThrow(SdoConfigError);
  });

  it("exposes the resolved timeout and never the token", () => {
    const client = new Client({ token: "SECRET-TOKEN-1", timeoutMs: 1500 });
    expect(client.timeoutMs).toBe(1500);
    expect(Object.values(client)).not.toContain("SECRET-TOKEN-1");
    expect(client.jobs).toBe(client.jobs);
  });

  it("reads SDO_BASE_URL and SDO_ASYNC_BASE_URL", () => {
    vi.stubEnv("SDO_BASE_URL", "https://sync.test/gw/");
    vi.stubEnv("SDO_ASYNC_BASE_URL", "https://async.test");
    const client = new Client({ token: "t" });
    expect(client.baseUrl).toBe("https://sync.test/gw");
    expect(client.asyncBaseUrl).toBe("https://async.test");
  });
});

describe("very long timeouts", () => {
  it("does not overflow the timer into an immediate timeout", async () => {
    const fetchImpl = mockFetch(async (_u, init) => {
      await new Promise((r) => setTimeout(r, 5));
      expect(init?.signal?.aborted).toBe(false);
      return new Response("ok");
    });
    // ~115 days, past the 32-bit timer range.
    const client = new Client({ token: "t", fetchImpl, timeoutMs: 1e10 });
    expect(client.timeoutMs).toBe(1e10);
    expect((await client.scrape("https://e.com")).statusCode).toBe(200);
  });
});
