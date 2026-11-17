// SPDX-License-Identifier: Apache-2.0
// sdo — official JavaScript/TypeScript SDK for the Scrape.do web-scraping API.
//
//   import { Client } from "@scrape-do/sdo-client";
//   const client = new Client({ token: "YOUR_TOKEN" }); // or SDO_TOKEN
//   const result = await client.scrape("https://example.com", { render: true });
//   console.log(result.statusCode, result.text.slice(0, 200));
export { Client, type ClientOptions } from "./client.js";
export { ScrapeConfig, type ScrapeOptions } from "./config.js";
export {
  type ApiErrorOptions,
  redactSecrets,
  SdoAbortError,
  SdoApiError,
  SdoAuthError,
  SdoConcurrencyError,
  SdoConfigError,
  SdoConnectionError,
  SdoError,
  type SdoErrorOptions,
  SdoGatewayError,
  SdoResponseTooLargeError,
  SdoTimeoutError,
  SdoTransportError,
  SdoValidationError,
} from "./errors.js";
export type { FetchLike } from "./http.js";
export {
  type Account,
  type AsyncJobs,
  type CallOptions,
  JOB_SORTS,
  JOB_STATUSES,
  type Job,
  type JobPage,
  type JobSort,
  type JobStatus,
  type JobStatusValue,
  type ListJobsOptions,
  MAX_PLUGIN_PARAMS,
  type Task,
  TaskResult,
} from "./jobs.js";
export type { RequestOptions } from "./request.js";
export { ScrapeResult, type ScrapeResultInit } from "./response.js";
export type { Usage } from "./usage.js";
export { VERSION } from "./version.js";
