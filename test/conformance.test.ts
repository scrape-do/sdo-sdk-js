// SPDX-License-Identifier: Apache-2.0
// Cross-language conformance: this SDK must match the shared generated corpus
// (copied here by the codegen factory, never edited by hand). Every section of
// the corpus is consumed below; a case whose `skip` lists "js" is skipped, and
// an unknown section, key or case field fails the run.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { Client } from "../src/client.js";
import { ScrapeConfig, type ScrapeOptions } from "../src/config.js";
import { MAX_REQUEST_COST } from "../src/headers.js";
import {
  redactSecrets,
  SdoApiError,
  SdoAuthError,
  SdoConcurrencyError,
  SdoConfigError,
  SdoGatewayError,
  SdoTransportError,
  SdoValidationError,
} from "../src/errors.js";
import { ID_PATTERN } from "../src/jobs.js";
import { ROUTE_PATTERN } from "../src/plugins.js";
import { pctEncode } from "../src/query.js";
import { ScrapeResult } from "../src/response.js";
import {
  BILLED_STATUSES,
  effectiveTimeoutMs,
  ERROR_BODY_READ_BYTES,
  GATEWAY_TIMEOUT_MARGIN_MS,
  MAX_BACKOFF_MS,
  MAX_RESPONSE_BYTES,
  parseRetryAfter,
  retryAfterDelayMs,
  RETRYABLE_STATUSES,
} from "../src/transport.js";
import { VERSION } from "../src/version.js";
import corpus from "./conformance.json";
import { bodyText, header, mockFetch, rawQuery } from "./helpers.js";
import { received, withServer } from "./server.js";

type Pairs = Array<[string, string]>;
interface Case {
  name: string;
  js: Record<string, unknown>;
  expect: string[][];
  ordered?: boolean;
  error?: string;
  skip?: string[];
}

const skipped = (c: { skip?: string[] }): boolean => (c.skip ?? []).includes("js");
const caseIt = (c: { skip?: string[] }) => (skipped(c) ? it.skip : it);

const norm = (pairs: Pairs) =>
  [...pairs].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, v]) => `${k}=${v}`);
const flat = (pairs: Pairs) => pairs.map(([k, v]) => `${k}=${v}`);

const ok = (body: BodyInit | null = "ok", init: ResponseInit = {}) => new Response(body, init);
const hex = (h: string) => Uint8Array.from(Buffer.from(h, "hex"));

describe("corpus integrity", () => {
  it("matches its sha256 sidecar (no hand edits)", () => {
    const bytes = readFileSync(new URL("./conformance.json", import.meta.url));
    const sidecar = readFileSync(new URL("./conformance.json.sha256", import.meta.url), "utf8").trim().split(/\s+/)[0];
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(sidecar);
  });
});

// Every section, sub-section and case field this harness understands. A corpus
// that grows a new one fails here until the harness consumes it.
const SERIAL_FIELDS = ["name", "py", "js", "go", "expect", "ordered", "error", "skip"];
const CASE_FIELDS: Record<string, readonly string[]> = {
  serialization: SERIAL_FIELDS,
  edge: SERIAL_FIELDS,
  "wire.scrape": ["name", "py", "js", "go", "token", "path", "query", "skip"],
  "wire.plugin": ["name", "route", "params", "token", "path", "query", "skip"],
  "wire.plugin_errors": ["name", "route", "params", "skip"],
  "wire.prefixed": ["name", "base_url", "async_base_url", "scrape_path", "plugin_path", "jobs_path", "skip"],
  "wire.routes": ["route", "valid"],
  requests: ["name", "method", "json", "data", "headers", "expect_method", "body", "content_type", "error",
    "expect_headers", "expect_header_names", "ignore_header_names", "skip"],
  "retry.attempts": ["name", "method", "status", "retries", "attempts", "transparent", "headers"],
  "retry.retry_after": ["value", "seconds"],
  errors: ["name", "status", "kind", "billed", "retryable", "transparent", "headers", "body", "message",
    "retained_body_chars", "cost"],
  decoding: ["name", "body_hex", "content_type", "text"],
  decompression: ["name", "content_encoding", "body_hex", "text", "error", "attempts"],
  json_bodies: ["name", "body_hex", "value", "error"],
  redaction: ["name", "token", "input", "output"],
  "jobs.task_results": ["name", "json", "expect", "absent", "content_bytes_error"],
  "jobs.ids": ["id", "valid"],
  "jobs.errors": ["name", "status", "body", "kind", "message", "billed"],
  "jobs.create": ["name", "targets", "options", "body", "error"],
  "jobs.account": ["name", "json", "expect"],
  "client.base_urls": ["url", "ok"],
  "client.timeouts": ["value", "seconds"],
  "client.effective_timeouts": ["client_seconds", "config_timeout_ms", "seconds"],
  "client.tokens": ["value", "token"],
  "client.target_urls": ["url", "ok"],
};

