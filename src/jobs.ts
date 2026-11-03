// SPDX-License-Identifier: Apache-2.0
// Async job API — the REST surface hosted at https://q.scrape.do/api/v1.
//
// Auth is the client's token sent as the `X-Token` request header (never in the
// URL). Requests go through the same transport as scrapes, so they share its
// size ceiling, total timeout, redirect refusal, retry rule and error taxonomy;
// here any non-2xx answer, a 3xx included, is an error.
//
// Responses are read leniently: a field that is absent or of the wrong type
// reads as absent (undefined; an empty list for lists, false for flags), and a
// string map keeps only its string entries. A body that is not a JSON object is
// a transport error.
import { SdoConfigError, SdoTransportError } from "./errors.js";
import { canonicalJson, parseJsonBody } from "./json.js";
import { checkSignal } from "./request.js";
import type { HttpResponse, Transport } from "./transport.js";

/** Job and task ids are validated before they enter the URL path. */
export const ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

/** Options for a single job API call. */
export interface CallOptions {
  /** Aborts the call (the request or the wait before a retry); it then rejects with `SdoAbortError`. */
  signal?: AbortSignal;
}

/** Acknowledgement returned when a job is created. */
export interface Job {
  jobId?: string;
  message?: string;
  taskIds: string[];
}

/** A single target within a job. */
export interface Task {
  taskId?: string;
  url?: string;
  status?: string;
}

/** A job's current state, including its per-target tasks. */
export interface JobStatus {
  jobId?: string;
  taskIds: string[];
  /** One of {@link JOB_STATUSES}. */
  status?: string;
  startTime?: string;
  endTime?: string;
  /** The job's share of the account's separate async concurrency pool. */
  acquiredConcurrency?: number;
  limitConcurrency?: number;
  canceled: boolean;
  tasks: Task[];
}

/** The job statuses the API documents (also the `status` filter of `list`). */
export const JOB_STATUSES = ["queuing", "queued", "pending", "rotating", "success", "error", "canceled"] as const;
export type JobStatusValue = (typeof JOB_STATUSES)[number];

/** The sort orders `list` accepts; `start_time_desc` (newest first) is the API default. */
export const JOB_SORTS = ["start_time_desc", "start_time_asc"] as const;
export type JobSort = (typeof JOB_SORTS)[number];

/** Filters and paging for `list`. Every field left out takes the API's default. */
export interface ListJobsOptions {
  /** 1-based page number (default 1). */
  page?: number;
  /** Jobs per page, 1-100 (default 10). */
  pageSize?: number;
  /** Keep only jobs in this state. */
  status?: JobStatusValue;
  /** Inclusive lower bound on the job's start time: a Date, or an RFC 3339 string such as `2025-01-01T00:00:00Z`. */
  startFrom?: Date | string;
  /** Inclusive upper bound on the job's start time. */
  startTo?: Date | string;
  sort?: JobSort;
}

/** One page of `list`'s result. The counts cover every job matching the filters. */
export interface JobPage {
  jobs: JobStatus[];
  totalCount?: number;
  pageSize?: number;
  pageNumber?: number;
  totalPages?: number;
}

/** The documented limit on params entries (tasks) in one plugin job. */
export const MAX_PLUGIN_PARAMS = 1000;
/** A documented plugin key such as `amazon/pdp` or `google/shopping/product/stores`. */
const PLUGIN_KEY = /^[a-z0-9-]+(\/[a-z0-9-]+)+$/;
// RFC 3339 with uppercase T and Z (the API is case-sensitive about both).
const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

/** Concurrency and credit snapshot for the authenticated account. */
export interface Account {
  totalConcurrency?: number;
  freeConcurrency?: number;
  activeJobs?: number;
  availableCredits?: number;
}

type Raw = Record<string, unknown>;

const str = (raw: Raw, key: string): string | undefined =>
  typeof raw[key] === "string" ? (raw[key] as string) : undefined;
const num = (raw: Raw, key: string): number | undefined =>
  typeof raw[key] === "number" ? (raw[key] as number) : undefined;
const strings = (raw: Raw, key: string): string[] =>
  Array.isArray(raw[key]) ? (raw[key] as unknown[]).filter((v): v is string => typeof v === "string") : [];
const objects = (raw: Raw, key: string): Raw[] =>
  Array.isArray(raw[key]) ? (raw[key] as unknown[]).filter(isObject) : [];

