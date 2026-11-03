// SPDX-License-Identifier: Apache-2.0
// sdo — official JavaScript/TypeScript SDK for the Scrape.do web-scraping API.
//
//   import { Client } from "@scrape-do/sdk";
//   const client = new Client({ token: "YOUR_TOKEN" }); // or SDO_TOKEN
//   const result = await client.scrape("https://example.com", { render: true });
//   console.log(result.statusCode, result.text.slice(0, 200));
export { Client, type ClientOptions } from "./client.js";
export { ScrapeConfig, type ScrapeOptions } from "./config.js";
export { type RequestOptions } from "./request.js";
export { ScrapeResult, type ScrapeResultInit } from "./response.js";
export { type Usage } from "./usage.js";
export { type FetchLike } from "./http.js";
export {
  TaskResult,
  JOB_STATUSES,
  JOB_SORTS,
  MAX_PLUGIN_PARAMS,
  type AsyncJobs,
  type CallOptions,
  type Job,
  type JobPage,
  type JobSort,
  type JobStatus,
  type JobStatusValue,
  type ListJobsOptions,
  type Task,
  type Account,
} from "./jobs.js";
export { VERSION } from "./version.js";
export {
  SdoError,
  SdoConfigError,
  SdoTransportError,
  SdoConnectionError,
  SdoTimeoutError,
  SdoResponseTooLargeError,
  SdoAbortError,
  SdoApiError,
  SdoAuthError,
  SdoValidationError,
  SdoConcurrencyError,
  SdoGatewayError,
  redactSecrets,
  type SdoErrorOptions,
  type ApiErrorOptions,
} from "./errors.js";
