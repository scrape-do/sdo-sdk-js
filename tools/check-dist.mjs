// SPDX-License-Identifier: Apache-2.0
//
// Checks the BUILT package (run `npm run build` first):
//
//   1. dist/ contains only this SDK's code: no bundled node_modules (cheerio and
//      its HTTP client must stay external, so their security fixes reach users
//      through a normal `npm update`).
//   2. Both the ESM and the CommonJS build load through the package `exports`
//      map, scrape through an injected fetch, load the lazily imported CJK
//      table chunk, and run selector() with cheerio.
//   3. The published types resolve for a CommonJS and an ES-module TypeScript
//      consumer under `moduleResolution: node16` (no TS1479), both with cheerio
//      installed and, in a directory outside the repository, without it
//      (cheerio is an optional peer, so the types must not need it).
//
// No network: the scrape uses a stub fetch. Runs on every supported Node.

import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");
const require = createRequire(import.meta.url);
const failures = [];
const check = (ok, message) => {
  if (!ok) failures.push(message);
};

// 1. Nothing vendored. Markers of a bundled dependency: a node_modules path,
//    undici/cheerio internals, or a bundle far larger than the SDK itself.
const MAX_BUNDLE_BYTES = 200 * 1024;
const VENDOR_MARKERS = [/node_modules\//, /\bundici\b/i, /require\(["']cheerio["']\)\.load/, /htmlparser2|parse5/];
for (const file of readdirSync(dist)) {
  const path = join(dist, file);
  const text = readFileSync(path, "utf8");
  for (const marker of VENDOR_MARKERS) check(!marker.test(text), `${file}: contains bundled code (${marker})`);
  if (/\.(c?js)$/.test(file)) check(statSync(path).size < MAX_BUNDLE_BYTES, `${file}: larger than ${MAX_BUNDLE_BYTES} bytes`);
}

// 2. Runtime smoke test of both builds, loaded by package name (self-reference
//    through the `exports` map, exactly as a consumer resolves it).
const stubFetch = async (url) =>
  url.includes("korean")
    ? new Response(Uint8Array.of(0x8c, 0x63), { headers: { "content-type": "text/html; charset=euc-kr" } })
    : new Response("<p class='x'>hi</p>", { status: 200, headers: { "content-type": "text/html" } });
async function smoke(label, sdk) {
  const client = new sdk.Client({ token: "smoke-token", fetchImpl: stubFetch, retries: 0 });
  const result = await client.scrape("https://example.com");
  check(result.text === "<p class='x'>hi</p>", `${label}: unexpected text`);
  const korean = await client.scrape("https://example.com/korean");
  check(korean.text === "\uB620", `${label}: the CJK table chunk did not load (got ${JSON.stringify(korean.text)})`);
  const $ = await result.selector();
  check($("p.x").text() === "hi", `${label}: selector() did not load cheerio`);
  check(sdk.VERSION && typeof sdk.VERSION === "string", `${label}: VERSION missing`);
  let configError = false;
  try {
    new sdk.ScrapeConfig("file:///etc/passwd");
  } catch (e) {
    configError = e instanceof sdk.SdoConfigError && e instanceof sdk.SdoError;
  }
  check(configError, `${label}: error classes not exported`);
}
await smoke("esm", await import("@scrape-do/sdk"));
await smoke("cjs", require("@scrape-do/sdk"));

// 3. Types for both module systems under node16 resolution.
const consumer = `import { Client, SdoError, type ScrapeOptions } from "@scrape-do/sdk";
const options: ScrapeOptions = { render: true };
export const run = async (): Promise<string> => {
  try {
    const result = await new Client({ token: "t" }).scrape("https://example.com", options);
    const untyped: unknown = await result.selector();
    return result.text + String(untyped);
  } catch (e) {
    return e instanceof SdoError ? e.message : "";
  }
};
`;
const withCheerio = `import type { CheerioAPI } from "cheerio";
import { Client } from "@scrape-do/sdk";
export const title = async (): Promise<string> =>
  (await (await new Client({ token: "t" }).scrape("https://example.com")).selector<CheerioAPI>())("h1").text();
`;
const tsc = join(dirname(require.resolve("typescript")), "tsc.js");
function typeCheck(dir, files, label) {
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  writeFileSync(
    join(dir, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        module: "node16",
        moduleResolution: "node16",
        target: "es2022",
        lib: ["es2022", "dom"],
        types: [],
        strict: true,
        noEmit: true,
        skipLibCheck: false,
      },
      files: Object.keys(files),
    }),
  );
  const res = spawnSync(process.execPath, [tsc, "-p", join(dir, "tsconfig.json")], { cwd: dir, encoding: "utf8" });
  check(res.status === 0, `type check of a node16 consumer ${label} failed:\n${res.stdout}${res.stderr}`);
}

// 3a. Inside the repository, where cheerio is installed (a devDependency).
const inside = join(root, ".apitmp", "consumer");
rmSync(inside, { recursive: true, force: true });
mkdirSync(inside, { recursive: true });
typeCheck(inside, { "consumer.cts": consumer, "consumer.mts": consumer, "cheerio.mts": withCheerio }, "with cheerio");
rmSync(inside, { recursive: true, force: true });

// 3b. Outside it, with only this package installed: cheerio must not resolve.
const outside = mkdtempSync(join(tmpdir(), "sdo-sdk-js-consumer-"));
try {
  const pkgDir = join(outside, "node_modules", "@scrape-do", "sdk");
  mkdirSync(pkgDir, { recursive: true });
  cpSync(join(root, "package.json"), join(pkgDir, "package.json"));
  cpSync(dist, join(pkgDir, "dist"), { recursive: true });
  let cheerioVisible = true;
  try {
    createRequire(join(outside, "x.js")).resolve("cheerio");
  } catch {
    cheerioVisible = false;
  }
  check(!cheerioVisible, `${outside}: cheerio resolves there, so the no-cheerio check would prove nothing`);
  typeCheck(outside, { "consumer.cts": consumer, "consumer.mts": consumer }, "without cheerio");
} finally {
  rmSync(outside, { recursive: true, force: true });
}

if (failures.length > 0) {
  process.stderr.write(`check-dist: ${failures.length} problem(s)\n  ${failures.join("\n  ")}\n`);
  process.exit(1);
}
process.stdout.write("check-dist: dist is self-contained; ESM, CJS and node16 types all load.\n");
