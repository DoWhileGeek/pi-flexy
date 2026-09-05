import { ATTEMPT_LIMIT, type Attempt, type Audit, isRecord, safeId, safeOrigin, tierOf } from "./audit.ts";

export const MAX_EVENT_CHARS = 256 * 1024;
const MAX_REQUEST_CHARS = 16 * 1024 * 1024;

/** Bounded, incremental SSE inspection. Content is forwarded unchanged, never retained in audit data. */
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
    } else if (!this.dropping) this.inspect(this.data);
    this.line = "";
    this.data = "";
  }
  private accept(text: string): void {
    if (!this.sse) {
      if (this.data.length + text.length > this.limit) this.drop();
      else if (!this.dropping) this.data += text;
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
    try { event = JSON.parse(text); } catch { return; }
    if (!isRecord(event)) return;
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
  if (!response.body || (!sse && !contentType.includes("application/json"))) return response;
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
