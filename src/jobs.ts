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
  status?: string;
  startTime?: string;
  endTime?: string;
  canceled: boolean;
  tasks: Task[];
}

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
   * body using the API's own PascalCase keys (Super, GeoCode, Render, ...);
   * the targets can only come from `targets`.
   */
  create(targets: string[], options?: Record<string, unknown>, call?: CallOptions): Promise<Job>;
  /** Fetch a job's status and its per-target tasks. */
  status(jobId: string, call?: CallOptions): Promise<JobStatus>;
  /** Fetch the scraped result of one task within a job. */
  result(jobId: string, taskId: string, call?: CallOptions): Promise<TaskResult>;
  /** List all jobs. */
  list(call?: CallOptions): Promise<JobStatus[]>;
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
    if (!isObject(options)) throw new SdoConfigError("create() options must be a plain object.");
    // Compared case-insensitively: a JSON decoder on the other side may be.
    if (Object.keys(options).some((k) => k.toLowerCase() === "targets")) {
      throw new SdoConfigError("Pass the targets as the first argument, not inside options.");
    }
    const raw = await this.#object("POST", "/api/v1/jobs", call, { ...options, Targets: targets });
    return { jobId: str(raw, "JobID"), message: str(raw, "Message"), taskIds: strings(raw, "TaskIDs") };
  }

  async status(jobId: string, call?: CallOptions): Promise<JobStatus> {
    return toJobStatus(await this.#object("GET", `/api/v1/jobs/${validateId(jobId, "job id")}`, call));
  }

  async result(jobId: string, taskId: string, call?: CallOptions): Promise<TaskResult> {
    const path = `/api/v1/jobs/${validateId(jobId, "job id")}/${validateId(taskId, "task id")}`;
    return new TaskResult(await this.#object("GET", path, call));
  }

  async list(call?: CallOptions): Promise<JobStatus[]> {
    return objects(await this.#object("GET", "/api/v1/jobs", call), "Jobs").map(toJobStatus);
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
