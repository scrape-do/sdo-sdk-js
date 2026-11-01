// SPDX-License-Identifier: Apache-2.0
// Every ```ts block of README.md runs, against a local server standing in for
// the gateway and the job API (through SDO_BASE_URL / SDO_ASYNC_BASE_URL), so a
// sample that no longer matches the SDK fails here.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { afterAll, describe, expect, it, vi } from "vitest";
import { startServer, type TestServer } from "./server.js";

const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
const blocks = [...readme.matchAll(/```ts\n([\s\S]*?)```/g)].map((m) => m[1]!);
const dir = new URL("./.readme/", import.meta.url);

function answer(method: string, path: string): { type: string; body: string } {
  const json = (v: unknown) => ({ type: "application/json", body: JSON.stringify(v) });
  if (path.startsWith("/plugin/")) return json({ ok: true });
  if (path === "/api/v1/jobs") return method === "POST" ? json({ JobID: "j-1", TaskIDs: ["t-1"] }) : json({ Jobs: [] });
  if (path === "/api/v1/me") return json({ AvaliableCredits: 5 });
  if (path === "/info") {
    return json({
      IsActive: true,
      ConcurrentRequest: 40,
      MaxMonthlyRequest: 3500000,
      RemainingConcurrentRequest: 15,
      RemainingMonthlyRequest: 2565023,
    });
  }
  if (/^\/api\/v1\/jobs\/[^/]+\/[^/]+$/.test(path)) return json({ TaskID: "t-1", Content: "aGk=", Base64EncodedContent: true });
  if (path.startsWith("/api/v1/jobs/")) return json({ JobID: "j-1", Tasks: [{ TaskID: "t-1" }] });
  return { type: "text/html", body: "<html><h1>Example Domain</h1></html>" };
}

let server: TestServer | undefined;
afterAll(async () => {
  await server?.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("README samples", () => {
  it("has samples", () => expect(blocks.length).toBeGreaterThan(4));

  blocks.forEach((code, i) => {
    it(`block ${i + 1} runs`, async () => {
      server ??= await startServer((req, res) => {
        const { type, body } = answer(req.method, req.url.split("?")[0]!);
        res.writeHead(200, { "Content-Type": type });
        res.end(body);
      });
      vi.stubEnv("SDO_BASE_URL", server.url);
      vi.stubEnv("SDO_ASYNC_BASE_URL", server.url);
      vi.spyOn(console, "log").mockImplementation(() => undefined);
      // A block may use `client` or `result` from the quickstart.
      const preamble = [
        /import \{[^}]*\bClient\b/.test(code) ? "" : 'import { Client } from "@scrape-do/sdk";',
        /\bconst client\b/.test(code) ? "" : 'const client = new Client({ token: "YOUR_TOKEN" });',
        !/\bresult\./.test(code) || /\bconst result\b/.test(code) ? "" : 'const result = await client.scrape("https://example.com");',
      ];
      const source = [...preamble, code, "export {};"].join("\n").replaceAll('"@scrape-do/sdk"', '"../../src/index.js"');
      mkdirSync(dir, { recursive: true });
      const file = new URL(`block-${i + 1}.ts`, dir);
      writeFileSync(file, source);
      await import(file.href);
    });
  });
});
