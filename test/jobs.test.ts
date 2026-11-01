// SPDX-License-Identifier: Apache-2.0
// Mock-only tests for the async job REST client (q.scrape.do). No network:
// every request is served by an injected fetch mock. Each method asserts its
// PATH, METHOD, the `X-Token` header, the JSON body shape (create), and that the
// PascalCase wire response is parsed into the typed object.
import { describe, expect, it } from "vitest";
import { Client } from "../src/client.js";
import { SdoConfigError, SdoTimeoutError, SdoTransportError, SdoValidationError } from "../src/errors.js";
import { TaskResult } from "../src/jobs.js";
import { bodyText, header, mockFetch } from "./helpers.js";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

function client(fetchImpl: ReturnType<typeof mockFetch>, timeoutMs = 60_000) {
  return new Client({ token: "tok", timeoutMs, retries: 0, fetchImpl });
}

/** The pathname of the nth recorded request (async base is https://q.scrape.do). */
const pathOf = (f: ReturnType<typeof mockFetch>, i = 0) => new URL(f.calls[i]!.url).pathname;
/** The query string, to prove the token is NOT smuggled as a param. */
const queryOf = (f: ReturnType<typeof mockFetch>, i = 0) => new URL(f.calls[i]!.url).search;

describe("AsyncJobs.create", () => {
  it("POSTs /api/v1/jobs with X-Token, a JSON body of Targets+options, and returns a Job", async () => {
    const f = mockFetch(() => json({ JobID: "job-1", Message: "queued", TaskIDs: ["t1", "t2"] }));
    const job = await client(f).jobs.create(["https://a.com", "https://b.com"], {
      Super: true,
      GeoCode: "us",
    });

    expect(job).toEqual({ jobId: "job-1", message: "queued", taskIds: ["t1", "t2"] });

    const call = f.calls[0]!;
    expect(call.url).toContain("q.scrape.do");
    expect(pathOf(f)).toBe("/api/v1/jobs");
    expect(queryOf(f)).toBe(""); // token never on the query string
    expect(call.init?.method).toBe("POST");
    expect(header(call.init, "X-Token")).toBe("tok");
    expect(header(call.init, "Content-Type")).toBe("application/json");
    // Canonical JSON: keys sorted, compact.
    expect(bodyText(call.init)).toBe('{"GeoCode":"us","Super":true,"Targets":["https://a.com","https://b.com"]}');
  });

  it("defaults options to an empty object (body is just Targets)", async () => {
    const f = mockFetch(() => json({ JobID: "j", Message: "ok", TaskIDs: [] }));
    await client(f).jobs.create(["https://a.com"]);
    expect(bodyText(f.calls[0]!.init)).toBe('{"Targets":["https://a.com"]}');
  });
});

describe("AsyncJobs.status", () => {
  it("GETs /api/v1/jobs/{id} and parses the JobStatus + nested Tasks", async () => {
    const f = mockFetch(() =>
      json({
        JobID: "job-1",
        TaskIDs: ["t1"],
        Status: "running",
        StartTime: "2026-01-01T00:00:00Z",
        EndTime: "",
        Canceled: false,
        Tasks: [{ TaskID: "t1", URL: "https://a.com", Status: "done" }],
      }),
    );
    const s = await client(f).jobs.status("job-1");

    expect(s).toEqual({
      jobId: "job-1",
      taskIds: ["t1"],
      status: "running",
      startTime: "2026-01-01T00:00:00Z",
      endTime: "",
      canceled: false,
      tasks: [{ taskId: "t1", url: "https://a.com", status: "done" }],
    });
    expect(pathOf(f)).toBe("/api/v1/jobs/job-1");
    expect(f.calls[0]!.init?.method).toBe("GET");
    expect(header(f.calls[0]!.init, "X-Token")).toBe("tok");
  });
});

