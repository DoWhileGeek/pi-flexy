import assert from "node:assert/strict";
import { test } from "node:test";
import { AuditStore, type Attempt } from "../src/audit.ts";
import { auditedFetch, observeResponse, ResponseInspector } from "../src/transport.ts";

const encoder = new TextEncoder();
function attempt(): Attempt { return { number: 1, startedAt: new Date().toISOString(), sentTier: "flex" }; }
const completed = JSON.stringify({ type: "response.completed", response: { id: "resp_123", service_tier: "flex", status: "completed", output: [{ text: "secret 🦴" }] } });

test("SSE inspection survives byte boundaries, Unicode, CRLF, comments, multiline data", () => {
  const record = attempt();
  const inspector = new ResponseInspector(record, true);
  const split = completed.indexOf(',"response"') + 1;
  const source = `: keepalive\r\nevent: response.completed\r\ndata: ${completed.slice(0, split)}\r\ndata: ${completed.slice(split)}\r\n\r\ndata: [DONE]\r\n\r\n`;
  for (const byte of encoder.encode(source)) inspector.push(new Uint8Array([byte]));
  inspector.finish();
  assert.equal(record.responseTier, "flex");
  assert.equal(record.responseId, "resp_123");
  assert.equal(record.terminalResponse, true);
  assert.equal(JSON.stringify(record).includes("secret"), false);
});

test("early tier is tentative; final missing tier clears it", () => {
  const record = attempt();
  const inspector = new ResponseInspector(record, true);
  inspector.push(encoder.encode('data: {"type":"response.created","response":{"id":"resp_1","service_tier":"flex"}}\n\n'));
  assert.equal(record.responseTier, "flex");
  assert.equal(record.terminalResponse, undefined);
  inspector.push(encoder.encode('data: {"type":"response.completed","response":{"id":"resp_1"}}\n\n'));
  inspector.finish();
  assert.equal(record.responseTier, undefined);
  assert.equal(record.terminalResponse, true);
});

test("malformed and oversized events skipped; parser recovers at next event", () => {
  const record = attempt();
  const inspector = new ResponseInspector(record, true, 256);
  inspector.push(encoder.encode(`data: invalid\n\ndata: ${"x".repeat(3000)}\n\ndata: ${completed}\n\n`));
  inspector.finish();
  assert.equal(record.inspectionLimited, true);
  assert.equal(record.responseTier, "flex");
});

test("response observer forwards identical bytes and cancellation; no background tee", async () => {
  let canceled = false;
  const original = encoder.encode(`data: ${completed}\n\n`);
  const source = new Response(new ReadableStream({
    start(controller) { controller.enqueue(original); controller.close(); },
  }), { headers: { "content-type": "text/event-stream", "x-request-id": "req_123" } });
  const record = attempt();
  const observed = observeResponse(source, record);
  assert.deepEqual(new Uint8Array(await observed.arrayBuffer()), original);
  assert.equal(observed.headers.get("x-request-id"), "req_123");
  assert.equal(record.responseTier, "flex");

  const endless = new Response(new ReadableStream({ cancel() { canceled = true; } }), { headers: { "content-type": "text/event-stream" } });
  await observeResponse(endless, attempt()).body!.cancel();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(canceled, true);
});

test("JSON response and bounded HTTP provider errors are observed; non-JSON passes through", async () => {
  const record = attempt();
  const response = observeResponse(new Response(JSON.stringify({ object: "response", id: "resp_json", status: "completed", service_tier: "default" }), { headers: { "content-type": "application/json" } }), record);
  await response.text();
  assert.equal(record.responseTier, "default");
  assert.equal(record.terminalResponse, true);

  const rejected = attempt();
  rejected.status = 429;
  const rejection = observeResponse(new Response(JSON.stringify({ error: {
    code: "flex_capacity_exceeded", type: "server_error", param: "service_tier",
    message: "Flex unavailable — retry later.",
  } }), { status: 429, headers: { "content-type": "application/json" } }), rejected);
  await rejection.text();
  assert.deepEqual(rejected.providerError, {
    eventType: "http.error", code: "flex_capacity_exceeded", type: "server_error",
    param: "service_tier", message: "Flex unavailable — retry later.",
  });

  const oversized = attempt();
  oversized.status = 400;
  const oversizedRejection = observeResponse(new Response(JSON.stringify({ error: {
    code: "x".repeat(2_000), message: "m".repeat(40_000),
  } }), { status: 400, headers: { "content-type": "application/json" } }), oversized);
  await oversizedRejection.text();
  assert.equal(oversized.providerError?.code?.length, 1_024);
  assert.equal(oversized.providerError?.message?.length, 32 * 1_024);
  assert.equal(oversized.providerError?.truncated, true);

  const plainError = attempt();
  plainError.status = 503;
  const plainRejection = observeResponse(new Response("upstream overloaded", { status: 503 }), plainError);
  await plainRejection.text();
  assert.deepEqual(plainError.providerError, { eventType: "http.error", message: "upstream overloaded" });

  const plain = new Response("hello");
  assert.equal(observeResponse(plain, attempt()), plain);
});