describe("corpus coverage", () => {
  it("has no section or key this harness does not consume", () => {
    expect(Object.keys(corpus).sort()).toEqual(
      ["client", "contract", "decoding", "decompression", "edge", "errors", "jobs", "json_bodies", "redaction",
        "requests", "retry", "serialization", "url", "version", "wire"].sort(),
    );
    expect(Object.keys(corpus.wire).sort()).toEqual(["plugin", "plugin_errors", "prefixed", "routes", "scrape"]);
    expect(Object.keys(corpus.retry).sort()).toEqual(["attempts", "retry_after"]);
    expect(Object.keys(corpus.jobs).sort()).toEqual(
      ["account", "auth_header", "cancel_bodies", "create", "errors", "id_pattern", "ids", "task_results"],
    );
    expect(Object.keys(corpus.client).sort()).toEqual(
      ["base_urls", "effective_timeouts", "empty_token_falls_back_to_env", "insecure_opt_in", "target_urls",
        "timeouts", "tokens"],
    );
    expect(Object.keys(corpus.contract).sort()).toEqual(
      ["decoding", "environment", "errors", "json_bodies", "plugin_route_pattern", "redaction", "serialization",
        "transport", "user_agent"],
    );
  });

  it("has no case field this harness does not read", () => {
    const at = (path: string): unknown =>
      path.split(".").reduce<unknown>((o, k) => (o as Record<string, unknown>)[k], corpus);
    for (const [path, fields] of Object.entries(CASE_FIELDS)) {
      for (const c of at(path) as Array<Record<string, unknown>>) {
        for (const key of Object.keys(c)) expect(fields, `${path}: unknown case field '${key}'`).toContain(key);
      }
    }
  });
});

function runCase(c: Case): void {
  const build = () => new ScrapeConfig(corpus.url, c.js as ScrapeOptions).toParams();
  if (c.error === "config") {
    expect(build).toThrow(SdoConfigError);
    return;
  }
  const want = c.expect as Pairs;
  // `ordered` cases compare positionally, which pins query-string order too.
  if (c.ordered) expect(flat(build())).toEqual(flat(want));
  else expect(norm(build())).toEqual(norm(want));
}

describe("serialization conformance", () => {
  for (const c of corpus.serialization as Case[]) caseIt(c)(c.name, () => runCase(c));
});

describe("edge conformance", () => {
  // Unset values, the render gate, enums, ranges, canonical JSON, extraParams.
  for (const c of corpus.edge as Case[]) caseIt(c)(c.name, () => runCase(c));
});

const jsonOk = () => ok("{}", { headers: { "content-type": "application/json" } });

