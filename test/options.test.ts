// SPDX-License-Identifier: Apache-2.0
// Input validation that happens before anything is sent: unknown option names,
// tokens, request headers, base and target URLs, plugin parameters and JSON.
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { Client } from "../src/client.js";
import { ScrapeConfig, type ScrapeOptions } from "../src/config.js";
import { SdoConfigError, SdoTransportError } from "../src/errors.js";
import { checkHeaders, mergeHeaders } from "../src/headers.js";
import { canonicalJson, parseJsonBody } from "../src/json.js";
import { VERSION } from "../src/version.js";
import { header, mockFetch } from "./helpers.js";

const TARGET = "https://e.com";
const ok = () => new Response("ok");

describe("unknown option names are refused", () => {
  const thrown = (fn: () => unknown): string => {
    try {
      fn();
    } catch (e) {
      expect(e).toBeInstanceOf(SdoConfigError);
      return (e as Error).message;
    }
    throw new Error("expected a SdoConfigError");
  };

  it("in ScrapeConfig, with a hint for snake_case and wire names", () => {
    const msg = thrown(() => new ScrapeConfig(TARGET, { geo_code: "us", super: true, renderr: true } as ScrapeOptions));
    expect(msg).toContain("'geo_code' (did you mean 'geoCode'?)");
    expect(msg).toContain("'super' (did you mean 'superProxy'?)");
    expect(msg).toContain("'renderr'");
    expect(msg).toContain("extraParams");
  });

  it("in scrape() options and next to a ScrapeConfig, before any request", async () => {
    const f = mockFetch(ok);
    const client = new Client({ token: "t", fetchImpl: f });
    const options = { waitSelector: "#x", body: "x" } as ScrapeOptions;
    await expect(client.scrape(TARGET, options)).rejects.toThrow("'body'");
    await expect(client.scrape(new ScrapeConfig(TARGET), { render: true } as never)).rejects.toThrow(
      "Scrape parameters belong in the ScrapeConfig",
    );
    await expect(client.scrape(TARGET, null as never)).resolves.toBeDefined();
    await expect(client.scrape(TARGET, "x" as never)).rejects.toBeInstanceOf(SdoConfigError);
    expect(f.calls).toHaveLength(1);
  });

  it("in ClientOptions", () => {
    expect(thrown(() => new Client({ token: "t", maxRetries: 3 } as never))).toContain("'maxRetries'");
    expect(thrown(() => new Client({ token: "t", max_response_bytes: 1 } as never))).toContain(
      "(did you mean 'maxResponseBytes'?)",
    );
    expect(() => new Client({ token: "t", fetchImpl: "fetch" as never })).toThrow(SdoConfigError);
    expect(() => new Client({ token: "t", acceptEncoding: "gzip\r\nX-A: 1" })).toThrow(SdoConfigError);
  });

  it("including an empty extraParams key", () => {
    expect(() => new ScrapeConfig(TARGET, { extraParams: { "": "x" } })).toThrow("extraParams keys cannot be empty");
  });

  it("but a later edit to the config's options is still validated", () => {
    const config = new ScrapeConfig(TARGET);
    (config.options as Record<string, unknown>).renderr = true;
    expect(() => config.toParams()).toThrow(SdoConfigError);
  });
});

describe("tokens", () => {
  it("are trimmed and validated, naming where they came from", () => {
    vi.stubEnv("SDO_TOKEN", "  env-token\n");
    expect(() => new Client({})).not.toThrow();
    vi.stubEnv("SDO_TOKEN", "env token");
    expect(() => new Client({})).toThrow("SDO_TOKEN");
    expect(() => new Client({ token: "tök" })).toThrow("the token option");
    expect(() => new Client({ token: 5 as never })).toThrow(SdoConfigError);
    vi.stubEnv("SDO_TOKEN", " \t ");
    expect(() => new Client({ token: "\n" })).toThrow("No token provided");
  });

  it("trimmed on the wire, in the query and in X-Token", async () => {
    const f = mockFetch(() => new Response("{}"));
    const client = new Client({ token: "tok-123\n", fetchImpl: f });
    await client.scrape(TARGET);
    await client.jobs.me();
    expect(f.calls[0]!.url).toContain("?token=tok-123&");
    expect(header(f.calls[1]!.init, "x-token")).toBe("tok-123");
  });
});

