// SPDX-License-Identifier: Apache-2.0
// Behaviour pinned against the public docs and the gateway's real handling.
import { describe, expect, it } from "vitest";
import { Client } from "../src/client.js";
import { ScrapeConfig } from "../src/config.js";
import { SdoConcurrencyError, SdoConfigError, SdoGatewayError, SdoTransportError } from "../src/errors.js";
import { mockFetch, params } from "./helpers.js";

const U = "https://e.com";

describe("parameter dependencies", () => {
  it.each([
    [{ sessionId: "abc" }, "sessionId"],
    [{ sessionId: 1.5 }, "sessionId"],
    [{ regionalGeoCode: "europe" }, "requires superProxy"],
    [{ superProxy: true, geoCode: "us", regionalGeoCode: "europe" }, "cannot be combined"],
    [{ geoCode: "us", zipCode: "90210" }, "requires superProxy: true and a geoCode"],
    [{ customHeaders: true, forwardHeaders: true }, "cannot be combined"],
    [{ render: true, retryTimeout: 5000 }, "'retryTimeout' cannot be combined with render"],
    [{ render: true, screenshot: true }, "'screenshot' requires returnJson"],
    [{ render: true, showFrames: true }, "'showFrames' requires returnJson"],
    [{ render: true, returnJson: true, screenshot: true, fullScreenshot: true }, "cannot be combined"],
    [
      { render: true, returnJson: true, particularScreenshot: "h1", playWithBrowser: [{ Action: "Click" }] },
      "cannot be combined with playWithBrowser",
    ],
    [{ width: 1920 }, "'width' requires render"],
  ] as const)("rejects %j", (options, message) => {
    expect(() => new ScrapeConfig(U, options as never)).toThrow(SdoConfigError);
    expect(() => new ScrapeConfig(U, options as never)).toThrow(message);
  });

  it("accepts returnJson alone, the documented screenshot, and numeric session ids", () => {
    expect(new ScrapeConfig(U, { returnJson: true }).toParams()).toEqual([["url", U], ["returnJSON", "true"]]);
    expect(new ScrapeConfig(U, { render: true, returnJson: true, particularScreenshot: "#price" }).toParams()).toEqual([
      ["url", U],
      ["render", "true"],
      ["particularScreenShot", "#price"],
      ["returnJSON", "true"],
    ]);
    expect(new ScrapeConfig(U, { sessionId: 0 }).toParams()).toEqual([["url", U], ["sessionId", "0"]]);
    expect(new ScrapeConfig(U, { sessionId: 1_000_000 }).toParams()).toEqual([["url", U], ["sessionId", "1000000"]]);
    expect(new ScrapeConfig(U, { sessionId: "" }).toParams()).toEqual([["url", U]]);
  });
});

it("masks credentials in a target URL error", () => {
  const err = (() => {
    try {
      new ScrapeConfig("https://user:hunter2@e.com:99999/?token=abcdef123");
    } catch (e) {
      return e as Error;
    }
    throw new Error("no error");
  })();
  expect(err).toBeInstanceOf(SdoConfigError);
  expect(err.message).toContain("https://***@e.com");
  expect(err.message).not.toMatch(/hunter2|user:|abcdef123/);
});

it("does not retry a 510 and labels it a client cancellation", async () => {
  const fetchImpl = mockFetch(() => new Response("", { status: 510 }));
  const client = new Client({ token: "t", fetchImpl, backoffMs: 0 });
  const err = await client.scrape(U).catch((e: unknown) => e);
  expect(err).toBeInstanceOf(SdoGatewayError);
  expect((err as SdoGatewayError).isRetryable).toBe(false);
  expect((err as SdoGatewayError).message).toBe("The request was canceled by the HTTP client (HTTP 510).");
  expect(fetchImpl.calls).toHaveLength(1);
});

it("exposes Scrape.do-Target-Redirected-Location", async () => {
  const fetchImpl = mockFetch(
    () => new Response("", { status: 302, headers: { "Scrape.do-Target-Redirected-Location": "https://e.com/next" } }),
  );
  const result = await new Client({ token: "t", fetchImpl }).scrape(U, { disableRedirection: true });
  expect(result.statusCode).toBe(302);
  expect(result.targetRedirectedLocation).toBe("https://e.com/next");
});