describe("wire conformance", () => {
  // Asserted on the URL handed to the transport, byte for byte: nothing re-parses it.
  type WireCase = { name: string; js: Record<string, unknown>; token: string; path: string; query: string; skip?: string[] };
  for (const c of corpus.wire.scrape as unknown as WireCase[]) {
    caseIt(c)(`scrape ${c.name}`, async () => {
      const f = mockFetch(() => ok());
      await new Client({ token: c.token, retries: 0, fetchImpl: f }).scrape(corpus.url, c.js as ScrapeOptions);
      expect(f.calls).toHaveLength(1);
      const url = f.calls[0]!.url;
      expect(new URL(url).pathname).toBe(c.path);
      expect(rawQuery(url)).toBe(c.query);
    });
  }

  type PluginCase = { name: string; route: string; params: Record<string, unknown>; token: string; path: string;
    query: string; skip?: string[] };
  for (const c of corpus.wire.plugin as PluginCase[]) {
    caseIt(c)(`plugin ${c.name}`, async () => {
      const f = mockFetch(jsonOk);
      await new Client({ token: c.token, retries: 0, fetchImpl: f }).plugin(c.route, c.params);
      const url = f.calls[0]!.url;
      expect(new URL(url).pathname).toBe(c.path);
      expect(rawQuery(url)).toBe(c.query);
    });
  }

  for (const c of corpus.wire.plugin_errors as Array<{ name: string; route: string; params: Record<string, unknown>;
    skip?: string[] }>) {
    caseIt(c)(`plugin error ${c.name}`, async () => {
      const f = mockFetch(jsonOk);
      await expect(new Client({ token: "TOK", fetchImpl: f }).plugin(c.route, c.params)).rejects.toBeInstanceOf(
        SdoConfigError,
      );
      expect(f.calls).toHaveLength(0);
    });
  }

  for (const c of corpus.wire.prefixed as Array<{ name: string; base_url: string; async_base_url: string;
    scrape_path: string; plugin_path: string; jobs_path: string; skip?: string[] }>) {
    caseIt(c)(`prefixed ${c.name}`, async () => {
      const f = mockFetch((u) => (u.includes("/api/v1/") ? ok("{}") : jsonOk()));
      const client = new Client({ token: "TOK", baseUrl: c.base_url, asyncBaseUrl: c.async_base_url, fetchImpl: f });
      await client.scrape(corpus.url);
      await client.plugin("google/search");
      await client.jobs.status("j-1");
      expect(f.calls.map((call) => new URL(call.url).pathname)).toEqual([c.scrape_path, c.plugin_path, c.jobs_path]);
    });
  }

  for (const c of corpus.wire.routes) {
    it(`route ${JSON.stringify(c.route)} valid=${c.valid}`, async () => {
      const f = mockFetch(jsonOk);
      const call = new Client({ token: "TOK", retries: 0, fetchImpl: f }).plugin(c.route, {});
      if (c.valid) {
        await expect(call).resolves.toEqual({});
        expect(new URL(f.calls[0]!.url).pathname).toBe(`/plugin/${c.route}`);
      } else {
        await expect(call).rejects.toBeInstanceOf(SdoConfigError);
        expect(f.calls).toHaveLength(0);
      }
    });
  }
});

interface RequestCase {
  name: string;
  method?: string | null;
  json?: unknown;
  data?: string;
  headers?: Record<string, string>;
  expect_method?: string;
  body?: string | null;
  content_type?: string | null;
  expect_headers?: Record<string, string[]>;
  expect_header_names?: string[];
  ignore_header_names?: string[];
  error?: string;
  skip?: string[];
}

describe("requests conformance", () => {
  // Through the default transport to a local server: what arrives is what was sent.
  for (const c of corpus.requests as RequestCase[]) {
    caseIt(c)(c.name, () =>
      withServer(
        (_req, res) => void res.end("ok"),
        async (server) => {
          const client = new Client({ token: "TOK", retries: 0, baseUrl: server.url });
          // Only the inputs the case names are passed ("absent = not given").
          const req: Record<string, unknown> = {};
          for (const key of ["method", "json", "data", "headers"] as const) if (key in c) req[key] = c[key];
          const call = client.scrape(corpus.url, req as ScrapeOptions);
          if (c.error === "config") {
            await expect(call).rejects.toBeInstanceOf(SdoConfigError);
            expect(server.requests).toHaveLength(0);
            return;
          }
          await call;
          const sent = server.requests[0]!;
          expect(sent.method).toBe(c.expect_method);
          expect(sent.body.toString("utf8")).toBe(c.body ?? "");
          if (c.body === null) expect(received(sent, "transfer-encoding")).toEqual([]);
          expect(received(sent, "content-type")).toEqual(c.content_type === null ? [] : [c.content_type]);
          for (const [name, values] of Object.entries(c.expect_headers ?? {})) {
            expect(received(sent, name), name).toEqual(values);
          }
          if (c.expect_header_names !== undefined) {
            // The full set of names sent, minus the HTTP layer's own framing headers.
            const ignored = new Set(c.ignore_header_names ?? []);
            const names = [...new Set(sent.headers.map(([k]) => k.toLowerCase()))].filter((k) => !ignored.has(k));
            expect(names.sort()).toEqual([...c.expect_header_names].sort());
          }
        },
      ),
    );
  }
});