describe("AsyncJobs.result", () => {
  it("GETs /api/v1/jobs/{job}/{task} and parses the TaskResult", async () => {
    const f = mockFetch(() =>
      json({
        TaskID: "t1",
        JobID: "job-1",
        URL: "https://a.com",
        Status: "done",
        StatusCode: 200,
        Base64EncodedContent: true,
        ResponseHeaders: { "Content-Type": "text/html", Bad: 1 },
        Content: "aGk=",
      }),
    );
    const r = await client(f).jobs.result("job-1", "t1");

    expect(r).toBeInstanceOf(TaskResult);
    expect(r).toMatchObject({
      taskId: "t1",
      jobId: "job-1",
      url: "https://a.com",
      status: "done",
      statusCode: 200,
      base64EncodedContent: true,
      responseHeaders: { "Content-Type": "text/html" }, // non-string values dropped
      content: "aGk=",
    });
    // Absent fields read as absent, not as zero values.
    expect(r.startTime).toBeUndefined();
    expect(r.scrapeDo).toBeUndefined();
    expect(r.errorMessage).toBeUndefined();
    expect(new TextDecoder().decode(r.contentBytes())).toBe("hi");
    expect(pathOf(f)).toBe("/api/v1/jobs/job-1/t1");
    expect(f.calls[0]!.init?.method).toBe("GET");
    expect(header(f.calls[0]!.init, "X-Token")).toBe("tok");
  });
});

describe("AsyncJobs.list", () => {
  it("GETs /api/v1/jobs and parses {Jobs:[...]} into a JobStatus[]", async () => {
    const f = mockFetch(() =>
      json({
        Jobs: [
          {
            JobID: "job-1",
            TaskIDs: ["t1"],
            Status: "done",
            StartTime: "s",
            EndTime: "e",
            Canceled: false,
            Tasks: [{ TaskID: "t1", URL: "https://a.com", Status: "done" }],
          },
        ],
      }),
    );
    const jobs = await client(f).jobs.list();

    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.jobId).toBe("job-1");
    expect(jobs[0]!.tasks[0]).toEqual({ taskId: "t1", url: "https://a.com", status: "done" });
    expect(pathOf(f)).toBe("/api/v1/jobs");
    expect(f.calls[0]!.init?.method).toBe("GET");
    expect(header(f.calls[0]!.init, "X-Token")).toBe("tok");
  });
});

describe("AsyncJobs.cancel", () => {
  it("DELETEs /api/v1/jobs/{id} and resolves to nothing", async () => {
    const f = mockFetch(() => new Response(null, { status: 200 }));
    const out = await client(f).jobs.cancel("job-1");

    expect(out).toBeUndefined();
    expect(pathOf(f)).toBe("/api/v1/jobs/job-1");
    expect(f.calls[0]!.init?.method).toBe("DELETE");
    expect(header(f.calls[0]!.init, "X-Token")).toBe("tok");
  });
});

describe("AsyncJobs.me", () => {
  it("GETs /api/v1/me and maps the misspelled AvaliableCredits to availableCredits", async () => {
    const f = mockFetch(() =>
      json({ TotalConcurrency: 10, FreeConcurrency: 8, ActiveJobs: 2, AvaliableCredits: 5000 }),
    );
    const account = await client(f).jobs.me();

    expect(account).toEqual({
      totalConcurrency: 10,
      freeConcurrency: 8,
      activeJobs: 2,
      availableCredits: 5000,
    });
    expect(pathOf(f)).toBe("/api/v1/me");
    expect(f.calls[0]!.init?.method).toBe("GET");
    expect(header(f.calls[0]!.init, "X-Token")).toBe("tok");
  });
});

describe("AsyncJobs error handling", () => {
  it("maps a non-2xx job response to the shared SdoError taxonomy, parsing the Error envelope", async () => {
    const f = mockFetch(() => json({ Error: "callback not supported anymore", Code: 400 }, 400));
    await client(f)
      .jobs.create(["https://a.com"])
      .catch((e) => {
        expect(e).toBeInstanceOf(SdoValidationError);
        expect((e as SdoValidationError).message).toBe("callback not supported anymore");
      });
    expect.assertions(2);
  });
});