function stringMap(raw: Raw, key: string): Record<string, string> | undefined {
  const value = raw[key];
  if (!isObject(value)) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value)) if (typeof v === "string") out[k] = v;
  return out;
}

function isObject(v: unknown): v is Raw {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

// Standard base64 (RFC 4648 §4) with its padding, once line breaks are removed
// (MIME-style wrapping); any other character, whitespace included, is invalid.
// A flat character class plus a length check: a grouped quantifier over the
// whole content backtracks per group and overflows V8's stack on multi-MB input.
const BASE64_CHARS = /^[A-Za-z0-9+/]*={0,2}$/;
const isBase64 = (s: string): boolean => s.length % 4 === 0 && BASE64_CHARS.test(s);
const LINE_BREAKS = /[\r\n]/g;

/** The scraped result of one task, decoded from the async API's task-result response. */
export class TaskResult {
  readonly taskId?: string;
  readonly jobId?: string;
  readonly url?: string;
  /** queuing | queued | pending | rotating | success | error | canceled */
  readonly status?: string;
  readonly startTime?: string;
  readonly endTime?: string;
  readonly expiresAt?: string;
  readonly updateTime?: string;
  /** True when `content` is base64 (a binary target such as an image). */
  readonly base64EncodedContent: boolean;
  /** The target's status code. */
  readonly statusCode?: number;
  readonly responseHeaders?: Record<string, string>;
  /** The gateway's metadata for the task (the response's "Scrape.do" object). */
  readonly scrapeDo?: Record<string, string>;
  readonly content?: string;
  readonly errorMessage?: string;

  constructor(raw: Record<string, unknown>) {
    this.taskId = str(raw, "TaskID");
    this.jobId = str(raw, "JobID");
    this.url = str(raw, "URL");
    this.status = str(raw, "Status");
    this.startTime = str(raw, "StartTime");
    this.endTime = str(raw, "EndTime");
    this.expiresAt = str(raw, "ExpiresAt");
    this.updateTime = str(raw, "UpdateTime");
    this.base64EncodedContent = raw.Base64EncodedContent === true;
    this.statusCode = num(raw, "StatusCode");
    this.responseHeaders = stringMap(raw, "ResponseHeaders");
    this.scrapeDo = stringMap(raw, "Scrape.do");
    this.content = str(raw, "Content");
    this.errorMessage = str(raw, "ErrorMessage");
  }

  /**
   * The content as bytes: base64-decoded when base64EncodedContent is set, else
   * its UTF-8 bytes (empty when there is no content). Line breaks inside base64
   * are ignored; content flagged as base64 that is otherwise not valid base64
   * throws SdoTransportError.
   */
  contentBytes(): Uint8Array {
    const content = this.content ?? "";
    if (!this.base64EncodedContent) return new TextEncoder().encode(content);
    const encoded = content.replace(LINE_BREAKS, "");
    if (!isBase64(encoded)) {
      throw new SdoTransportError("The task content is flagged as base64 but is not valid base64.");
    }
    return new Uint8Array(Buffer.from(encoded, "base64"));
  }
}

function toTask(raw: Raw): Task {
  return { taskId: str(raw, "TaskID"), url: str(raw, "URL"), status: str(raw, "Status") };
}

function toJobStatus(raw: Raw): JobStatus {
  return {
    jobId: str(raw, "JobID"),
    taskIds: strings(raw, "TaskIDs"),
    status: str(raw, "Status"),
    startTime: str(raw, "StartTime"),
    endTime: str(raw, "EndTime"),
    acquiredConcurrency: num(raw, "AcquiredConcurrency"),
    limitConcurrency: num(raw, "LimitConcurrency"),
    canceled: raw.Canceled === true,
    tasks: objects(raw, "Tasks").map(toTask),
  };
}

function validateId(id: unknown, what: string): string {
  if (typeof id !== "string" || !ID_PATTERN.test(id)) {
    throw new SdoConfigError(`Invalid ${what} ${JSON.stringify(id)}: expected 1-128 of A-Z a-z 0-9 _ -.`);
  }
  // Already path-safe; encoding is defence in depth.
  return encodeURIComponent(id);
}

function timestamp(value: unknown, what: string): string {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) throw new SdoConfigError(`${what} is an invalid Date.`);
    return value.toISOString().replace(/\.\d{3}Z$/, "Z");
  }
  if (typeof value === "string" && RFC3339.test(value)) return value;
  throw new SdoConfigError(`${what} must be a Date or an RFC 3339 string such as 2025-01-01T00:00:00Z.`);
}