describe("retry conformance", () => {
  for (const c of corpus.retry.attempts as Array<{
    name: string; method: string; status: number; retries: number; attempts: number; transparent?: boolean;
    headers?: Record<string, string>;
  }>) {
    it(`attempts ${c.name}`, async () => {
      const f = mockFetch(() => new Response(null, { status: c.status, headers: c.headers ?? {} }));
      const client = new Client({ token: "TOK", retries: c.retries, backoffMs: 0, fetchImpl: f });
      await client
        .scrape(corpus.url, {
          method: c.method,
          ...(c.method === "GET" ? {} : { data: "x" }),
          ...(c.transparent ? { transparentResponse: true } : {}),
        })
        .catch(() => undefined);
      expect(f.calls).toHaveLength(c.attempts);
    });
  }

  for (const c of corpus.retry.retry_after) {
    it(`Retry-After ${JSON.stringify(c.value)}`, () => {
      expect(parseRetryAfter(c.value) ?? null).toBe(c.seconds);
    });
  }
});

const KINDS: Record<string, abstract new (...args: never[]) => Error> = {
  api: SdoApiError,
  auth: SdoAuthError,
  validation: SdoValidationError,
  concurrency: SdoConcurrencyError,
  gateway: SdoGatewayError,
  transport: SdoTransportError,
};

function expectKind(err: unknown, kind: string): void {
  expect(err).toBeInstanceOf(KINDS[kind]!);
  // "api" is the base class itself, for statuses no subclass claims.
  if (kind === "api") expect((err as Error).constructor).toBe(SdoApiError);
}

type ErrorCase = {
  name: string; status: number; kind: string | null; billed: boolean; retryable: boolean;
  transparent?: boolean; headers?: Record<string, string>; body?: string; message?: string | null;
  retained_body_chars?: number; cost?: number | null;
};

function checkErrorCase(c: ErrorCase, outcome: unknown): void {
  if (c.kind === null) {
    expect((outcome as ScrapeResult).statusCode).toBe(c.status);
    const raw = Object.entries(c.headers ?? {}).find(([k]) => k.toLowerCase() === "scrape.do-request-cost")?.[1];
    if (raw !== undefined) expect((outcome as ScrapeResult).cost).toBe(Number(raw));
    return;
  }
  const err = outcome as SdoApiError;
  expectKind(err, c.kind);
  expect(err.statusCode).toBe(c.status);
  expect(err.billed).toBe(c.billed);
  expect(err.isRetryable).toBe(c.retryable);
  if (c.message !== undefined && c.message !== null) expect(err.message).toBe(c.message);
  // null: no readable cost.
  if (c.cost !== undefined) expect(err.cost).toBe(c.cost ?? undefined);
  if (c.retained_body_chars !== undefined) expect([...(err.body ?? "")].length).toBe(c.retained_body_chars);
}

describe("errors conformance", () => {
  for (const c of corpus.errors as ErrorCase[]) {
    const options = c.transparent ? { transparentResponse: true } : {};
    it(`${c.name} (fetchImpl)`, async () => {
      const f = mockFetch(() => new Response(c.body ?? null, { status: c.status, headers: c.headers ?? {} }));
      const client = new Client({ token: "TOK", retries: 0, backoffMs: 0, fetchImpl: f });
      checkErrorCase(c, await client.scrape(corpus.url, options).catch((e: unknown) => e));
    });

    // A plugin call shares the status rules (it has no transparent mode).
    if (!c.transparent) {
      it(`${c.name} (plugin)`, async () => {
        const f = mockFetch(() => new Response(c.body ?? null, { status: c.status, headers: c.headers ?? {} }));
        const client = new Client({ token: "TOK", retries: 0, backoffMs: 0, fetchImpl: f });
        const outcome = await client.plugin("google/search", { q: "x" }).catch((e: unknown) => e);
        if (c.kind === null) {
          expect(outcome).not.toBeInstanceOf(Error);
          return;
        }
        const err = outcome as SdoApiError;
        expectKind(err, c.kind);
        expect(err.billed).toBe(c.billed);
        if (c.cost !== undefined) expect(err.cost).toBe(c.cost ?? undefined);
        if (c.message !== undefined && c.message !== null) expect(err.message).toBe(c.message);
      });
    }

    it(`${c.name} (default transport)`, () =>
      withServer(
        (_req, res) => {
          res.writeHead(c.status, c.headers ?? {});
          res.end(c.body ?? "");
        },
        async (server) => {
          const client = new Client({ token: "TOK", retries: 0, backoffMs: 0, baseUrl: server.url });
          checkErrorCase(c, await client.scrape(corpus.url, options).catch((e: unknown) => e));
        },
      ),
    );
  }
});