test("SSE error events and response failures retain rejection envelopes, never output", () => {
  const direct = attempt();
  const directInspector = new ResponseInspector(direct, true);
  directInspector.push(encoder.encode('data: {"type":"error","code":"flex_capacity_exceeded","message":"Please retry your request.","param":null}\n\n'));
  directInspector.finish();
  assert.deepEqual(direct.providerError, {
    eventType: "error", code: "flex_capacity_exceeded", param: null, message: "Please retry your request.",
  });

  const failed = attempt();
  const failedInspector = new ResponseInspector(failed, true);
  failedInspector.push(encoder.encode(`data: ${JSON.stringify({
    type: "response.failed",
    response: {
      id: "resp_failed", status: "failed", service_tier: "flex", output: [{ text: "must not persist" }],
      error: { code: "server_error", type: "provider_error", message: "Capacity unavailable." },
    },
  })}\n\n`));
  failedInspector.finish();
  assert.deepEqual(failed.providerError, {
    eventType: "response.failed", code: "server_error", type: "provider_error", message: "Capacity unavailable.",
  });
  assert.equal(failed.responseId, "resp_failed");
  assert.equal(failed.terminalResponse, true);
  assert.doesNotMatch(JSON.stringify(failed), /must not persist/);

  const incomplete = attempt();
  const incompleteInspector = new ResponseInspector(incomplete, true);
  incompleteInspector.push(encoder.encode(`data: ${JSON.stringify({
    type: "response.failed", response: { status: "failed", incomplete_details: { reason: "max_output_tokens" } },
  })}\n\n`));
  incompleteInspector.finish();
  assert.deepEqual(incomplete.providerError, {
    eventType: "response.failed", reason: "max_output_tokens",
  });
});

test("fetch records final body, response IDs, every retry, no credentials or prompt", async () => {
  const store = new AuditStore(() => {});
  const record = store.begin({ provider: "openai", id: "gpt-5.4", api: "openai-responses" }, "transport");
  let calls = 0;
  const delegate: typeof fetch = async (_input, init) => {
    assert.equal((init?.headers as Record<string, string>).Authorization, "Bearer secret-key");
    calls++;
    return calls === 1 ? new Response(JSON.stringify({ error: { code: "rate_limit", message: "capacity" } }), {
      status: 429, headers: { "content-type": "application/json" },
    })
      : new Response(`data: ${completed}\n\n`, { headers: { "content-type": "text/event-stream", "x-request-id": "req_123" } });
  };
  const wrapped = auditedFetch(record, delegate);
  const init = { method: "POST", headers: { Authorization: "Bearer secret-key" }, body: JSON.stringify({ service_tier: "flex", input: "secret-prompt" }) };
  await (await wrapped("https://username:password@example.com/v1/responses?secret-query", init)).text();
  await (await wrapped("https://example.com/v1/responses", init)).text();
  assert.equal(record.attemptCount, 2);
  assert.deepEqual(record.attempts.map(a => a.status), [429, 200]);
  assert.equal(record.attempts[1]?.responseTier, "flex");
  assert.equal(record.attempts[0]?.origin, "https://example.com");
  assert.deepEqual(record.attempts[0]?.providerError, {
    eventType: "http.error", code: "rate_limit", message: "capacity",
  });
  assert.doesNotMatch(JSON.stringify(record), /secret-prompt|secret-key|password|username|Authorization/);
});

test("transport failures rethrow exact error; body types never inspected speculatively", async () => {
  const store = new AuditStore(() => {});
  const record = store.begin({ provider: "openai", id: "gpt-5.4", api: "openai-responses" }, "transport");
  const error = new Error("network down");
  const wrapped = auditedFetch(record, async () => { throw error; });
  await assert.rejects(() => wrapped("https://api.openai.com/v1/responses", { body: new Uint8Array([1]) }), value => value === error);
  assert.equal(record.attempts[0]?.sentTier, "unknown");
  assert.equal(record.attempts[0]?.networkError, true);
});
