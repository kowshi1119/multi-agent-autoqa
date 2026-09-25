const REQUEST_TIMEOUT_MS = 15_000;

export type CheckHttpResponse = {
  status: number;
  contentType: string | undefined;
  headers: Record<string, string>;
  setCookies: string[];
  /** Parsed JSON when the content-type says so and parsing succeeded, else the raw capped-length text. */
  body: unknown;
  bodyTruncated: boolean;
};

export type CheckHttpError = { failed: true; reason: string; sessionExpired?: boolean; unsupported?: boolean };

/**
 * Thin fetch() wrapper shared by run-api-checks.ts and run-security-
 * checks.ts: combines a fixed per-call timeout with an optional external
 * AbortSignal (same deriveTimeoutSignal() pattern already used by
 * src/critic/critic-runner.ts), and caps how much of the response body is
 * ever read into memory or evidence.
 */
export async function fireCheckRequest(
  url: string,
  method: string,
  requestBody: unknown,
  responseSizeCapBytes: number,
  abortSignal?: AbortSignal,
  extraHeaders?: Record<string, string>
): Promise<CheckHttpResponse | CheckHttpError> {
  const timeoutSignal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const signal = abortSignal ? AbortSignal.any([timeoutSignal, abortSignal]) : timeoutSignal;

  let response: Response;
  try {
    response = await fetch(url, {
      method,
      redirect: "manual",
      signal,
      headers: { "content-type": "application/json", ...extraHeaders },
      ...(requestBody !== undefined ? { body: JSON.stringify(requestBody) } : {}),
    });
  } catch {
    return { failed: true, reason: signal.aborted ? "Request cancelled or timed out." : "Request transport failed." };
  }

  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => (headers[key] = value));

  const reader = response.body?.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    if (reader) for (;;) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > responseSizeCapBytes) return { failed: true, reason: "Response exceeded the byte limit; assertions were not evaluated." };
      chunks.push(next.value);
    }
  } catch {
    return { failed: true, reason: signal.aborted ? "Response cancelled or timed out." : "Response stream failed." };
  } finally {
    await reader?.cancel().catch(() => {});
  }
  const capped = Buffer.concat(chunks).toString("utf8");
  const truncated = false;
  const contentType = response.headers.get("content-type") ?? undefined;

  let body: unknown = capped;
  if (contentType?.includes("application/json") && !truncated) {
    try {
      body = JSON.parse(capped);
    } catch {
      // Leave body as the raw text -- an unparseable JSON content-type is
      // itself a legitimate assertion failure, not a crash.
    }
  }

  return { status: response.status, contentType, headers, setCookies: response.headers.getSetCookie(), body, bodyTruncated: truncated };
}