describe("decoding conformance", () => {
  // Built the way the SDK builds every result: through a scrape.
  for (const c of corpus.decoding) {
    it(c.name, async () => {
      const f = mockFetch(() => ok(hex(c.body_hex), { headers: c.content_type ? { "content-type": c.content_type } : {} }));
      const result = await new Client({ token: "TOK", fetchImpl: f }).scrape(corpus.url);
      expect(result.text).toBe(c.text);
    });
  }
});

describe("decompression conformance", () => {
  // Served with the case's Content-Encoding, so the SDK's own decoder runs.
  for (const c of corpus.decompression as Array<{ name: string; content_encoding: string; body_hex: string;
    text?: string; error?: string; attempts?: number }>) {
    it(c.name, () =>
      withServer(
        (_req, res) => {
          res.writeHead(200, { "Content-Encoding": c.content_encoding });
          res.end(Buffer.from(c.body_hex, "hex"));
        },
        async (server) => {
          const client = new Client({ token: "TOK", retries: 2, backoffMs: 0, baseUrl: server.url });
          const outcome = await client.scrape(corpus.url).catch((e: unknown) => e);
          if (c.error !== undefined) {
            expectKind(outcome, c.error);
            // Never retried: the 2xx was already billed.
            expect(server.requests).toHaveLength(c.attempts!);
          } else {
            expect((outcome as ScrapeResult).text).toBe(c.text);
          }
        },
      ),
    );
  }
});

describe("json_bodies conformance", () => {
  for (const c of corpus.json_bodies as Array<{ name: string; body_hex: string; value?: unknown; error?: string }>) {
    it(c.name, async () => {
      const bytes = hex(c.body_hex);
      const result = new ScrapeResult({ content: bytes, statusCode: 200, headers: {}, url: corpus.url });
      const f = mockFetch(() => ok(bytes, { headers: { "content-type": "application/json" } }));
      const client = new Client({ token: "TOK", retries: 0, fetchImpl: f });
      const plugin = await client.plugin("google/search").catch((e: unknown) => e);
      if (c.error !== undefined) {
        expect(() => result.json()).toThrow(KINDS[c.error]!);
        expectKind(plugin, c.error);
        // A job response must be a JSON object, so it fails here as well.
        expectKind(await client.jobs.me().catch((e: unknown) => e), c.error);
      } else {
        expect(result.json()).toEqual(c.value);
        expect(plugin).toEqual(c.value);
      }
    });
  }
});

describe("redaction conformance", () => {
  for (const c of corpus.redaction) {
    it(c.name, () => {
      expect(redactSecrets(c.input, c.token)).toBe(c.output);
    });
  }
});

const camel = (snake: string) => snake.replace(/_([a-z0-9])/g, (_, ch: string) => ch.toUpperCase());
const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const VALID_ID = corpus.jobs.ids.find((c) => c.valid)!.id;
const jobsClient = (f: ReturnType<typeof mockFetch>) => new Client({ token: "TOK", retries: 0, fetchImpl: f }).jobs;

