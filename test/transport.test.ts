// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { Client } from "../src/client.js";
import {
  SdoAuthError,
  SdoConcurrencyError,
  SdoConnectionError,
  SdoGatewayError,
  SdoResponseTooLargeError,
  SdoTimeoutError,
  SdoValidationError,
} from "../src/errors.js";
import { parseRequestCost } from "../src/headers.js";
import { ScrapeResult } from "../src/response.js";
import { readCapped, targetAnswered } from "../src/transport.js";
import { mockFetch, sequence } from "./helpers.js";

function client(fetchImpl: ReturnType<typeof mockFetch>, retries = 2) {
  return new Client({ token: "t", backoffMs: 0, retries, fetchImpl });
}

describe("transport error mapping & retry", () => {
  it("maps 401 to SdoAuthError", async () => {
    const f = mockFetch(() => new Response("bad token", { status: 401 }));
    await expect(client(f).scrape("https://e.com")).rejects.toBeInstanceOf(SdoAuthError);
  });

  it("surfaces an exhausted credit balance as SdoAuthError, not a quota tier", async () => {
    // The gateway has no 402 tier: a depleted balance also returns 401, so it is
    // told apart by the message rather than the status code.
    const f = mockFetch(
      () => new Response(JSON.stringify({ Message: ["Monthly credit limit reached"] }), { status: 401 }),
    );
    const err = await client(f).scrape("https://e.com").catch((e) => e);
    expect(err).toBeInstanceOf(SdoAuthError);
    expect(err.message.toLowerCase()).toContain("credit");
    expect(err.billed).toBe(false);
  });

  it("maps an unbilled 400 to SdoValidationError, not billed", async () => {
    const f = mockFetch(() => new Response("bad param", { status: 400 }));
    await client(f)
      .scrape("https://e.com")
      .catch((e) => {
        expect(e).toBeInstanceOf(SdoValidationError);
        expect((e as SdoValidationError).billed).toBe(false);
      });
    expect.assertions(2);
  });

  // The gateway answers a parameter it cannot parse (render=mert) before it
  // authorizes the request: a 400 with its JSON envelope and no
  // Scrape.do-Request-Cost. That is an unbilled validation error with the
  // gateway's message, never retried.
  it("surfaces the gateway's own 400 (render=mert) as an unbilled validation error", async () => {
    const body =
      `{"URL":"https://e.com","StatusCode":400,"Message":["'Render' parameter should boolean."],` +
      `"PossibleCauses":["Please check your request."],"Contact":"Please don't hesitate to contact with us via support@scrape.do."}`;
    const f = mockFetch(
      () =>
        new Response(body, {
          status: 400,
          headers: { "Content-Type": "application/json; charset=utf-8", "X-Content-Type-Options": "nosniff" },
        }),
    );
    const err = await client(f)
      .scrape("https://e.com", { extraParams: { render: "mert" } })
      .catch((e: unknown) => e);
    expect(new URL(f.calls[0]!.url).searchParams.get("render")).toBe("mert");
    expect(err).toBeInstanceOf(SdoValidationError);
    expect((err as SdoValidationError).message).toBe("'Render' parameter should boolean.");
    expect((err as SdoValidationError).billed).toBe(false);
    expect((err as SdoValidationError).isRetryable).toBe(false);
    expect(f.calls).toHaveLength(1);
  });

  it("returns a target 400 the gateway billed as a result", async () => {
    const f = mockFetch(
      () =>
        new Response("<html>Bad Request</html>", {
          status: 400,
          headers: { "Scrape.do-Request-Cost": "1", "Scrape.do-Initial-Status-Code": "400" },
        }),
    );
    const r = await client(f).scrape("https://e.com");
    expect(r.statusCode).toBe(400);
    expect(r.text).toBe("<html>Bad Request</html>");
    expect(r.cost).toBe(1);
  });

  for (const status of [404, 410]) {
    it(`returns a result (not an error) for a target ${status}`, async () => {
      const f = mockFetch(() => new Response("not found", { status }));
      const r = await client(f).scrape("https://e.com");
      expect(r.statusCode).toBe(status);
      expect(r.text).toContain("not found");
    });
  }

  it("retries a 429 then succeeds", async () => {
    const f = sequence(
      new Response(null, { status: 429, headers: { "Retry-After": "0" } }),
      new Response("ok", { status: 200 }),
    );
    const r = await client(f).scrape("https://e.com");
    expect(r.statusCode).toBe(200);
    expect(f.calls.length).toBe(2);
  });

  it("raises SdoConcurrencyError after exhausting retries", async () => {
    const f = mockFetch(() => new Response(null, { status: 429, headers: { "Retry-After": "0" } }));
    await expect(client(f, 1).scrape("https://e.com")).rejects.toBeInstanceOf(SdoConcurrencyError);
  });

  it("retries a 502 then succeeds", async () => {
    const f = sequence(new Response(null, { status: 502 }), new Response("ok", { status: 200 }));
    const r = await client(f).scrape("https://e.com");
    expect(r.statusCode).toBe(200);
  });

  it("raises SdoGatewayError when 502 is exhausted", async () => {
    const f = mockFetch(() => new Response(null, { status: 502 }));
    await expect(client(f, 0).scrape("https://e.com")).rejects.toBeInstanceOf(SdoGatewayError);
  });

  it("maps a network failure to SdoConnectionError", async () => {
    const f = mockFetch(() => {
      throw new TypeError("fetch failed");
    });
    await expect(client(f, 0).scrape("https://e.com")).rejects.toBeInstanceOf(SdoConnectionError);
  });

  it("parses the {\"Message\":[...]} envelope into the error message and keeps the raw body", async () => {
    const body = JSON.stringify({
      Message: ["callback not supported anymore", "use the async job API"],
      PossibleCauses: ["deprecated parameter"],
    });
    const f = mockFetch(() => new Response(body, { status: 400 }));
    await client(f, 0)
      .scrape("https://e.com")
      .catch((e) => {
        expect(e).toBeInstanceOf(SdoValidationError);
        expect((e as SdoValidationError).message).toBe(
          "callback not supported anymore; use the async job API",
        );
        expect((e as SdoValidationError).body).toBe(body);
      });
    expect.assertions(3);
  });

  it("never retries a connection dropped mid-body: the request was delivered", async () => {
    const broken = () =>
      new Response(
        new ReadableStream({
          start(c) {
            c.enqueue(new Uint8Array([1]));
            c.error(new TypeError("terminated"));
          },
        }),
      );
    const f = sequence(broken(), new Response("ok"));
    await expect(client(f, 2).scrape("https://e.com")).rejects.toBeInstanceOf(SdoConnectionError);
    expect(f.calls).toHaveLength(1);
  });

  it("does not retry a request with side effects after a transport failure", async () => {
    const f = mockFetch(() => {
      throw new TypeError("fetch failed");
    });
    await expect(client(f, 2).scrape("https://e.com", { data: "x" })).rejects.toBeInstanceOf(SdoConnectionError);
    expect(f.calls).toHaveLength(1);
  });

  it("retries a POST that the gateway refused with 429", async () => {
    const f = sequence(new Response(null, { status: 429, headers: { "Retry-After": "0" } }), new Response("ok"));
    expect((await client(f, 1).scrape("https://e.com", { json: { a: 1 } })).statusCode).toBe(200);
    expect(f.calls).toHaveLength(2);
  });

  it("reports a timeout that fired before the response as SdoTimeoutError", async () => {
    const f = mockFetch(
      (_u, init) =>
        new Promise((_r, reject) => init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason))),
    );
    const c = new Client({ token: "t", retries: 0, timeoutMs: 20, fetchImpl: f });
    const err = await c.scrape("https://e.com").catch((e) => e);
    expect(err).toBeInstanceOf(SdoTimeoutError);
    expect(err.message).toContain("20 ms");
  });

  it("keeps the gateway's retry hints on the error", async () => {
    const f = mockFetch(
      () =>
        new Response('{"Message":"slow down"}', {
          status: 429,
          headers: { "retry-after": " 7 " },
        }),
    );
    const err = await client(f, 0).scrape("https://e.com").catch((e) => e);
    expect(err).toMatchObject({ retryAfter: 7, message: "slow down" });
  });

  it("truncates or refuses a body past the limit", async () => {
    const body = async function* () {
      yield new Uint8Array(64);
    };
    const released: number[] = [];
    const cut = await readCapped(body(), 16, { truncate: true, release: () => released.push(1) });
    expect(cut.bytes).toHaveLength(16);
    expect(cut.truncated).toBe(true);
    expect(released).toEqual([1]);
    await expect(readCapped(body(), 16)).rejects.toBeInstanceOf(SdoResponseTooLargeError);
  });

  it("stops at once when the deadline has already passed", async () => {
    const controller = new AbortController();
    controller.abort(new Error("deadline"));
    const body = async function* () {
      yield new Uint8Array(3);
    };
    await expect(readCapped(body(), 1024, { signal: controller.signal })).rejects.toThrow("deadline");
  });
});