function positiveInt(value: unknown, what: string, max?: number): string {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || (max !== undefined && value > max)) {
    throw new SdoConfigError(`${what} must be an integer from 1${max === undefined ? " up" : ` to ${max}`}.`);
  }
  return String(value);
}

/** The query string for `list` (validated), "" when every option is left out. */
function listQuery(input: ListJobsOptions | undefined): string {
  if (input === undefined) return "";
  if (!isObject(input)) throw new SdoConfigError("list() options must be a plain object.");
  const options: ListJobsOptions = input;
  const q = new URLSearchParams();
  if (options.page !== undefined) q.set("page", positiveInt(options.page, "page"));
  if (options.pageSize !== undefined) q.set("page_size", positiveInt(options.pageSize, "pageSize", 100));
  if (options.status !== undefined) {
    if (!(JOB_STATUSES as readonly unknown[]).includes(options.status)) {
      throw new SdoConfigError(`status must be one of ${JOB_STATUSES.join(", ")}.`);
    }
    q.set("status", options.status);
  }
  if (options.startFrom !== undefined) q.set("start_from", timestamp(options.startFrom, "startFrom"));
  if (options.startTo !== undefined) q.set("start_to", timestamp(options.startTo, "startTo"));
  if (options.sort !== undefined) {
    if (!(JOB_SORTS as readonly unknown[]).includes(options.sort)) {
      throw new SdoConfigError(`sort must be one of ${JOB_SORTS.join(", ")}.`);
    }
    q.set("sort", options.sort);
  }
  const text = q.toString();
  return text === "" ? "" : `?${text}`;
}

/** The signal of a CallOptions argument (validated). */
export function callSignal(options: CallOptions | undefined): AbortSignal | undefined {
  if (options === undefined || options === null) return undefined;
  if (typeof options !== "object") throw new SdoConfigError("Call options must be an object such as { signal }.");
  return checkSignal(options.signal);
}

/**
 * The async job API, reached through `client.jobs` (the only way to obtain it:
 * it shares the client's token, base URL and transport).
 */
export interface AsyncJobs {
  /**
   * Submit a batch of target URLs as a job. `options` are merged into the job
   * body using the API's own PascalCase keys (Super, GeoCode, Render,
   * WebhookURL, ...); they may set neither `Targets` nor `Plugin`.
   */
  create(targets: string[], options?: Record<string, unknown>, call?: CallOptions): Promise<Job>;
  /**
   * Submit a plugin job: `key` names the plugin (`amazon/pdp`,
   * `google/search`, ...) and each `params` entry becomes one task, with the
   * plugin's own parameter names. 1 to 1000 entries. `options` are merged into
   * the body like create's and may set neither `Targets` nor `Plugin`.
   */
  createPlugin(
    key: string,
    params: Record<string, unknown>[],
    options?: Record<string, unknown>,
    call?: CallOptions,
  ): Promise<Job>;
  /** Fetch a job's status and its per-target tasks. */
  status(jobId: string, call?: CallOptions): Promise<JobStatus>;
  /** Fetch the scraped result of one task within a job. */
  result(jobId: string, taskId: string, call?: CallOptions): Promise<TaskResult>;
  /**
   * One page of the account's jobs (default: the 10 most recent). Filter by
   * status and start time, sort, and walk `page` up to the returned `totalPages`.
   */
  list(options?: ListJobsOptions, call?: CallOptions): Promise<JobPage>;
  /** Cancel a job by id. Any 2xx is success, whatever its body says. */
  cancel(jobId: string, call?: CallOptions): Promise<void>;
  /** Fetch the account's concurrency and credit snapshot. */
  me(call?: CallOptions): Promise<Account>;
}

/** Internal: the implementation behind `client.jobs`. */
export class JobsClient implements AsyncJobs {
  readonly #token: string;
  readonly #baseUrl: string;
  readonly #transport: Transport;

  constructor(token: string, baseUrl: string, transport: Transport) {
    this.#token = token;
    this.#baseUrl = baseUrl;
    this.#transport = transport;
  }