describe("jobs conformance", () => {
  for (const c of corpus.jobs.task_results as Array<{ name: string; json: unknown; expect: Record<string, unknown>;
    absent?: string[]; content_bytes_error?: string }>) {
    it(`task result ${c.name}`, async () => {
      const r = await jobsClient(mockFetch(() => jsonResponse(c.json))).result(VALID_ID, VALID_ID);
      const fields = r as unknown as Record<string, unknown>;
      for (const [key, want] of Object.entries(c.expect)) {
        if (key === "content_bytes_hex") expect(Buffer.from(r.contentBytes()).toString("hex")).toBe(want);
        else expect(fields[camel(key)], key).toEqual(want);
      }
      for (const key of c.absent ?? []) expect(fields[camel(key)], key).toBeUndefined();
      if (c.content_bytes_error !== undefined) expect(() => r.contentBytes()).toThrow(KINDS[c.content_bytes_error]!);
    });
  }

  for (const c of corpus.jobs.ids) {
    it(`id ${JSON.stringify(c.id).slice(0, 40)} valid=${c.valid}`, async () => {
      const f = mockFetch(() => jsonResponse({}));
      const jobs = jobsClient(f);
      const calls = [jobs.status(c.id), jobs.result(c.id, VALID_ID), jobs.result(VALID_ID, c.id), jobs.cancel(c.id)];
      if (c.valid) {
        await Promise.all(calls);
        expect(new URL(f.calls[0]!.url).pathname).toBe(`/api/v1/jobs/${c.id}`);
        expect(new URL(f.calls[2]!.url).pathname).toBe(`/api/v1/jobs/${VALID_ID}/${c.id}`);
      } else {
        for (const call of calls) await expect(call).rejects.toBeInstanceOf(SdoConfigError);
        expect(f.calls).toHaveLength(0);
      }
    });
  }

  for (const c of corpus.jobs.errors as Array<{ name: string; status: number; body: string; kind: string;
    message: string | null; billed?: boolean }>) {
    it(`error ${c.name}`, async () => {
      const f = mockFetch(() => new Response(c.body === "" ? null : c.body, { status: c.status }));
      const err = await new Client({ token: "TOK", retries: 0, backoffMs: 0, fetchImpl: f }).jobs
        .status(VALID_ID)
        .catch((e: unknown) => e);
      expectKind(err, c.kind);
      if (c.message !== null) expect((err as Error).message).toBe(c.message);
      if (c.billed !== undefined) expect((err as SdoApiError).billed).toBe(c.billed);
      // Never followed: one request, sent with redirect handling left to the SDK.
      expect(f.calls).toHaveLength(1);
      expect(f.calls[0]!.init?.redirect).toBe("manual");
    });
  }

  for (const c of corpus.jobs.create as Array<{
    name: string; targets: string[]; options: Record<string, unknown>; body?: string; error?: string;
  }>) {
    it(`create ${c.name}`, async () => {
      const f = mockFetch(() => jsonResponse({ JobID: "j" }));
      const call = new Client({ token: "TOKEN-123456", retries: 0, fetchImpl: f }).jobs.create(c.targets, c.options);
      if (c.error === "config") {
        await expect(call).rejects.toBeInstanceOf(SdoConfigError);
        expect(f.calls).toHaveLength(0);
        return;
      }
      await call;
      const { url, init } = f.calls[0]!;
      expect(bodyText(init)).toBe(c.body);
      // The token travels only in the auth header, never in the URL.
      expect(header(init, corpus.jobs.auth_header)).toBe("TOKEN-123456");
      expect(url).not.toContain("TOKEN-123456");
    });
  }

  for (const c of corpus.jobs.account as Array<{ name: string; json: unknown; expect: Record<string, unknown> }>) {
    it(`account ${c.name}`, async () => {
      const f = mockFetch(() => jsonResponse(c.json));
      const account = (await jobsClient(f).me()) as unknown as Record<string, unknown>;
      expect(new URL(f.calls[0]!.url).pathname).toBe("/api/v1/me");
      for (const [key, want] of Object.entries(c.expect)) expect(account[camel(key)], key).toEqual(want);
    });
  }

  for (const body of corpus.jobs.cancel_bodies) {
    it(`cancel ignores the body ${JSON.stringify(body)}`, async () => {
      const f = mockFetch(() => new Response(body === "" ? null : body, { status: 200 }));
      await expect(jobsClient(f).cancel(VALID_ID)).resolves.toBeUndefined();
      expect(f.calls[0]!.init?.method).toBe("DELETE");
    });
  }
});

/** Clear one SDO_* variable for the rest of the test (setup.ts restores it). */
const unsetEnv = (name: string) => vi.stubEnv(name, undefined);