describe("AsyncJobs timeout wiring", () => {
  it("threads the client timeout onto job fetches via an AbortSignal", async () => {
    const f = mockFetch(() => json({ JobID: "j", Message: "ok", TaskIDs: [] }));
    await client(f, 1234).jobs.create(["https://e.com"]);
    const signal = f.calls[0]!.init?.signal;
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal!.aborted).toBe(false);
  });

  it("aborts a hanging job fetch once the timeout elapses", async () => {
    const f = mockFetch(
      (_u, init) =>
        new Promise<Response>((_resolve, reject) => {
          (init!.signal as AbortSignal).addEventListener("abort", () => reject(new Error("aborted")));
        }),
    );
    await expect(client(f, 20).jobs.status("job-1")).rejects.toBeInstanceOf(SdoTimeoutError);
  });
});

describe("AsyncJobs input and response shapes", () => {
  it("refuses a create() call it cannot express, before any request", async () => {
    const f = mockFetch(() => json({}));
    const jobs = client(f).jobs;
    await expect(jobs.create("https://a.com" as never)).rejects.toBeInstanceOf(SdoConfigError);
    await expect(jobs.create([1] as never)).rejects.toBeInstanceOf(SdoConfigError);
    await expect(jobs.create(["https://a.com"], [] as never)).rejects.toBeInstanceOf(SdoConfigError);
    await expect(jobs.create(["https://a.com"], { targets: [] })).rejects.toBeInstanceOf(SdoConfigError);
    expect(f.calls).toHaveLength(0);
  });

  it("treats JSON that is not an object as a transport error", async () => {
    const f = mockFetch(() => json([1, 2]));
    await expect(client(f).jobs.me()).rejects.toBeInstanceOf(SdoTransportError);
  });

  it("reads absent or mistyped fields as absent (lists empty, flags false)", async () => {
    const f = mockFetch(() => json({ Jobs: [{ JobID: 5, Tasks: [null, { TaskID: "t" }] }, "junk"] }));
    const [only, ...rest] = await client(f).jobs.list();
    expect(rest).toEqual([]);
    expect(only).toEqual({
      jobId: undefined,
      taskIds: [],
      status: undefined,
      startTime: undefined,
      endTime: undefined,
      canceled: false,
      tasks: [{ taskId: "t", url: undefined, status: undefined }],
    });
    expect(await client(mockFetch(() => json({}))).jobs.me()).toEqual({
      totalConcurrency: undefined,
      freeConcurrency: undefined,
      activeJobs: undefined,
      availableCredits: undefined,
    });
  });

  it("never marks an async API error as billed", async () => {
    const f = mockFetch(() => json({ Error: "Job not found", Code: 404 }, 404));
    const err = await client(f).jobs.status("j").catch((e) => e);
    expect(err.billed).toBe(false);
    expect(err.statusCode).toBe(404);
  });
});

describe("TaskResult.contentBytes", () => {
  const bytesOf = (content: string) =>
    new TaskResult({ Base64EncodedContent: true, Content: content }).contentBytes();

  it("ignores CR/LF line wrapping but no other whitespace or alphabet", () => {
    expect(new TextDecoder().decode(bytesOf("aGVs\nbG8="))).toBe("hello");
    for (const bad of ["aGVs bG8=", "aGVs\tbG8=", "aGVsbG8", "aGVs_G8=", "aGVsbG8=="]) {
      expect(() => bytesOf(bad), bad).toThrow("not valid base64");
    }
  });

  it("validates multi-megabyte content without overflowing the regex stack", () => {
    // 8 MiB of base64: a grouped-quantifier pattern threw RangeError here.
    const content = "QUJD".repeat(2 * 1024 * 1024);
    expect(bytesOf(content).length).toBe(6 * 1024 * 1024);
    expect(() => bytesOf(content + "Q")).toThrow("not valid base64");
    expect(() => bytesOf(content.slice(0, -1) + "!")).toThrow("not valid base64");
  });
});
