// SPDX-License-Identifier: Apache-2.0
// Generic plugin calls and the async (q.scrape.do) job surface.
//
//     export SDO_TOKEN=your_token
//     npx tsx examples/plugins_and_async.ts
//
// (From an installed package, import from "@scrape-do/sdk" instead of "../src/index.js".)
import { Client } from "../src/index.js";

const client = new Client(); // SDO_TOKEN

// Generic plugin core — any documented plugin, no SDK release needed:
const shopping = await client.plugin("google/shopping", { q: "laptop", gl: "us" });
console.log("plugin result type:", typeof shopping);

// Async delivery via the q.scrape.do REST job API (client.jobs.*). Auth is the
// client token, sent as the X-Token header. `options` are merged verbatim into
// the job body using the API's own PascalCase keys (Super, GeoCode, Render, …).
const job = await client.jobs.create(["https://example.com", "https://example.org"], {
  Super: true,
  GeoCode: "us",
});
console.log("created job:", job.jobId, "tasks:", job.taskIds);

// Response fields the API leaves out read as undefined.
const jobId = job.jobId!;
const status = await client.jobs.status(jobId);
console.log("job status:", status.status);

// Pull a finished task's scraped payload:
const taskId = status.tasks[0]?.taskId;
if (taskId !== undefined) {
  const result = await client.jobs.result(jobId, taskId);
  console.log("task result:", result.statusCode, (result.content ?? "").slice(0, 120));
}

// List every job, inspect account concurrency/credits, or cancel a pending job:
console.log("all jobs:", (await client.jobs.list()).length);
const account = await client.jobs.me();
console.log("credits:", account.availableCredits, "free concurrency:", account.freeConcurrency);
// await client.jobs.cancel(jobId);