describe("client conformance", () => {
  for (const c of corpus.client.base_urls) {
    it(`base url ${JSON.stringify(c.url)} ok=${c.ok}`, () => {
      const variants: Array<[string | undefined, () => Client]> = [
        [undefined, () => new Client({ token: "TOK", baseUrl: c.url })],
        [undefined, () => new Client({ token: "TOK", asyncBaseUrl: c.url })],
        ["SDO_BASE_URL", () => new Client({ token: "TOK" })],
        ["SDO_ASYNC_BASE_URL", () => new Client({ token: "TOK" })],
      ];
      for (const [envName, make] of variants) {
        if (envName) vi.stubEnv(envName, c.url);
        if (c.ok) expect(make).not.toThrow();
        else expect(make).toThrow(SdoConfigError);
        if (envName) unsetEnv(envName);
      }
    });
  }

  it("accepts plain http with the explicit opt-in", () => {
    const { url, ok: allowed } = corpus.client.insecure_opt_in;
    expect(allowed).toBe(true);
    expect(() => new Client({ token: "TOK", baseUrl: url })).toThrow(SdoConfigError);
    expect(new Client({ token: "TOK", baseUrl: url, allowInsecureHttp: true }).baseUrl).toBe(url);
    expect(new Client({ token: "TOK", asyncBaseUrl: url, allowInsecureHttp: true }).asyncBaseUrl).toBe(url);
  });

  for (const c of corpus.client.timeouts) {
    it(`SDO_TIMEOUT=${JSON.stringify(c.value)}`, () => {
      vi.stubEnv("SDO_TIMEOUT", c.value);
      if (c.seconds === null) expect(() => new Client({ token: "TOK" })).toThrow(SdoConfigError);
      else expect(new Client({ token: "TOK" }).timeoutMs).toBe(c.seconds * 1000);
    });
  }

  for (const c of corpus.client.effective_timeouts) {
    it(`effective timeout ${c.client_seconds}s with gateway ${c.config_timeout_ms}ms`, () => {
      expect(effectiveTimeoutMs(c.client_seconds * 1000, c.config_timeout_ms) / 1000).toBe(c.seconds);
    });
  }

  for (const c of corpus.client.tokens) {
    it(`token ${JSON.stringify(c.value)}`, async () => {
      vi.stubEnv("SDO_TOKEN", "ENVTOKEN");
      if (c.token === null) {
        expect(() => new Client({ token: c.value })).toThrow(SdoConfigError);
        return;
      }
      const f = mockFetch(() => ok());
      await new Client({ token: c.value, fetchImpl: f }).scrape(corpus.url);
      // "" after trimming means "not given": the environment's token is used.
      expect(rawQuery(f.calls[0]!.url).startsWith(`token=${c.token === "" ? "ENVTOKEN" : c.token}&`)).toBe(true);
    });
  }

  it("an empty token falls back to SDO_TOKEN", async () => {
    expect(corpus.client.empty_token_falls_back_to_env).toBe(true);
    vi.stubEnv("SDO_TOKEN", "ENVTOKEN");
    const f = mockFetch(() => ok());
    await new Client({ token: "", fetchImpl: f }).scrape(corpus.url);
    expect(rawQuery(f.calls[0]!.url).startsWith("token=ENVTOKEN&")).toBe(true);
  });

  for (const c of corpus.client.target_urls) {
    it(`target url ${JSON.stringify(c.url)} ok=${c.ok}`, async () => {
      const f = mockFetch(() => ok());
      const scrape = new Client({ token: "TOK", retries: 0, fetchImpl: f }).scrape(c.url);
      if (c.ok) {
        expect(new ScrapeConfig(c.url).url).toBe(c.url);
        await scrape;
        // Sent exactly as given: no normalisation before encoding.
        expect(rawQuery(f.calls[0]!.url)).toBe(`token=TOK&url=${pctEncode(c.url)}`);
      } else {
        expect(() => new ScrapeConfig(c.url)).toThrow(SdoConfigError);
        await expect(scrape).rejects.toBeInstanceOf(SdoConfigError);
        expect(f.calls).toHaveLength(0);
      }
    });
  }
});

