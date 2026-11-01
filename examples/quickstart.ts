// SPDX-License-Identifier: Apache-2.0
// Minimal quickstart. Set SDO_TOKEN in your environment first.
//
//     export SDO_TOKEN=your_token
//     npx tsx examples/quickstart.ts
//
// (From an installed package, import from "@scrape-do/sdk" instead of "../src/index.js".)
import { Client } from "../src/index.js";

const client = new Client(); // reads SDO_TOKEN
const result = await client.scrape("https://httpbin.org/anything");
console.log("status:", result.statusCode);
console.log("cost:", result.cost);
console.log("body:", result.text.slice(0, 200));
