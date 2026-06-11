/**
 * SSE client for streaming commands: logs tail, pipeline run-logs --follow, app dev.
 * Parses the text/event-stream protocol and emits event data lines.
 */
import type { HttpClient } from "./http-client.js";

export interface SseEvent {
  event?: string;
  data: string;
  id?: string;
}

/**
 * Parses a raw SSE text chunk into structured events.
 * Handles partial chunks by buffering incomplete lines.
 */
export function parseSseChunk(chunk: string, buffer: string): { events: SseEvent[]; remaining: string } {
  const fullText = buffer + chunk;
  const lines = fullText.split("\n");
  const remaining = lines[lines.length - 1] ?? "";
  const completeLines = lines.slice(0, -1);

  const events: SseEvent[] = [];
  let current: Partial<SseEvent> = {};

  for (const line of completeLines) {
    if (line === "") {
      // Empty line = dispatch event
      if (current.data !== undefined) {
        events.push({ data: current.data, ...(current.event ? { event: current.event } : {}), ...(current.id ? { id: current.id } : {}) });
      }
      current = {};
    } else if (line.startsWith("data:")) {
      current.data = line.slice(5).trimStart();
    } else if (line.startsWith("event:")) {
      current.event = line.slice(6).trimStart();
    } else if (line.startsWith("id:")) {
      current.id = line.slice(3).trimStart();
    }
    // Lines starting with ':' are comments — ignore
  }

  return { events, remaining };
}

/**
 * Consumes an SSE stream from the HTTP client and yields parsed events.
 * Caller is responsible for handling SIGINT to stop iteration.
 */
export async function* streamSse(
  http: HttpClient,
  path: string,
  query?: Record<string, unknown>,
): AsyncIterable<SseEvent> {
  let buffer = "";
  for await (const chunk of http.stream(path, query)) {
    const { events, remaining } = parseSseChunk(chunk, buffer);
    buffer = remaining;
    for (const event of events) {
      yield event;
    }
  }
}