describe("contract constants", () => {
  const contract = corpus.contract;

  it("serialization flags are the ones implemented", () => {
    expect(contract.serialization).toMatchObject({
      omit_false_booleans: true,
      omit_zero_values: true,
      json_object_keys: "sorted",
      json_key_order: "code_point",
      json_html_escape: false,
      json_line_separators: "literal",
      numbers: "ecmascript",
      query_order: "spec_then_extra_sorted",
      extra_params_order: "sorted",
      extra_params_reserved: ["token", "url"],
      enums: "lowercase",
    });
  });

  it("decoding and size ceilings", () => {
    expect(contract.decoding.algorithm).toBe("whatwg");
    expect(contract.decoding.meta_sniff_bytes).toBe(1024);
    expect(MAX_RESPONSE_BYTES).toBe(contract.decoding.max_decompressed_bytes);
    expect(MAX_RESPONSE_BYTES).toBe(contract.decoding.max_response_bytes);
    expect(contract.json_bodies).toEqual({ invalid_utf8: "replace", non_finite_numbers: "reject" });
  });

  it("transport and retry", () => {
    const t = contract.transport;
    expect(t).toMatchObject({
      client_timeout: "total",
      follow_redirects: false,
      https_only: true,
      empty_token_is_unset: true,
      token_trim: "ascii_whitespace",
      header_names: "rfc9110_token",
      header_values: "printable_ascii",
    });
    expect(t.insecure_http_hosts).toEqual(["localhost", "127.0.0.1", "::1"]);
    expect(t.base_url_parts).toEqual(["scheme", "host", "port", "path_prefix"]);
    expect(t.forbidden_headers).toEqual(["host", "content-length", "transfer-encoding", "connection"]);
    expect(t.content_codings).toEqual(["gzip", "x-gzip", "deflate", "br"]);
    expect(t.effective_timeout).toBe("max(client_timeout, config.timeout_ms / 1000 + margin)");
    expect(GATEWAY_TIMEOUT_MARGIN_MS).toBe(t.gateway_timeout_margin_seconds * 1000);
    expect(new Client({ token: "TOK" }).timeoutMs).toBe(t.default_timeout_seconds * 1000);
    expect([...RETRYABLE_STATUSES].sort((a, b) => a - b)).toEqual(t.retry.retryable_statuses);
    expect(t.retry).toMatchObject({
      default_retries: 2,
      non_idempotent_methods: ["POST", "PUT", "PATCH", "DELETE"],
      non_idempotent_retry_statuses: [429],
      retry_after: "seconds",
      max_backoff_seconds: 30,
      negative_retries: "clamp_to_zero",
      retry_after_send: false,
    });
    // The SDK's own cap, not just the corpus value: an hour-long Retry-After waits 30 s.
    expect(MAX_BACKOFF_MS).toBe(t.retry.max_backoff_seconds * 1000);
    expect(retryAfterDelayMs(3600)).toBe(t.retry.max_backoff_seconds * 1000);
    expect(retryAfterDelayMs(2)).toBe(2000);
  });

  it("error defaults", () => {
    const e = contract.errors;
    expect(ERROR_BODY_READ_BYTES).toBe(e.error_body_read_bytes);
    expect(e.async_billed).toBe(false);
    expect([...BILLED_STATUSES].sort((a, b) => a - b)).toEqual(e.billed_statuses);
    // Pinned by the errors cases; the names are the rules targetAnswered and
    // buildError implement.
    expect(e.target_origin).toBe("request_cost_positive");
    expect(e.billed).toBe("request_cost_else_billed_statuses");
    expect(e.request_cost).toEqual({ values: 1, trim: " \t", digits: "ascii", max: MAX_REQUEST_COST });
    expect(e.envelope_keys).toEqual(["message", "error"]);
    expect(Object.keys(e.default_messages).sort()).toEqual(
      ["api", "auth", "canceled", "concurrency", "gateway", "redirect", "validation"],
    );
  });

  it("environment variables", () => {
    expect(Object.keys(contract.environment).sort()).toEqual(
      ["SDO_ASYNC_BASE_URL", "SDO_BASE_URL", "SDO_TIMEOUT", "SDO_TOKEN"],
    );
  });

  it("user agent, routes, ids and redaction", async () => {
    const f = mockFetch(() => ok());
    await new Client({ token: "TOK", fetchImpl: f }).scrape(corpus.url);
    const ua = header(f.calls[0]!.init, "user-agent")!;
    expect(ua).toBe(contract.user_agent.sdk.replace("<lang>", "js").replace("<version>", VERSION));
    expect(ua).toMatch(new RegExp(contract.user_agent.pattern));
    expect(ROUTE_PATTERN.source).toBe(contract.plugin_route_pattern);
    expect(ID_PATTERN.source).toBe(corpus.jobs.id_pattern);
    expect(corpus.jobs.auth_header).toBe("X-Token");
    expect(contract.redaction).toMatchObject({ mask: "***", literal_token: true, literal_min_length: 8 });
    expect(redactSecrets("x 12345678 y", "12345678")).toBe("x *** y");
    expect(redactSecrets("x 1234567 y", "1234567")).toBe("x 1234567 y");
  });
});