// Scrape.do-Request-Cost is authoritative: any status the gateway billed is the
// target's page, on the scrape and plugin paths alike, and is never retried;
// without a positive cost a status keeps its gateway meaning, and `billed`
// follows the header when there is one.
describe("request cost decides origin and billing", () => {
  for (const status of [401, 403, 405, 422, 429, 500]) {
    it(`returns a billed target ${status} as a result, never retried`, async () => {
      const f = mockFetch(
        () => new Response("target page", { status, headers: { "Scrape.do-Request-Cost": "3" } }),
      );
      const c = client(f);
      const r = await c.scrape("https://e.com");
      expect(r.statusCode).toBe(status);
      expect(r.text).toBe("target page");
      expect(r.cost).toBe(3);
      const out = await c.plugin("google/search", { q: "x" });
      expect(new TextDecoder().decode(out as Uint8Array)).toBe("target page");
      expect(f.calls).toHaveLength(2);
    });
  }

  const errors: Array<[string, number, string | undefined, new (...a: never[]) => Error, boolean, number | undefined]> = [
    ["gateway 401 (refused token)", 401, undefined, SdoAuthError, false, undefined],
    ["401 with cost 0", 401, "0", SdoAuthError, false, 0],
    ["gateway 400", 400, undefined, SdoValidationError, false, undefined],
    ["unbilled 502", 502, "0", SdoGatewayError, false, 0],
    ["cost over 2^53-1 is unreadable", 401, "9007199254740992", SdoAuthError, false, undefined],
  ];
  for (const [name, status, cost, cls, billed, wantCost] of errors) {
    it(`maps ${name}`, async () => {
      const headers: Record<string, string> = cost === undefined ? {} : { "Scrape.do-Request-Cost": cost };
      const f = mockFetch(() => new Response(null, { status, headers }));
      const err = await client(f, 0).scrape("https://e.com").catch((e: unknown) => e);
      expect(err).toBeInstanceOf(cls);
      expect((err as SdoAuthError).billed).toBe(billed);
      expect((err as SdoAuthError).cost).toBe(wantCost);
    });
  }

  it("reads the cost the same way everywhere", () => {
    const cases: Array<[string | null, number | undefined]> = [
      [null, undefined],
      ["7", 7],
      [" 7\t", 7],
      ["0", 0],
      ["+7", undefined],
      ["-1", undefined],
      ["1.5", undefined],
      ["7, 7", undefined],
      ["9007199254740991", 9007199254740991],
      ["9007199254740992", undefined],
    ];
    expect(parseRequestCost("٣")).toBeUndefined();
    for (const [raw, want] of cases) {
      expect(parseRequestCost(raw), String(raw)).toBe(want);
      const headers = new Headers(raw === null ? {} : { "Scrape.do-Request-Cost": raw });
      expect(targetAnswered(headers), String(raw)).toBe((want ?? 0) > 0);
      expect(new ScrapeResult({ content: new Uint8Array(), statusCode: 200, headers, url: "https://e.com" }).cost).toBe(want);
    }
  });
});
