/**
 * Mock fetch helper for unit tests.
 *
 * Returns a mock fetch function that cycles through preset responses, repeating
 * the last one when the list is exhausted. This mirrors the test strategy
 * described in the spec §15.2.
 */

export interface MockResponse {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
}

export function mockFetch(responses: MockResponse[]): typeof globalThis.fetch {
  let callIndex = 0;

  return async (_input: RequestInfo | URL, _init?: RequestInit): Promise<Response> => {
    const response = responses[callIndex] ?? responses[responses.length - 1];
    if (response === undefined) throw new Error('mockFetch: no responses configured');
    callIndex++;

    return new Response(response.body !== undefined ? JSON.stringify(response.body) : null, {
      status: response.status,
      headers: { 'Content-Type': 'application/json', ...response.headers },
    });
  };
}

/** Tracks all calls made to the mock fetch for assertion purposes. */
export interface RecordingFetch {
  fetch: typeof globalThis.fetch;
  calls: Array<{ url: string; init?: RequestInit }>;
}

export function recordingFetch(responses: MockResponse[]): RecordingFetch {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  let callIndex = 0;

  const fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    calls.push({ url: String(input), init });
    const response = responses[callIndex] ?? responses[responses.length - 1];
    if (response === undefined) throw new Error('recordingFetch: no responses configured');
    callIndex++;
    return new Response(response.body !== undefined ? JSON.stringify(response.body) : null, {
      status: response.status,
      headers: { 'Content-Type': 'application/json', ...response.headers },
    });
  };

  return { fetch, calls };
}
