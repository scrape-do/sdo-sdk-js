// SPDX-License-Identifier: Apache-2.0
// JS rendering + geo targeting + CSS extraction (needs the optional 'cheerio' dependency).
//
//     export SDO_TOKEN=your_token
//     npm install cheerio
//     npx tsx examples/render_geo_and_extract.ts
//
// (From an installed package, import from "@scrape-do/sdk" instead of "../src/index.js".)
import type { CheerioAPI } from "cheerio";
import { Client, ScrapeConfig } from "../src/index.js";

const client = new Client(); // SDO_TOKEN
const cfg = new ScrapeConfig("https://example.com", {
  render: true, // JS rendering
  geoCode: "us", // route from the US
  waitUntil: "networkidle0",
  blockResources: true,
});
const result = await client.scrape(cfg);
console.log("status:", result.statusCode);

// CSS extraction via cheerio (result.selector()) works on the raw HTML:
const $ = await result.selector<CheerioAPI>();
console.log("h1:", $("h1").first().text());

// For Markdown instead of HTML, ask the gateway for it in a separate scrape:
const md = await client.scrape("https://example.com", { render: true, output: "markdown" });
console.log(md.text.slice(0, 200));