describe("plugins", () => {
  it("pluginResult keeps the status, cost and body", async () => {
    const fetchImpl = mockFetch(
      () =>
        new Response('{"organic":[1]}', {
          status: 200,
          headers: { "Content-Type": "application/json", "Scrape.do-Request-Cost": "10" },
        }),
    );
    const client = new Client({ token: "t", fetchImpl });
    const res = await client.pluginResult("google/search", { q: "x", gl: "us" });
    expect(res.statusCode).toBe(200);
    expect(res.cost).toBe(10);
    expect(res.url).toBe("");
    expect(res.json()).toEqual({ organic: [1] });
    expect(new URL(fetchImpl.calls[0]!.url).pathname).toBe("/plugin/google/search");
  });

  it.each(["amazon", "amazon/"])("calls the Amazon raw-HTML plugin at /plugin/amazon/ for %j", async (route) => {
    const fetchImpl = mockFetch(() => new Response("<html></html>", { status: 200, headers: { "Content-Type": "text/html" } }));
    const client = new Client({ token: "t", fetchImpl });
    await client.plugin(route, { url: "https://www.amazon.com/dp/B0", geocode: "us" });
    expect(new URL(fetchImpl.calls[0]!.url).pathname).toBe("/plugin/amazon/");
  });
});

describe("usage", () => {
  const BODY =
    '{"IsActive":true,"ConcurrentRequest":40,"MaxMonthlyRequest":3500000,' +
    '"RemainingConcurrentRequest":15,"RemainingMonthlyRequest":2565023}';

  it("reads /info with the token as a query parameter", async () => {
    const fetchImpl = mockFetch(() => new Response(BODY, { status: 200, headers: { "Content-Type": "application/json" } }));
    const usage = await new Client({ token: "TKN", fetchImpl }).usage();
    expect(usage).toEqual({
      isActive: true,
      concurrentRequest: 40,
      maxMonthlyRequest: 3500000,
      remainingConcurrentRequest: 15,
      remainingMonthlyRequest: 2565023,
    });
    const url = new URL(fetchImpl.calls[0]!.url);
    expect(url.pathname).toBe("/info");
    expect(params(fetchImpl.calls[0]!.url).get("token")).toBe("TKN");
    expect([...url.searchParams.keys()]).toEqual(["token"]);
  });

  it.each([
    [429, '{"message":"You have exceeded your request limit. You can send 10 requests per minute."}', SdoConcurrencyError],
    [502, '{"message":"authentication refused"}', SdoGatewayError],
  ] as const)("does not retry a %i", async (status, body, cls) => {
    const fetchImpl = mockFetch(() => new Response(body, { status, headers: { "Content-Type": "application/json" } }));
    const err = await new Client({ token: "t", fetchImpl, retries: 3, backoffMs: 0 }).usage().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(cls);
    expect(body).toContain((err as Error).message);
    expect(fetchImpl.calls).toHaveLength(1);
  });

  it.each([
    "[]",
    "null",
    '{"IsActive":true}',
    "not json",
    '{"IsActive":"yes","ConcurrentRequest":1,"MaxMonthlyRequest":1,"RemainingConcurrentRequest":1,"RemainingMonthlyRequest":1}',
    '{"IsActive":true,"ConcurrentRequest":1.5,"MaxMonthlyRequest":1,"RemainingConcurrentRequest":1,"RemainingMonthlyRequest":1}',
  ])("rejects the body %s", async (body) => {
    const fetchImpl = mockFetch(() => new Response(body, { status: 200 }));
    await expect(new Client({ token: "t", fetchImpl }).usage()).rejects.toBeInstanceOf(SdoTransportError);
  });
});

describe("render requires GET", () => {
  it.each(["POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"])("refuses %s with render", async (method) => {
    const fetchImpl = mockFetch(() => new Response("ok"));
    const client = new Client({ token: "t", fetchImpl });
    for (const options of [{ render: true }, { render: "true" }]) {
      const err = await client.scrape(U, { ...options, method } as never).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(SdoConfigError);
      expect((err as Error).message).toBe(`render works with GET requests only; got ${method}.`);
    }
    expect(fetchImpl.calls).toHaveLength(0);
  });

  it("sends a rendered GET and an unrendered POST", async () => {
    const fetchImpl = mockFetch(() => new Response("ok"));
    const client = new Client({ token: "t", fetchImpl });
    await client.scrape(U, { render: true });
    await client.scrape(U, { render: false, method: "POST", data: "a=1" });
    expect(fetchImpl.calls).toHaveLength(2);
  });
});
