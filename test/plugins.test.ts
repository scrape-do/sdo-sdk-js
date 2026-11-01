// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { Client } from "../src/client.js";
import { SdoTimeoutError, SdoValidationError } from "../src/errors.js";
import { pluginTimeoutMs } from "../src/plugins.js";
import { mockFetch, params } from "./helpers.js";

describe("plugins", () => {
  it("returns raw bytes for a non-JSON plugin and serializes params", async () => {
    const f = mockFetch(
      () => new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { "Content-Type": "image/png" } }),
    );
    const client = new Client({ token: "t", fetchImpl: f });
    const out = await client.plugin("amazon/product", { flag: true, ids: [1, 2], skip: null });

    expect(out).toBeInstanceOf(Uint8Array);
    const p = params(f.calls[0]!.url);
    expect(p.get("flag")).toBe("true");
    expect(p.getAll("ids")).toEqual(["1", "2"]);
    expect(p.has("skip")).toBe(false);
    expect(f.calls[0]!.url).toContain("/plugin/amazon/product");
  });

  // A plugin call follows the scrape status rules: a target 404/410, and a 400
  // the gateway billed, are results; the gateway's own 400 is an unbilled
  // validation error whose message is the plugin envelope's.
  const results: Array<[string, number, Record<string, string>]> = [
    ["target 404", 404, {}],
    ["target 410", 410, {}],
    ["billed target 400", 400, { "Scrape.do-Request-Cost": "25" }],
  ];
  for (const [name, status, headers] of results) {
    it(`returns a ${name} as a result`, async () => {
      const f = mockFetch(() => new Response("page", { status, headers }));
      const out = await new Client({ token: "t", retries: 0, fetchImpl: f }).plugin("google/search", { q: "x" });
      expect(new TextDecoder().decode(out as Uint8Array)).toBe("page");
    });
  }

  const gatewayErrors: Array<[string, string, Record<string, string>, string]> = [
    [
      "plugin parameter error",
      `{"error":"invalid_zipcode","message":"ZIP code format doesn't match country requirements"}`,
      { "Scrape.do-Plugin": "google/search" },
      "ZIP code format doesn't match country requirements",
    ],
    ["plugin error code only", `{"error":"timeout is invalid"}`, {}, "timeout is invalid"],
    ["unbilled 400 with a zero cost", `{"Message":"nope"}`, { "Scrape.do-Request-Cost": "0" }, "nope"],
  ];
  for (const [name, body, headers, message] of gatewayErrors) {
    it(`surfaces a ${name} as an unbilled validation error`, async () => {
      const f = mockFetch(() => new Response(body, { status: 400, headers }));
      const err = await new Client({ token: "t", retries: 0, fetchImpl: f })
        .plugin("google/search", { q: "x" })
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(SdoValidationError);
      expect((err as SdoValidationError).message).toBe(message);
      expect((err as SdoValidationError).billed).toBe(false);
    });
  }

  // Waits ~150 ms, or rejects as soon as the request is aborted.
  const slow = mockFetch(
    (_u, init) =>
      new Promise<Response>((resolve, reject) => {
        const timer = setTimeout(() => resolve(new Response("ok")), 150);
        init?.signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(init.signal!.reason);
        });
      }),
  );

  it("gives a positive integer timeout param the gateway margin", async () => {
    const client = new Client({ token: "t", retries: 0, timeoutMs: 50, fetchImpl: slow });
    await expect(client.plugin("walmart/search", { q: "x", timeout: 100 })).resolves.toBeInstanceOf(Uint8Array);
    await expect(client.plugin("walmart/search", { q: "x" })).rejects.toBeInstanceOf(SdoTimeoutError);
  });

  it("reads the timeout param only as one positive integer", () => {
    expect(pluginTimeoutMs([])).toBeUndefined();
    expect(pluginTimeoutMs([["q", "x"]])).toBeUndefined();
    expect(pluginTimeoutMs([["timeout", "30000"]])).toBe(30000);
    for (const v of ["0", "1.5", "-5", "abc", "", " 5"]) expect(pluginTimeoutMs([["timeout", v]]), v).toBeUndefined();
    expect(pluginTimeoutMs([["timeout", "1000"], ["timeout", "2000"]])).toBeUndefined();
    expect(pluginTimeoutMs([["Timeout", "1000"]])).toBeUndefined();
  });
});
