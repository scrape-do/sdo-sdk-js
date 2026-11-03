// SPDX-License-Identifier: Apache-2.0
// The default transport (node:http / node:https) against local servers: the
// retry rule (only a request that never left is retried), deadlines, the
// caller's AbortSignal, statuses fetch would hide, and decompression bombs on
// every body path. Everything stays on 127.0.0.1.
import net from "node:net";
import zlib from "node:zlib";
import { describe, expect, it } from "vitest";
import { Client } from "../src/client.js";
import {
  SdoAbortError,
  SdoApiError,
  SdoConfigError,
  SdoConnectionError,
  SdoGatewayError,
  SdoResponseTooLargeError,
  SdoTimeoutError,
  SdoTransportError,
} from "../src/errors.js";
import { Transport } from "../src/transport.js";
import { withServer } from "./server.js";

const TARGET = "https://e.com";
const ok = (_req: unknown, res: { end(b: string): void }) => void res.end("ok");

/** A TCP server that accepts connections and never answers (not even TLS). */
async function silentServer(): Promise<{ port: number; connections: () => number; close(): Promise<void> }> {
  const sockets: net.Socket[] = [];
  const server = net.createServer((s) => void sockets.push(s));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return {
    port: (server.address() as net.AddressInfo).port,
    connections: () => sockets.length,
    close: () =>
      new Promise<void>((r) => {
        for (const s of sockets) s.destroy();
        server.close(() => r());
      }),
  };
}

/** A port nothing listens on. */
async function closedPort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as net.AddressInfo;
  await new Promise<void>((r) => server.close(() => r()));
  return port;
}

function transport(sleeps: number[], retries = 2): Transport {
  return new Transport({
    timeoutMs: 2000,
    acceptEncoding: "gzip",
    retries,
    backoffMs: 7,
    userAgent: "sdo-sdk-js/test",
    maxResponseBytes: 1024,
    sleep: async (ms) => void sleeps.push(ms),
  });
}

describe("retries happen only before the request is sent", () => {
  it("retries a refused connection for GET, never for POST", async () => {
    const url = `http://127.0.0.1:${await closedPort()}/`;
    const sleeps: number[] = [];
    const get = await transport(sleeps).send({ method: "GET", url, token: "t", api: "sync" }).catch((e) => e);
    expect(get).toBeInstanceOf(SdoConnectionError);
    expect(sleeps).toHaveLength(2);

    const post: number[] = [];
    const body = new Uint8Array([1]);
    await expect(transport(post).send({ method: "POST", url, token: "t", api: "sync", body })).rejects.toBeInstanceOf(
      SdoConnectionError,
    );
    expect(post).toHaveLength(0);
  });

  it("retries a connect that times out before TLS completes (nothing was sent)", async () => {
    const silent = await silentServer();
    try {
      const client = new Client({ token: "t", retries: 1, backoffMs: 0, timeoutMs: 150, baseUrl: `https://127.0.0.1:${silent.port}` });
      await expect(client.scrape(TARGET)).rejects.toBeInstanceOf(SdoTimeoutError);
      expect(silent.connections()).toBe(2);
      // A POST is never retried, sent or not.
      const before = silent.connections();
      await expect(client.scrape(TARGET, { data: "x" })).rejects.toBeInstanceOf(SdoTimeoutError);
      expect(silent.connections() - before).toBe(1);
    } finally {
      await silent.close();
    }
  });

  it("does not retry a request whose response never came", () =>
    withServer(
      () => undefined, // received, never answered
      async (server) => {
        const client = new Client({ token: "t", retries: 2, backoffMs: 0, timeoutMs: 150, baseUrl: server.url });
        const err = await client.scrape(TARGET).catch((e) => e);
        expect(err).toBeInstanceOf(SdoTimeoutError);
        expect(err.message).toContain("150 ms");
        expect(server.requests).toHaveLength(1);
      },
    ));

  it("does not retry a body that stalls or a connection dropped mid-body", () =>
    withServer(
      (req, res) => {
        res.writeHead(200, { "Content-Length": "100" });
        res.write("0123456789");
        if (req.url.includes("drop")) setTimeout(() => res.destroy(), 10);
      },
      async (server) => {
        const client = new Client({ token: "t", retries: 2, backoffMs: 0, timeoutMs: 200, baseUrl: server.url });
        await expect(client.scrape(TARGET)).rejects.toBeInstanceOf(SdoTimeoutError);
        await expect(client.scrape(`${TARGET}/drop`)).rejects.toBeInstanceOf(SdoConnectionError);
        expect(server.requests).toHaveLength(2);
      },
    ));

  it("retries a pooled keep-alive socket the server had already closed", () => {
    const perSocket = new Map<unknown, number>();
    return withServer(
      (_req, res) => {
        const n = (perSocket.get(res.socket) ?? 0) + 1;
        perSocket.set(res.socket, n);
        // The second request on a kept-alive socket finds it closed.
        if (n === 2) res.socket!.destroy();
        else res.end("ok");
      },
      async (server) => {
        const client = new Client({ token: "t", retries: 2, backoffMs: 0, baseUrl: server.url });
        expect((await client.scrape(TARGET)).text).toBe("ok");
        expect((await client.scrape(TARGET)).text).toBe("ok");
        expect(server.requests).toHaveLength(3);
      },
    );
  });
});

