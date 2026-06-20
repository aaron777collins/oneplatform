import * as net from "node:net";
import { randomUUID } from "node:crypto";
import type { Logger } from "@oneplatform/core";

// ---------------------------------------------------------------------------
// Protocol types — design spec §7.2 / §7.3 / §7.4
// ---------------------------------------------------------------------------

export interface SandboxRequest {
  id: string;
  method: "execute" | "app-build" | "ping" | "drain";
  timeout: number;
  payload: {
    code?: string;
    language?: "js" | "ts";
    context?: unknown;
    files?: Record<string, string>;
    entrypoint?: string;
    target?: string;
    format?: string;
    incrementalContextId?: string;
    batchRecords?: unknown[];
    transforms?: unknown[];
  };
}

export interface SandboxResponseMeta {
  durationMs: number;
  memoryPeakMb: number;
  exitCode: number;
  lineCount: number;
  incrementalContextId?: string;
}

export interface SandboxResponse {
  id: string;
  status: "ok" | "error" | "timeout" | "oom";
  result?: unknown;
  error?: {
    code: string;
    message: string;
    stack?: string;
  };
  meta: SandboxResponseMeta;
}

// Intermediate log line message from sandbox — sent before the final response
export interface SandboxLogLine {
  id: string;
  type: "log";
  line: number;
  level: "debug" | "info" | "warn" | "error";
  stream: "stdout" | "stderr";
  message: string;
  timestamp: string;
}

// ContextCall message from the sandbox — sent when user code calls a PluginContext API
// (e.g. context.fetch(), context.credentials.get(), context.cache.get()).
// The sandbox awaits a contextCallResponse frame before unblocking the user code.
export interface SandboxContextCallMessage {
  id: string;        // correlation ID of the parent execution request
  callId: string;    // unique ID for this specific context call (used to route the response)
  type: "contextCall";
  method: string;
  args: unknown[];
}

// Ping / drain convenience result types
export interface PingResponse {
  pong: boolean;
  runCount: number;
}

export interface DrainResponse {
  drainedCount: number;
  timedOutCount: number;
}

// ---------------------------------------------------------------------------
// UnixSocketClient
// ---------------------------------------------------------------------------

export interface UnixSocketClient {
  connect(socketPath: string): Promise<void>;
  send(request: SandboxRequest): Promise<SandboxResponse>;
  onLogLine(callback: (log: SandboxLogLine) => void): void;
  /**
   * Register a callback invoked when the sandbox sends a contextCall message.
   * The callback receives the message and a `reply` function used to write
   * the contextCallResponse frame back to the sandbox. Without this wiring,
   * all PluginContext API calls (context.fetch(), credentials.get(), etc.)
   * from sandbox user code would be silently discarded.
   */
  onContextCall(
    callback: (msg: SandboxContextCallMessage, reply: (response: unknown) => void) => void,
  ): void;
  ping(): Promise<PingResponse>;
  drain(): Promise<DrainResponse>;
  close(): void;
}

export interface UnixSocketClientDeps {
  logger: Logger;
}

const HEADER_BYTES = 4; // 4-byte big-endian uint32 length prefix
const MAX_MESSAGE_BYTES = 12 * 1024 * 1024; // 12 MB hard limit — spec §7.2

