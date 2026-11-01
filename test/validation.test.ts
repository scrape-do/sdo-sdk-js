// SPDX-License-Identifier: Apache-2.0
// Inputs the SDK refuses before any request is made, and the shapes it accepts.
import { describe, expect, it } from "vitest";
import { Client } from "../src/client.js";
import { ScrapeConfig, type ScrapeOptions } from "../src/config.js";
import { SdoConfigError, SdoTransportError } from "../src/errors.js";
import { canonicalJson, compareCodePoints } from "../src/json.js";
import { bodyText, header, mockFetch } from "./helpers.js";

const U = "https://e.com";
const build = (o: Record<string, unknown>) => new ScrapeConfig(U, o as ScrapeOptions).toParams();

describe("ScrapeConfig value types", () => {
  it.each([
    ["a non-boolean flag", { superProxy: "yes" }],
    ["a fractional integer", { height: 1.5 }],
    ["NaN", { width: Number.NaN }],
    ["a numeric string", { timeout: "5000" }],
    ["a non-string text value", { geoCode: 5 }],
    ["a non-string enum", { device: 1 }],
    ["an unknown render value", { render: 1 }],
    ["playWithBrowser as an object", { render: true, playWithBrowser: { action: "click" } }],
    ["a removed, undocumented option", { autoParser: true }],
    ["extraParams as an array", { extraParams: ["a"] }],
    ["an extraParams object value", { extraParams: { a: { b: 1 } } }],
    ["a non-finite extraParams number", { extraParams: { a: Number.POSITIVE_INFINITY } }],
  ])("rejects %s", (_name, options) => {
    expect(() => build(options)).toThrow(SdoConfigError);
  });

  it("names the unit when a millisecond value is out of range", () => {
    expect(() => build({ timeout: 30 })).toThrow(/milliseconds/);
  });

  it("rejects a target that is not a string", () => {
    expect(() => new ScrapeConfig(undefined as unknown as string)).toThrow(SdoConfigError);
  });

  it("sends extraParams scalars in their literal form", () => {
    expect(build({ extraParams: { n: 1.5, f: false, t: true } })).toEqual([
      ["url", U],
      ["f", "false"],
      ["n", "1.5"],
      ["t", "true"],
    ]);
  });

  it("treats render 'FALSE' as off and still gates render-only values", () => {
    expect(build({ render: "FALSE" })).toEqual([["url", U]]);
    expect(() => build({ render: "False", blockResources: true })).toThrow(SdoConfigError);
  });

  it("validates a copy, so later edits to the caller's object change nothing", () => {
    const options: ScrapeOptions = { superProxy: true };
    const cfg = new ScrapeConfig(U, options);
    options.screenshot = true;
    expect(cfg.toParams()).toEqual([["url", U], ["super", "true"]]);
  });
});

describe("canonical JSON", () => {
  it("writes what JSON.stringify would, with sorted keys", () => {
    const value = { b: [undefined, () => 1, 2], a: new Date(0), skip: undefined, f: () => 1 };
    expect(canonicalJson(value)).toBe('{"a":"1970-01-01T00:00:00.000Z","b":[null,null,2]}');
  });

  it("sorts integer-like keys as strings, not numerically", () => {
    expect(canonicalJson({ 10: 1, 9: 2, a: 3 })).toBe('{"10":1,"9":2,"a":3}');
  });

  it("refuses values JSON cannot represent", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    for (const bad of [cyclic, { n: Number.NaN }, { big: 1n }, Symbol("s")]) {
      expect(() => canonicalJson(bad)).toThrow(SdoConfigError);
    }
  });

  it("allows the same object twice when it is not a cycle", () => {
    const shared = { k: 1 };
    expect(canonicalJson([shared, shared])).toBe('[{"k":1},{"k":1}]');
  });

  it("orders by code point across the surrogate range", () => {
    const keys = ["\u{1F600}", "～", "z", "😁", ""];
    expect([...keys].sort(compareCodePoints)).toEqual(["", "z", "～", "\u{1F600}", "😁"]);
  });
});

describe("request method and body", () => {
  const send = async (options: Record<string, unknown>) => {
    const f = mockFetch(() => new Response("ok"));
    await new Client({ token: "TOK", retries: 0, fetchImpl: f }).scrape(U, options as ScrapeOptions);
    return f.calls[0]!.init;
  };

  it("sends a Uint8Array or ArrayBuffer body as-is", async () => {
    expect(bodyText(await send({ data: new Uint8Array([104, 105]) }))).toBe("hi");
    expect(bodyText(await send({ data: new Uint8Array([111, 107]).buffer }))).toBe("ok");
  });

  it("allows HEAD and OPTIONS without a body", async () => {
    expect((await send({ method: "head" }))?.method).toBe("HEAD");
    expect((await send({ method: "OPTIONS" }))?.method).toBe("OPTIONS");
  });

  it("keeps a caller Content-Type whatever its case, and sends ScrapeOptions headers", async () => {
    const init = await send({ json: { a: 1 }, headers: { "content-type": "text/json", "X-A": "1" } });
    expect(header(init, "content-type")).toBe("text/json");
    expect(header(init, "x-a")).toBe("1");
  });

  it("rejects a data value of another type and a non-string method", async () => {
    await expect(send({ data: 5 })).rejects.toBeInstanceOf(SdoConfigError);
    await expect(send({ method: 5 })).rejects.toBeInstanceOf(SdoConfigError);
  });

  it("takes the request options next to a ScrapeConfig", async () => {
    const f = mockFetch(() => new Response("ok"));
    const client = new Client({ token: "TOK", retries: 0, fetchImpl: f });
    await client.scrape(new ScrapeConfig(U, { headers: { "X-Base": "1" } }), {
      method: "put",
      json: { k: "v" },
      headers: { "X-Extra": "2" },
    });
    const init = f.calls[0]!.init;
    expect(init?.method).toBe("PUT");
    expect(bodyText(init)).toBe('{"k":"v"}');
    expect(header(init, "x-base")).toBe("1");
    expect(header(init, "x-extra")).toBe("2");
  });
});

describe("plugin parameters", () => {
  const call = (params: unknown) => {
    const f = mockFetch(() => new Response("not json", { headers: { "content-type": "application/json" } }));
    return new Client({ token: "TOK", retries: 0, fetchImpl: f }).plugin("google/search", params as never);
  };

  it("rejects values that have no query form", async () => {
    await expect(call({ list: [[1]] })).rejects.toBeInstanceOf(SdoConfigError);
    await expect(call({ fn: () => 1 })).rejects.toBeInstanceOf(SdoConfigError);
    await expect(call({ n: Number.NaN })).rejects.toBeInstanceOf(SdoConfigError);
    await expect(call({ big: { n: Number.POSITIVE_INFINITY } })).rejects.toBeInstanceOf(SdoConfigError);
    await expect(call(null)).rejects.toBeInstanceOf(SdoConfigError);
    await expect(call(["a"])).rejects.toBeInstanceOf(SdoConfigError);
  });

  it("maps an invalid JSON body to a transport error", async () => {
    await expect(call({})).rejects.toBeInstanceOf(SdoTransportError);
  });
});
