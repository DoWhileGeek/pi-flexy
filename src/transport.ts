import {
  ATTEMPT_LIMIT, PROVIDER_ERROR_FIELD_LIMIT, PROVIDER_ERROR_MESSAGE_LIMIT,
  type Attempt, type Audit, type ProviderError, boundedText, isRecord, safeId, safeOrigin, tierOf,
} from "./audit.ts";

export const MAX_EVENT_CHARS = 256 * 1024;
const MAX_REQUEST_CHARS = 16 * 1024 * 1024;

function errorField(value: unknown, limit: number): { value?: string | null; truncated: boolean } {
  if (value === null) return { value: null, truncated: false };
  return boundedText(value, limit);
}
function providerError(event: Record<string, unknown>, status: number | undefined): ProviderError | undefined {
  let eventType: ProviderError["eventType"];
  let source: Record<string, unknown>;
  if (event.type === "response.failed" && isRecord(event.response)) {
    eventType = "response.failed";
    source = isRecord(event.response.error) ? event.response.error
      : isRecord(event.response.incomplete_details) ? event.response.incomplete_details : event.response;
  } else if (event.type === "error") {
    eventType = "error";
    source = isRecord(event.error) ? event.error : event;
  } else if (status !== undefined && status >= 400) {
    eventType = "http.error";
    source = isRecord(event.error) ? event.error : event;
  } else return undefined;
  const code = errorField(source.code, PROVIDER_ERROR_FIELD_LIMIT);
  const type = errorField(source === event && event.type === "error" ? undefined : source.type, PROVIDER_ERROR_FIELD_LIMIT);
  const param = errorField(source.param, PROVIDER_ERROR_FIELD_LIMIT);
  const reason = errorField(source.reason, PROVIDER_ERROR_FIELD_LIMIT);
  const message = errorField(source.message, PROVIDER_ERROR_MESSAGE_LIMIT);
  const truncated = code.truncated || type.truncated || param.truncated || reason.truncated || message.truncated;
  return {
    eventType,
    ...(code.value !== undefined ? { code: code.value } : {}),
    ...(type.value !== undefined ? { type: type.value } : {}),
    ...(param.value !== undefined ? { param: param.value } : {}),
    ...(reason.value !== undefined ? { reason: reason.value } : {}),
    ...(message.value !== undefined ? { message: message.value } : {}),
    ...(truncated ? { truncated: true } : {}),
  };
}

/** Bounded, incremental SSE inspection. Output is forwarded unchanged; only provider error envelopes are retained. */
export class ResponseInspector {
  private readonly decoder = new TextDecoder();
  private line = "";
  private data = "";
  private dropping = false;
  private previousCR = false;
  constructor(private readonly attempt: Attempt, private readonly sse: boolean, private readonly limit = MAX_EVENT_CHARS) {}

  push(chunk: Uint8Array): void {
    this.accept(this.decoder.decode(chunk, { stream: true }));
  }
  finish(): void {
    this.accept(this.decoder.decode());
    if (this.sse) {
      if (this.line) this.endLine();
      this.dispatch();
    } else if (this.data) this.inspect(this.data);
    this.line = "";
    this.data = "";
  }
  private accept(text: string): void {
    if (!this.sse) {
      if (!this.dropping && this.data.length + text.length > this.limit) {
        this.data = (this.data + text).slice(0, this.limit);
        this.dropping = true;
        this.attempt.inspectionLimited = true;
      } else if (!this.dropping) this.data += text;
      return;
    }
    for (const char of text) {
      if (char === "\n" && this.previousCR) { this.previousCR = false; continue; }
      this.previousCR = char === "\r";
      if (char === "\r" || char === "\n") this.endLine();
      else if (this.line.length + this.data.length < this.limit) this.line += char;
      else this.drop();
    }
  }
  private drop(): void {
    this.dropping = true;
    this.attempt.inspectionLimited = true;
    // Keep a nonempty marker so the next newline is not mistaken for a blank event separator.
    this.line = "!";
    this.data = "";
  }
  private endLine(): void {
    if (!this.line) this.dispatch();
    else if (!this.dropping && this.line.startsWith("data:")) {
      this.data += `${this.line.slice(5).replace(/^ /, "")}\n`;
    }
    this.line = "";
  }
  private dispatch(): void {
    if (!this.dropping && this.data.trim() && this.data.trim() !== "[DONE]") this.inspect(this.data);
    this.data = "";
    this.dropping = false;
  }
  private inspect(text: string): void {
    let event: unknown;
    try { event = JSON.parse(text); } catch {
      if (!this.sse && this.attempt.status !== undefined && this.attempt.status >= 400) {
        const message = boundedText(text, PROVIDER_ERROR_MESSAGE_LIMIT);
        this.attempt.providerError = {
          eventType: "http.error", message: message.value,
          ...(message.truncated || this.dropping ? { truncated: true } : {}),
        };
      }
      return;
    }
    if (!isRecord(event)) return;
    const capturedError = providerError(event, this.attempt.status);
    if (capturedError) this.attempt.providerError = capturedError;
    const response = isRecord(event.response) ? event.response : event;
    const terminal = ["response.completed", "response.incomplete", "response.failed"].includes(String(event.type)) ||
      (event.object === "response" && ["completed", "incomplete", "failed"].includes(String(event.status)));
    const created = event.type === "response.created";
    if (!terminal && !created) return;
    const id = safeId(response.id);
    if (id) this.attempt.responseId = id;
    if (terminal) {
      // Early response.created metadata is not proof of the final service tier.
      this.attempt.responseTier = "service_tier" in response ? tierOf(response) : undefined;
      this.attempt.terminalResponse = true;
    } else if (!this.attempt.terminalResponse && "service_tier" in response) {
      this.attempt.responseTier = tierOf(response);
    }
  }
}

export function observeResponse(response: Response, attempt: Attempt): Response {
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  const sse = contentType.includes("text/event-stream");
  if (!response.body || (!sse && !contentType.includes("application/json") && response.status < 400)) return response;
  const inspector = new ResponseInspector(attempt, sse);
  const body = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) { inspector.push(chunk); controller.enqueue(chunk); },
    flush() { inspector.finish(); },
  }));
  const observed = new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
  // A constructed Response otherwise loses these read-only transport properties.
  Object.defineProperties(observed, {
    url: { value: response.url }, redirected: { value: response.redirected }, type: { value: response.type },
  });
  return observed;
}

function inspectRequestBody(body: unknown): Attempt["sentTier"] {
  // Pi's OpenAI SDK sends JSON strings. Unknown body types remain explicitly unverified;
  // consuming/cloning arbitrary Request streams could delay, buffer, or alter a request.
  if (typeof body !== "string" || body.length > MAX_REQUEST_CHARS) return "unknown";
  try { return tierOf(JSON.parse(body)); } catch { return "unknown"; }
}

/** Per-call fetch injection. No global patches, added headers, credential reads, or extra API calls. */
export function auditedFetch(audit: Audit, delegate: typeof globalThis.fetch): typeof globalThis.fetch {
  return async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const attempt: Attempt = {
      number: ++audit.attemptCount, startedAt: new Date().toISOString(),
      origin: safeOrigin(url), sentTier: inspectRequestBody(init?.body),
    };
    audit.attempts.push(attempt);
    if (audit.attempts.length > ATTEMPT_LIMIT) audit.attempts.shift();
    try {
      const response = await delegate(input, init);
      attempt.status = response.status;
      attempt.requestId = safeId(response.headers.get("x-request-id"));
      return observeResponse(response, attempt);
    } catch (error) {
      attempt.networkError = true;
      throw error;
    }
  };
}