describe("request headers", () => {
  it("accept a Headers object and merge names case-insensitively", () => {
    expect(checkHeaders(new Headers({ "X-A": "1" }))).toEqual({ "x-a": "1" });
    expect(mergeHeaders({ "User-Agent": "sdk", Accept: "a" }, { "user-agent": "mine" })).toEqual({
      Accept: "a",
      "user-agent": "mine",
    });
    expect(() => checkHeaders("X-A: 1")).toThrow(SdoConfigError);
    expect(() => checkHeaders({ "X-A": 1 })).toThrow(SdoConfigError);
    expect(() => checkHeaders({ "Transfer-Encoding": "chunked" })).toThrow(SdoConfigError);
  });

  it("never echo a rejected value (it may be a credential)", () => {
    expect(() => checkHeaders({ Authorization: "Bearer s3cret\n" })).toThrow(/^(?!.*s3cret)/s);
  });

  it("are validated in ScrapeConfig too", () => {
    expect(() => new ScrapeConfig(TARGET, { headers: { "Bad Name": "x" } })).toThrow(SdoConfigError);
  });

  it("replace the SDK's own on the fetch path as well", async () => {
    const f = mockFetch(ok);
    await new Client({ token: "t", fetchImpl: f }).scrape(TARGET, { headers: { "accept-encoding": "identity" } });
    const sent = f.calls[0]!.init!.headers as Record<string, string>;
    expect(Object.keys(sent).filter((k) => k.toLowerCase() === "accept-encoding")).toEqual(["accept-encoding"]);
    expect(header(f.calls[0]!.init, "accept-encoding")).toBe("identity");
  });
});

describe("URLs", () => {
  it("mask credentials of a rejected base URL in the message", () => {
    expect(() => new Client({ token: "t", baseUrl: "https://user:pw@gw.test" })).toThrow(
      'got "https://***@gw.test"',
    );
  });

  it("refuse a base URL whose host is not a hostname", () => {
    expect(() => new Client({ token: "t", baseUrl: "https://%zz" })).toThrow(SdoConfigError);
  });

  it("refuse malformed authorities in target URLs", () => {
    for (const url of ["https://[::1", "https://[::1]x/", "https://e.com:/", "https://e.com:8a/", "https://e .com", 7]) {
      expect(() => new ScrapeConfig(url as string), String(url)).toThrow(SdoConfigError);
    }
    expect(() => new ScrapeConfig("https://e.com/\ud800")).toThrow(SdoConfigError);
    expect(new ScrapeConfig("https://[::1]/x").url).toBe("https://[::1]/x");
  });
});

describe("JSON", () => {
  it("rejects a value nested too deeply to serialize as a config error", () => {
    let deep: unknown = 1;
    for (let i = 0; i < 20_000; i++) deep = [deep];
    expect(() => canonicalJson(deep)).toThrow(SdoConfigError);
    expect(() => canonicalJson({ toJSON: () => { throw new TypeError("boom"); } })).toThrow(TypeError);
  });

  it("parses deeply nested bodies and rejects overflow anywhere inside", () => {
    const deep = "[".repeat(5000) + "1" + "]".repeat(5000);
    expect(() => parseJsonBody(new TextEncoder().encode(deep), "x")).not.toThrow();
    expect(() => parseJsonBody(new TextEncoder().encode('{"a":[{"b":1e999}]}'), "The body")).toThrow(
      new SdoTransportError("The body is not valid JSON: a number overflows a double."),
    );
  });
});

describe("version", () => {
  it("matches package.json", () => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
    expect(VERSION).toBe(pkg.version);
  });
});