describe("the per-attempt deadline follows the gateway timeout", () => {
  const slow = (_req: unknown, res: { end(b: string): void }) => void setTimeout(() => res.end("late"), 300);

  it("waits for a gateway timeout longer than the client's", () =>
    withServer(slow, async (server) => {
      const client = new Client({ token: "t", retries: 0, timeoutMs: 100, baseUrl: server.url });
      expect((await client.scrape(TARGET, { timeout: 5000 })).text).toBe("late");
      const err = await client.scrape(TARGET).catch((e) => e);
      expect(err).toBeInstanceOf(SdoTimeoutError);
      expect(err.message).toMatch(/^Request timed out after 100 ms/);
    }));
});

describe("the caller's AbortSignal", () => {
  it("aborts a request in flight, without a retry", () =>
    withServer(
      () => undefined,
      async (server) => {
        const client = new Client({ token: "t", retries: 2, backoffMs: 0, baseUrl: server.url });
        const controller = new AbortController();
        setTimeout(() => controller.abort(new Error("user gave up")), 50);
        const err = await client.scrape(TARGET, { signal: controller.signal }).catch((e) => e);
        expect(err).toBeInstanceOf(SdoAbortError);
        expect(err.cause.message).toBe("user gave up");
        expect(server.requests).toHaveLength(1);
      },
    ));

  it("aborts the wait before a retry, and sends nothing when already aborted", () =>
    withServer(
      (_req, res) => {
        res.writeHead(503);
        res.end();
      },
      async (server) => {
        const client = new Client({ token: "t", retries: 2, backoffMs: 10_000, baseUrl: server.url });
        const controller = new AbortController();
        setTimeout(() => controller.abort(), 50);
        const started = Date.now();
        await expect(client.scrape(TARGET, { signal: controller.signal })).rejects.toBeInstanceOf(SdoAbortError);
        expect(Date.now() - started).toBeLessThan(5000);
        expect(server.requests).toHaveLength(1);
        await expect(client.scrape(TARGET, { signal: AbortSignal.abort() })).rejects.toBeInstanceOf(SdoAbortError);
        expect(server.requests).toHaveLength(1);
      },
    ));

  it("reaches plugins and every job call, and must be an AbortSignal", async () => {
    const client = new Client({ token: "t", retries: 0, baseUrl: "http://127.0.0.1:9", asyncBaseUrl: "http://127.0.0.1:9" });
    const call = { signal: AbortSignal.abort() };
    for (const p of [
      client.plugin("google/search", {}, call),
      client.jobs.create(["https://e.com"], {}, call),
      client.jobs.status("j", call),
      client.jobs.result("j", "t", call),
      client.jobs.list({}, call),
      client.jobs.cancel("j", call),
      client.jobs.me(call),
    ]) {
      await expect(p).rejects.toBeInstanceOf(SdoAbortError);
    }
    await expect(client.scrape(TARGET, { signal: "soon" as never })).rejects.toBeInstanceOf(SdoConfigError);
    await expect(client.jobs.me("x" as never)).rejects.toBeInstanceOf(SdoConfigError);
    await expect(client.plugin("google/search", {}, { signal: {} as never })).rejects.toBeInstanceOf(SdoConfigError);
  });
});