export function createUnixSocketClient(deps: UnixSocketClientDeps): UnixSocketClient {
  const { logger } = deps;

  let socket: net.Socket | null = null;
  let readBuffer = Buffer.alloc(0);

  // Pending requests keyed by correlation ID. Each entry holds the resolve/reject
  // for the outer Promise returned by send(). Log lines delivered before the
  // final response are forwarded via the registered log line callback.
  const pendingRequests = new Map<
    string,
    { resolve: (r: SandboxResponse) => void; reject: (e: Error) => void }
  >();

  let logLineCallback: ((log: SandboxLogLine) => void) | null = null;

  // Callback invoked for contextCall messages from the sandbox. The second
  // argument is a reply thunk bound to writeFrame so the caller can send the
  // contextCallResponse without holding a direct reference to the socket.
  let contextCallCallback: (
    (msg: SandboxContextCallMessage, reply: (response: unknown) => void) => void
  ) | null = null;

  // ---------------------------------------------------------------------------
  // Frame parsing — 4-byte big-endian uint32 + JSON body + '\n'
  // Design spec §7.1: "[4 bytes: uint32 length][JSON bytes]['\n']"
  // ---------------------------------------------------------------------------

  function processReadBuffer(): void {
    while (true) {
      if (readBuffer.length < HEADER_BYTES) break;

      const messageLength = readBuffer.readUInt32BE(0);
      if (messageLength > MAX_MESSAGE_BYTES) {
        logger.error("UnixSocketClient: received message exceeds max size — dropping connection", {
          messageLength,
          max: MAX_MESSAGE_BYTES,
        });
        socket?.destroy();
        break;
      }

      const totalFrameLength = HEADER_BYTES + messageLength + 1; // +1 for '\n'
      if (readBuffer.length < totalFrameLength) break;

      const jsonBytes = readBuffer.slice(HEADER_BYTES, HEADER_BYTES + messageLength);
      readBuffer = readBuffer.slice(totalFrameLength);

      let parsed: unknown;
      try {
        parsed = JSON.parse(jsonBytes.toString("utf8")) as unknown;
      } catch (err) {
        logger.error("UnixSocketClient: failed to parse JSON frame", {
          error: err instanceof Error ? err.message : String(err),
        });
        continue;
      }

      dispatchMessage(parsed);
    }
  }

  function dispatchMessage(msg: unknown): void {
    if (typeof msg !== "object" || msg === null) return;

    const m = msg as Record<string, unknown>;

    // Log line intermediate message (type === 'log')
    if (m["type"] === "log") {
      if (logLineCallback !== null) {
        logLineCallback(m as unknown as SandboxLogLine);
      }
      return;
    }

    // ContextCall message — sandbox user code is awaiting a platform API response.
    // We must dispatch to the registered handler and write the response back so
    // the sandbox can unblock the pending user-code await. Without this branch,
    // all context.fetch() / credentials.get() / cache.* / pipeline.trigger()
    // calls from user code are silently discarded.
    if (m["type"] === "contextCall") {
      const contextMsg = m as unknown as SandboxContextCallMessage;
      if (contextCallCallback !== null) {
        contextCallCallback(contextMsg, (response: unknown) => {
          try {
            writeFrame(response);
          } catch (err) {
            logger.error("UnixSocketClient: failed to write contextCallResponse", {
              callId: contextMsg.callId,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        });
      } else {
        logger.warn("UnixSocketClient: received contextCall but no handler registered — discarding", {
          callId: m["callId"],
          method: m["method"],
        });
      }
      return;
    }

    // Final response — matched by correlation id
    const id = typeof m["id"] === "string" ? m["id"] : null;
    if (id === null) return;

    const pending = pendingRequests.get(id);
    if (pending === undefined) {
      logger.warn("UnixSocketClient: received response for unknown request id", { id });
      return;
    }

    pendingRequests.delete(id);
    pending.resolve(m as unknown as SandboxResponse);
  }

  // ---------------------------------------------------------------------------
  // Frame writing — prefix + JSON + newline
  // ---------------------------------------------------------------------------

  function writeFrame(data: unknown): void {
    if (socket === null || socket.destroyed) {
      throw new Error("UnixSocketClient: socket is not connected");
    }

    const json = JSON.stringify(data);
    const jsonBytes = Buffer.from(json, "utf8");
    const header = Buffer.allocUnsafe(HEADER_BYTES);
    header.writeUInt32BE(jsonBytes.length, 0);
    const newline = Buffer.from("\n");

    socket.write(Buffer.concat([header, jsonBytes, newline]));
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  async function connect(socketPath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      readBuffer = Buffer.alloc(0);
      const s = net.createConnection(socketPath);

      s.on("connect", () => {
        socket = s;
        logger.info("UnixSocketClient: connected to sandbox socket", { socketPath });
        resolve();
      });

      s.on("data", (chunk: Buffer) => {
        readBuffer = Buffer.concat([readBuffer, chunk]);
        processReadBuffer();
      });

      s.on("error", (err: Error) => {
        logger.error("UnixSocketClient: socket error", { error: err.message });
        // Reject all pending requests — the sandbox is unreachable
        for (const [id, pending] of pendingRequests) {
          pending.reject(new Error(`Socket error: ${err.message}`));
          pendingRequests.delete(id);
        }
        // If still connecting, reject the connect promise
        reject(err);
      });

      s.on("close", () => {
        logger.warn("UnixSocketClient: socket closed");
        socket = null;
        for (const [id, pending] of pendingRequests) {
          pending.reject(new Error("Socket closed unexpectedly"));
          pendingRequests.delete(id);
        }
      });
    });
  }

  function send(request: SandboxRequest): Promise<SandboxResponse> {
    return new Promise((resolve, reject) => {
      try {
        writeFrame(request);
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
        return;
      }

      pendingRequests.set(request.id, { resolve, reject });
    });
  }

  function onLogLine(callback: (log: SandboxLogLine) => void): void {
    logLineCallback = callback;
  }

  function onContextCall(
    callback: (msg: SandboxContextCallMessage, reply: (response: unknown) => void) => void,
  ): void {
    contextCallCallback = callback;
  }

  async function ping(): Promise<PingResponse> {
    const req: SandboxRequest = {
      id: randomUUID(),
      method: "ping",
      timeout: 1000,
      payload: {},
    };

    const response = await send(req);
    const result = response.result as { pong: boolean; runCount: number } | undefined;
    return {
      pong: result?.pong === true,
      runCount: result?.runCount ?? 0,
    };
  }

  async function drain(): Promise<DrainResponse> {
    const req: SandboxRequest = {
      id: randomUUID(),
      method: "drain",
      timeout: 60_000,
      payload: {},
    };

    const response = await send(req);
    const result = response.result as { drainedCount: number; timedOutCount: number } | undefined;
    return {
      drainedCount: result?.drainedCount ?? 0,
      timedOutCount: result?.timedOutCount ?? 0,
    };
  }

  function close(): void {
    if (socket !== null && !socket.destroyed) {
      socket.destroy();
    }
    socket = null;
  }

  return { connect, send, onLogLine, onContextCall, ping, drain, close };
}
