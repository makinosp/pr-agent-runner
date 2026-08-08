/**
 * Minimal global fetch mock for LLM HTTP call tests.
 *
 * Usage:
 *   const restore = mockFetch([{ status: 200, body: { content: [{ type: 'text', text: 'hello' }] } }]);
 *   // ... run tests ...
 *   restore();
 */

export interface FetchResponse {
  status?: number;
  ok?: boolean;
  body: unknown;
  headers?: Record<string, string>;
}

export interface FetchCall {
  url: string;
  init: RequestInit;
}

export const mockFetch = (responses: FetchResponse[]): { calls: FetchCall[]; restore: () => void } => {
  const calls: FetchCall[] = [];
  let idx = 0;

  const originalFetch = globalThis.fetch;
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  globalThis.fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    calls.push({ url, init: init ?? {} });
    const resp = responses[Math.min(idx, responses.length - 1)] ?? { status: 500, ok: false, body: {} };
    idx += 1;
    return new Response(JSON.stringify(resp.body), {
      status: resp.status ?? 200,
      statusText: '',
      headers: new Headers(resp.headers ?? { 'content-type': 'application/json' }),
    });
  };

  return {
    calls,
    restore: () => {
      globalThis.fetch = originalFetch;
    },
  };
};

/**
 * Run `fn` with the global fetch mocked, restoring it afterwards.
 * Replaces the repetitive try/finally + mockFetch pattern in LLM tests.
 */
export const withFetch = async <T>(
  responses: FetchResponse[],
  fn: (calls: FetchCall[]) => Promise<T>,
): Promise<T> => {
  const { calls, restore } = mockFetch(responses);
  try {
    return await fn(calls);
  } finally {
    restore();
  }
};
