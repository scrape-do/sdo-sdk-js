// SPDX-License-Identifier: Apache-2.0
// A throwaway HTTP server on 127.0.0.1, so tests exercise the SDK's default
// transport (node:http) end to end: real sockets, real framing, real
// Content-Encoding. Nothing leaves the machine.
import http from "node:http";
import type { AddressInfo } from "node:net";

export interface Captured {
  method: string;
  /** Path and query exactly as received. */
  url: string;
  /** Header (name, value) pairs as received, in order. */
  headers: Array<[string, string]>;
  body: Buffer;
}

export interface TestServer {
  /** http://127.0.0.1:<port> */
  url: string;
  requests: Captured[];
  close(): Promise<void>;
}

export type Handler = (req: Captured, res: http.ServerResponse, index: number) => void | Promise<void>;

export async function startServer(handler: Handler): Promise<TestServer> {
  const requests: Captured[] = [];
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const headers: Array<[string, string]> = [];
    for (let i = 0; i + 1 < req.rawHeaders.length; i += 2) headers.push([req.rawHeaders[i]!, req.rawHeaders[i + 1]!]);
    const captured = { method: req.method!, url: req.url!, headers, body: Buffer.concat(chunks) };
    const index = requests.length;
    requests.push(captured);
    try {
      await handler(captured, res, index);
    } catch {
      res.destroy();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/** Every value of a received header, compared case-insensitively. */
export function received(req: Captured, name: string): string[] {
  return req.headers.filter(([k]) => k.toLowerCase() === name.toLowerCase()).map(([, v]) => v);
}

/** Start a server for one test body and always close it. */
export async function withServer<T>(handler: Handler, body: (server: TestServer) => Promise<T>): Promise<T> {
  const server = await startServer(handler);
  try {
    return await body(server);
  } finally {
    await server.close();
  }
}