describe("statuses reach the SDK as they are", () => {
  it("returns a target 407 under transparentResponse and raises a plain 407 once", () =>
    withServer(
      (req, res) => {
        res.writeHead(407, req.url.includes("transparentResponse") ? { "Scrape.do-Initial-Status-Code": "407" } : {});
        res.end("proxy auth");
      },
      async (server) => {
        const client = new Client({ token: "t", retries: 2, backoffMs: 0, baseUrl: server.url });
        expect((await client.scrape(TARGET, { transparentResponse: true })).statusCode).toBe(407);
        const err = await client.scrape(TARGET).catch((e) => e);
        expect(err.constructor).toBe(SdoApiError);
        expect(err.statusCode).toBe(407);
        expect(server.requests).toHaveLength(2);
      },
    ));

  it("never resends a POST answered with 421", () =>
    withServer(
      (_req, res) => {
        res.writeHead(421);
        res.end();
      },
      async (server) => {
        const client = new Client({ token: "t", retries: 2, backoffMs: 0, baseUrl: server.url });
        const err = await client.scrape(TARGET, { data: "order=1" }).catch((e) => e);
        expect(err.statusCode).toBe(421);
        expect(server.requests).toHaveLength(1);
      },
    ));
});

const MiB = 1024 * 1024;
const zeros = Buffer.alloc(8 * MiB);
const BOMBS: Array<[string, Buffer]> = [
  ["gzip", zlib.gzipSync(zeros)],
  ["deflate", zlib.deflateSync(zeros)],
  ["deflate", zlib.deflateRawSync(zeros)],
  ["br", zlib.brotliCompressSync(zeros)],
  ["gzip, br", zlib.brotliCompressSync(zlib.gzipSync(zeros))],
];

describe("decompression bombs are refused on every body path", () => {
  for (const [coding, bomb] of BOMBS) {
    it(`${coding} (${bomb.length} bytes -> 8 MiB)`, () =>
      withServer(
        (req, res) => {
          const error = req.url.includes("fail");
          res.writeHead(error ? 502 : 200, {
            "Content-Encoding": coding,
            "Content-Type": req.url.startsWith("/plugin/") ? "application/json" : "text/html",
          });
          res.end(bomb);
        },
        async (server) => {
          const client = new Client({
            token: "t",
            retries: 0,
            maxResponseBytes: MiB,
            baseUrl: server.url,
            asyncBaseUrl: server.url,
          });
          await expect(client.scrape(TARGET)).rejects.toBeInstanceOf(SdoResponseTooLargeError);
          await expect(client.plugin("google/search")).rejects.toBeInstanceOf(SdoResponseTooLargeError);
          await expect(client.jobs.result("j", "t")).rejects.toBeInstanceOf(SdoResponseTooLargeError);
          // An error body is read through its own small cap and the status still decides.
          const err = await client.scrape(`${TARGET}/fail`).catch((e) => e);
          expect(err).toBeInstanceOf(SdoGatewayError);
          expect(err.message).toBe("Gateway-origin upstream failure (HTTP 502).");
          expect(server.requests).toHaveLength(4);
        },
      ));
  }

  it("caps the raw read too, and accepts a body of exactly the limit", () =>
    withServer(
      (req, res) => {
        const size = Number(new URL(req.url, "http://x").searchParams.get("n"));
        const gz = req.url.includes("gz");
        res.writeHead(200, gz ? { "Content-Encoding": "gzip" } : {});
        res.end(gz ? zlib.gzipSync(Buffer.alloc(size, 0x61)) : Buffer.alloc(size, 0x61));
      },
      async (server) => {
        const client = new Client({ token: "t", retries: 0, maxResponseBytes: 4096, baseUrl: server.url });
        const scrape = (q: string) => client.scrape(TARGET, { extraParams: { n: q.split(":")[1], k: q.split(":")[0] } });
        expect((await scrape("raw:4096")).bytes()).toHaveLength(4096);
        await expect(scrape("raw:4097")).rejects.toBeInstanceOf(SdoResponseTooLargeError);
        expect((await scrape("gz:4096")).bytes()).toHaveLength(4096);
        await expect(scrape("gz:4097")).rejects.toBeInstanceOf(SdoResponseTooLargeError);
      },
    ));

  it("names the coding when a body cannot be decoded, and does not retry it", () =>
    withServer(
      (_req, res) => {
        res.writeHead(200, { "Content-Encoding": "br" });
        res.end(Buffer.from("definitely not brotli"));
      },
      async (server) => {
        const err = await new Client({ token: "t", retries: 2, backoffMs: 0, baseUrl: server.url })
          .scrape(TARGET)
          .catch((e) => e);
        expect(err.constructor).toBe(SdoTransportError);
        expect(err.message).toMatch(/^The response body could not be decoded \(Content-Encoding: br\)/);
        expect(server.requests).toHaveLength(1);
      },
    ));

  it("decodes at most five codings, and quotes a long header only in part", () =>
    withServer(
      (req, res) => {
        const n = Number(new URL(req.url, "http://x").searchParams.get("n"));
        let body: Buffer = Buffer.from("hello");
        for (let i = 0; i < Math.min(n, 6); i++) body = zlib.gzipSync(body);
        res.writeHead(req.url.includes("fail") ? 502 : 200, {
          "Content-Encoding": Array(n).fill("gzip").join(", "),
        });
        res.end(body);
      },
      async (server) => {
        const client = new Client({ token: "t", retries: 2, backoffMs: 0, baseUrl: server.url });
        const scrape = (n: number, path = "") => client.scrape(TARGET + path, { extraParams: { n: String(n) } });
        expect((await scrape(5)).text).toBe("hello");
        for (const n of [6, 2000]) {
          const err = await scrape(n).catch((e) => e);
          expect(err.constructor).toBe(SdoTransportError);
          expect(err.message).toMatch(
            /^The response body could not be decoded \(Content-Encoding: [a-z, ]{1,64}…?\): more than 5 content codings$/,
          );
        }
        // An error body that cannot be decoded only loses its detail (a 502 is retried).
        expect(await scrape(6, "/fail").catch((e) => e)).toBeInstanceOf(SdoGatewayError);
        expect(server.requests).toHaveLength(6);
      },
    ));
});

