// SPDX-License-Identifier: Apache-2.0
// The two ways a request goes out, behind one shape (an Exchange).
//
// The default is node:http / node:https. It sends only the headers it is given
// (plus Host, Connection and the body framing), never follows a redirect, hands
// back the body exactly as received (still content-encoded, so the SDK's own
// bounded decoder applies its rules) and knows whether a failure happened before
// the request left the machine, which is the only kind the SDK retries.
//
// An injected fetch (ClientOptions.fetchImpl) is supported for tests and custom
// runtimes. Fetch decodes Content-Encoding itself, so its body is taken as
// already decoded; a fetch rejection counts as "not sent" only when its error
// code says the connection was never made (DNS, refused, connect timeout).
import http from "node:http";
import https from "node:https";
import { urlToHttpOptions } from "node:url";

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface WireRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: Uint8Array;
  /** Aborts the exchange (the attempt's deadline and the caller's signal). */
  signal: AbortSignal;
}

export interface Exchange {
  status: number;
  headers: Headers;
  /** The body as received; still content-encoded when `encoded` is true. */
  body: AsyncIterable<Uint8Array>;
  encoded: boolean;
  /** Stop the transfer and release the connection. Safe to call more than once. */
  release(): void;
}

export type Sender = (req: WireRequest) => Promise<Exchange>;

/** A failure before the response arrived. `sent` is false only when the request provably never left. */
export class SendFailure extends Error {
  constructor(
    readonly sent: boolean,
    readonly original: unknown,
  ) {
    super("send failed");
  }
}

// Error codes that mean no connection was made, so nothing was sent.
const NOT_SENT_CODES = new Set([
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EADDRNOTAVAIL",
  "UND_ERR_CONNECT_TIMEOUT",
]);

function errorCodes(e: unknown): string[] {
  const codes: string[] = [];
  let cur: unknown = e;
  for (let depth = 0; cur instanceof Error && depth < 4; depth++) {
    const code = (cur as { code?: unknown }).code;
    if (typeof code === "string") codes.push(code);
    cur = cur.cause;
  }
  return codes;
}

function responseHeaders(raw: string[]): Headers {
  const headers = new Headers();
  for (let i = 0; i + 1 < raw.length; i += 2) {
    try {
      headers.append(raw[i]!, raw[i + 1]!);
    } catch {
      // A header the Headers class cannot hold is dropped, as fetch would.
    }
  }
  return headers;
}

/** node:http / node:https. */
export const nodeSend: Sender = (req) =>
  new Promise<Exchange>((resolve, reject) => {
    const url = new URL(req.url);
    const tls = url.protocol === "https:";
    let connected = false;
    let responded = false;
    let request: http.ClientRequest;
    try {
      request = (tls ? https : http).request({
        ...urlToHttpOptions(url),
        // The path and query exactly as built: no re-parsing or re-encoding.
        path: req.url.slice(url.origin.length) || "/",
        method: req.method,
        headers: req.headers,
        signal: req.signal,
      });
    } catch (e) {
      reject(new SendFailure(false, e));
      return;
    }
    request.once("socket", (socket) => {
      // A pooled keep-alive socket is already connected; a new one says when.
      if (request.reusedSocket) connected = true;
      else socket.once(tls ? "secureConnect" : "connect", () => (connected = true));
    });
    request.on("error", (e) => {
      if (responded) return;
      // A pooled socket the server had already closed fails before any byte of
      // the response: the request was not processed (the documented Node.js
      // keep-alive race), so it counts as not sent.
      const staleSocket = request.reusedSocket && errorCodes(e).some((c) => c === "ECONNRESET" || c === "EPIPE");
      reject(new SendFailure(connected && !staleSocket, e));
    });
    request.once("response", (res) => {
      responded = true;
      resolve({
        status: res.statusCode ?? 0,
        headers: responseHeaders(res.rawHeaders),
        body: res,
        encoded: true,
        release: () => {
          res.destroy();
          request.destroy();
        },
      });
    });
    request.end(req.body);
  });

/** An injected fetch. */
export function fetchSender(fetchImpl: FetchLike): Sender {
  return async (req) => {
    let resp: Response;
    try {
      resp = await fetchImpl(req.url, {
        method: req.method,
        headers: req.headers,
        body: req.body as BodyInit | undefined,
        redirect: "manual",
        signal: req.signal,
      });
    } catch (e) {
      throw new SendFailure(!errorCodes(e).some((c) => NOT_SENT_CODES.has(c)), e);
    }
    const reader = resp.body?.getReader();
    return {
      status: resp.status,
      headers: resp.headers,
      body: {
        async *[Symbol.asyncIterator]() {
          if (!reader) return;
          for (;;) {
            const { done, value } = await reader.read();
            if (done) return;
            yield value;
          }
        },
      },
      encoded: false,
      // Cancelling through the reader also settles a read that is pending.
      release: () => {
        reader?.cancel().catch(() => undefined);
      },
    };
  };
}