  #call(method: string, path: string, call: CallOptions | undefined, body?: unknown): Promise<HttpResponse> {
    const signal = callSignal(call);
    const headers: Record<string, string> = { "X-Token": this.#token };
    let bytes: Uint8Array | undefined;
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
      bytes = new TextEncoder().encode(canonicalJson(body));
    }
    return this.#transport.send({
      method,
      url: this.#baseUrl + path,
      token: this.#token,
      api: "async",
      headers,
      body: bytes,
      signal,
    });
  }

  async #object(method: string, path: string, call: CallOptions | undefined, body?: unknown): Promise<Raw> {
    const resp = await this.#call(method, path, call, body);
    const parsed = parseJsonBody(resp.body, "The async API response", this.#token);
    if (!isObject(parsed)) throw new SdoTransportError("The async API response is JSON but not an object.");
    return parsed;
  }

  async create(targets: string[], options: Record<string, unknown> = {}, call?: CallOptions): Promise<Job> {
    if (!Array.isArray(targets) || targets.length === 0 || !targets.every((t) => typeof t === "string")) {
      throw new SdoConfigError("create() needs a non-empty array of target URLs.");
    }
    return this.#create({ Targets: targets }, options, "create", call);
  }

  async createPlugin(
    key: string,
    params: Record<string, unknown>[],
    options: Record<string, unknown> = {},
    call?: CallOptions,
  ): Promise<Job> {
    if (typeof key !== "string" || !PLUGIN_KEY.test(key)) {
      throw new SdoConfigError(`Invalid plugin key ${JSON.stringify(key)}: expected a plugin path such as amazon/pdp.`);
    }
    if (!Array.isArray(params) || params.length === 0 || params.length > MAX_PLUGIN_PARAMS) {
      throw new SdoConfigError(`A plugin job needs 1 to ${MAX_PLUGIN_PARAMS} params entries (one per task).`);
    }
    if (!params.every(isObject)) throw new SdoConfigError("Every plugin params entry must be a plain object.");
    return this.#create({ Plugin: { Key: key, Params: params } }, options, "createPlugin", call);
  }

  async #create(
    source: Record<string, unknown>,
    options: Record<string, unknown>,
    method: string,
    call: CallOptions | undefined,
  ): Promise<Job> {
    if (!isObject(options)) throw new SdoConfigError(`${method}() options must be a plain object.`);
    // Compared case-insensitively: a JSON decoder on the other side may be.
    const clash = Object.keys(options).find((k) => ["targets", "plugin"].includes(k.toLowerCase()));
    if (clash !== undefined) {
      throw new SdoConfigError(
        `options may not set ${clash}: a job has either targets (create) or a plugin (createPlugin).`,
      );
    }
    const raw = await this.#object("POST", "/api/v1/jobs", call, { ...options, ...source });
    return { jobId: str(raw, "JobID"), message: str(raw, "Message"), taskIds: strings(raw, "TaskIDs") };
  }

  async status(jobId: string, call?: CallOptions): Promise<JobStatus> {
    return toJobStatus(await this.#object("GET", `/api/v1/jobs/${validateId(jobId, "job id")}`, call));
  }

  async result(jobId: string, taskId: string, call?: CallOptions): Promise<TaskResult> {
    const path = `/api/v1/jobs/${validateId(jobId, "job id")}/${validateId(taskId, "task id")}`;
    return new TaskResult(await this.#object("GET", path, call));
  }

  async list(options?: ListJobsOptions, call?: CallOptions): Promise<JobPage> {
    const raw = await this.#object("GET", `/api/v1/jobs${listQuery(options)}`, call);
    return {
      jobs: objects(raw, "Jobs").map(toJobStatus),
      totalCount: num(raw, "TotalCount"),
      pageSize: num(raw, "PageSize"),
      pageNumber: num(raw, "PageNumber"),
      totalPages: num(raw, "TotalPages"),
    };
  }

  async cancel(jobId: string, call?: CallOptions): Promise<void> {
    await this.#call("DELETE", `/api/v1/jobs/${validateId(jobId, "job id")}`, call);
  }

  async me(call?: CallOptions): Promise<Account> {
    const raw = await this.#object("GET", "/api/v1/me", call);
    return {
      totalConcurrency: num(raw, "TotalConcurrency"),
      freeConcurrency: num(raw, "FreeConcurrency"),
      activeJobs: num(raw, "ActiveJobs"),
      // The API misspells this key; the correct spelling wins when both appear.
      availableCredits: num(raw, "AvailableCredits") ?? num(raw, "AvaliableCredits"),
    };
  }
}