describe("the test suite itself", () => {
  it("cannot reach a host outside the loopback interface", async () => {
    // .invalid never resolves (RFC 2606), so this cannot leave the machine either way.
    const err = await new Client({ token: "t", retries: 0, baseUrl: "https://gw.invalid" }).scrape(TARGET).catch((e) => e);
    expect(err.message).toContain("test network guard");
  });
});

describe("the wait between attempts", () => {
  const waits = async (retryAfter: string | undefined, backoffMs = 7): Promise<number[]> => {
    const sleeps: number[] = [];
    let n = 0;
    const t = new Transport({
      timeoutMs: 2000,
      acceptEncoding: "gzip",
      retries: 1,
      backoffMs,
      userAgent: "sdo-sdk-js/test",
      maxResponseBytes: 1024,
      sleep: async (ms) => void sleeps.push(ms),
      fetchImpl: async () =>
        n++ === 0
          ? new Response(null, { status: 429, headers: retryAfter === undefined ? {} : { "retry-after": retryAfter } })
          : new Response("ok"),
    });
    await t.send({ method: "GET", url: "https://gw.test/", token: "t", api: "sync" });
    return sleeps;
  };

  it("honours Retry-After up to 30 s, and caps the backoff there too", async () => {
    expect(await waits("2")).toEqual([2000]);
    expect(await waits("3600")).toEqual([30_000]);
    expect(await waits(undefined, 10_000_000)).toEqual([30_000]);
    const [jittered] = await waits("soon", 1000);
    expect(jittered).toBeGreaterThanOrEqual(1000);
    expect(jittered).toBeLessThanOrEqual(1200);
  });
});

describe("data after the end of a complete stream", () => {
  for (const [name, body] of [
    ["deflate (zlib)", zlib.deflateSync("hello")],
    ["deflate (raw)", zlib.deflateRawSync("hello")],
  ] as const) {
    it(`is ignored for ${name}`, () =>
      withServer(
        (_req, res) => {
          res.writeHead(200, { "Content-Encoding": "deflate" });
          res.end(Buffer.concat([body, Buffer.from("\0\0garbage")]));
        },
        async (server) => {
          expect((await new Client({ token: "t", retries: 0, baseUrl: server.url }).scrape(TARGET)).text).toBe("hello");
        },
      ));
  }
});
