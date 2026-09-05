import assert from "node:assert/strict";
import { test } from "node:test";
import { AuditStore, decodeAudit, type Entry, STATE_ENTRY, verdict } from "../src/audit.ts";
import { auditedFetch, ResponseInspector } from "../src/transport.ts";

const model = { provider: "openai", api: "openai-responses", id: "gpt-5.4" };

test("request serialization can differ from payload object; audit uses serialized body", async () => {
  const store = new AuditStore(() => {});
  store.setMode("on");
  const audit = store.begin(model, "transport");
  audit.payloadTier = "flex";
  const payload = { service_tier: "flex", toJSON: () => ({ service_tier: "default" }) };
  await auditedFetch(audit, async () => new Response("ok"))("https://api.openai.com/v1/responses", { method: "POST", body: JSON.stringify(payload) });
  assert.equal(audit.payloadTier, "flex");
  assert.equal(audit.attempts[0]?.sentTier, "default");
  assert.equal(verdict(audit).sentAsFlex, "NO");
  assert.equal(verdict(audit).mismatch, true);
});

test("mode changes do not rewrite in-flight audit history", () => {
  const store = new AuditStore(() => {});
  store.setMode("on");
  const audit = store.begin(model, "transport");
  store.setMode("off");
  assert.equal(audit.mode, "on");
  assert.equal(store.begin(model, "transport").mode, "off");
});

test("unobserved historical mode is unknown, error retained, invalid timestamps ignored", () => {
  const store = new AuditStore(() => {});
  const entries: Entry[] = [
    { type: "custom", customType: STATE_ENTRY, data: { version: 1, mode: "on" } },
    { type: "message", message: { role: "assistant", provider: "openai", api: "openai-responses", model: "gpt-5.4", timestamp: Date.now(), stopReason: "error" } },
  ];
  store.restore(entries);
  assert.equal(store.last?.mode, "unknown");
  assert.equal(store.last?.outcome, "error");
  store.restore([{ type: "message", message: { role: "assistant", timestamp: Number.MAX_VALUE } }]);
  assert.equal(store.last, undefined);
});

test("persisted omitted tiers stay omitted", () => {
  const store = new AuditStore(() => {});
  const audit = store.begin(model, "payload-only");
  audit.payloadTier = "omitted";
  assert.equal(decodeAudit(audit)?.payloadTier, "omitted");
});

test("oversized final event cannot confirm an early Flex tier", () => {
  const store = new AuditStore(() => {});
  const audit = store.begin(model, "transport");
  const attempt = { number: 1, startedAt: audit.startedAt, sentTier: "flex" as const, status: 200 };
  audit.attempts.push(attempt);
  audit.attemptCount = 1;
  const inspector = new ResponseInspector(attempt, true, 256);
  const encode = (value: unknown) => new TextEncoder().encode(`data: ${JSON.stringify(value)}\n\n`);
  inspector.push(encode({ type: "response.created", response: { service_tier: "flex" } }));
  inspector.push(encode({ type: "response.completed", response: { service_tier: "default", output: "x".repeat(1024) } }));
  inspector.finish();
  store.finish(audit, { stopReason: "stop", timestamp: Date.now() });
  assert.equal(verdict(audit).servedAsFlex, "UNKNOWN");
});

test("network evidence retained for at most 20 retries; truncation explicit", async () => {
  const store = new AuditStore(() => {});
  const audit = store.begin(model, "transport");
  const request = auditedFetch(audit, async () => new Response("ok"));
  for (let i = 0; i < 25; i++) await request("https://api.openai.com/v1/responses", { body: '{"service_tier":"flex"}' });
  assert.equal(audit.attemptCount, 25);
  assert.equal(audit.attempts.length, 20);
  assert.equal(audit.attempts[0]?.number, 6);
  assert.equal(verdict(audit).sentAsFlex, "UNKNOWN");
});
