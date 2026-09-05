import assert from "node:assert/strict";
import { test } from "node:test";
import {
  AUDIT_ENTRY, STATE_ENTRY, AuditStore, decodeAudit, formatAudit, managed, scopeReason, tierOf, verdict, type Entry,
} from "../src/audit.ts";

const model = { provider: "openai", api: "openai-responses", id: "gpt-5.4" };
function fixture() {
  const entries: Entry[] = [];
  const store = new AuditStore((customType, data) => entries.push({ type: "custom", customType, data }));
  return { store, entries };
}

test("default off; versioned session mode restores independently", () => {
  const { store, entries } = fixture();
  assert.equal(store.mode, "off");
  store.setMode("on");
  assert.deepEqual(entries[0], { type: "custom", customType: STATE_ENTRY, data: { version: 1, mode: "on" } });
  const second = fixture().store;
  second.restore(entries);
  assert.equal(second.mode, "on");
  second.restore([]);
  assert.equal(second.mode, "off");
  assert.equal(store.mode, "on");
});

test("provider + API scope excludes subscriptions and compatible proxies under other providers", () => {
  assert.ok(managed(model));
  assert.ok(managed({ ...model, id: "future-model-2029-01-01" }));
  for (const provider of ["openai-codex", "anthropic", "openrouter", "azure-openai-responses"]) {
    assert.equal(managed({ ...model, provider }), false);
  }
  assert.equal(managed({ ...model, api: "openai-completions" }), false);
  assert.match(scopeReason({ ...model, provider: "openai-codex" }), /subscription/);
});

test("tier parsing distinguishes omission, invalid values, and absent evidence", () => {
  assert.equal(tierOf({}), "omitted");
  assert.equal(tierOf(null), "unknown");
  assert.equal(tierOf({ service_tier: null }), "unknown");
  assert.equal(tierOf({ service_tier: "do not print me" }), "unknown");
  assert.equal(tierOf({ service_tier: "flex" }), "flex");
});

test("toggle and payload alone never prove Flex transmission", () => {
  const { store } = fixture();
  store.setMode("on");
  const call = store.begin(model, "payload-only");
  call.payloadTier = "flex";
  store.finish(call, { stopReason: "stop", timestamp: 123 });
  assert.deepEqual(verdict(call), { sentAsFlex: "UNKNOWN", servedAsFlex: "UNKNOWN", mismatch: false });
  assert.match(formatAudit(call), /not proof of delivery/);
});

test("separates wire Flex from returned standard and reports mismatch", () => {
  const { store } = fixture();
  store.setMode("on");
  const call = store.begin(model, "transport");
  call.attemptCount = 1;
  call.attempts.push({ number: 1, startedAt: call.startedAt, sentTier: "flex", status: 200, responseTier: "default", terminalResponse: true });
  store.finish(call, { stopReason: "stop", timestamp: 123 });
  assert.deepEqual(verdict(call), { sentAsFlex: "YES", servedAsFlex: "NO", mismatch: true });
  assert.match(formatAudit(call), /MISMATCH/);
  store.setMode("off");
  assert.equal(call.mode, "on", "historical audit must not use today's toggle");
});

test("failed, early, or unobserved responses cannot confirm service", () => {
  const { store } = fixture();
  const call = store.begin(model, "transport");
  call.attemptCount = 1;
  const attempt = { number: 1, startedAt: call.startedAt, sentTier: "flex" as const, status: 200, responseTier: "flex" as const, terminalResponse: false };
  call.attempts.push(attempt);
  call.outcome = "complete";
  assert.equal(verdict(call).servedAsFlex, "UNKNOWN");
  attempt.terminalResponse = true;
  call.outcome = "error";
  assert.equal(verdict(call).servedAsFlex, "UNKNOWN");
  call.outcome = "complete";
  attempt.status = 429;
  assert.equal(verdict(call).servedAsFlex, "UNKNOWN");
  attempt.status = 200;
  assert.equal(verdict(call).servedAsFlex, "YES");
});

test("retries preserve mixed requests and truncated histories cannot claim all attempts", () => {
  const { store } = fixture();
  const call = store.begin(model, "transport");
  call.attemptCount = 2;
  call.attempts = [
    { number: 1, startedAt: call.startedAt, sentTier: "flex", status: 429 },
    { number: 2, startedAt: call.startedAt, sentTier: "default", status: 200 },
  ];
  assert.equal(verdict(call).sentAsFlex, "MIXED");
  call.attemptCount = 3;
  assert.equal(verdict(call).sentAsFlex, "UNKNOWN");
  assert.match(formatAudit(call), /last 2 of 3/);
});

test("snapshots deduplicate by ID; interrupted calls restore as interrupted; branches stay isolated", () => {
  const { store, entries } = fixture();
  const call = store.begin(model, "transport");
  store.persist(call);
  const beforeFinish = structuredClone(entries);
  store.finish(call, { stopReason: "stop", timestamp: Date.now() });
  const restored = fixture().store;
  restored.restore(entries);
  assert.equal(restored.records.length, 1);
  assert.equal(restored.last?.outcome, "complete");
  restored.restore(beforeFinish);
  assert.equal(restored.last?.outcome, "interrupted");
  restored.restore([]);
  assert.equal(restored.last, undefined);
  const count = entries.length;
  store.restore([]);
  store.finish(call, { stopReason: "stop", timestamp: 10 });
  assert.equal(entries.length, count, "old callbacks must not append to new branch");
});

test("newer unobserved assistant replaces older audit; matching assistant does not duplicate", () => {
  const { store, entries } = fixture();
  const now = Date.now();
  const call = store.begin(model, "transport", now);
  store.finish(call, { stopReason: "stop", timestamp: now });
  entries.push({ type: "message", message: { role: "assistant", provider: model.provider, api: model.api, model: model.id, timestamp: now } });
  store.restore(entries);
  assert.equal(store.records.length, 1);
  entries.push({ type: "message", message: { role: "assistant", provider: "anthropic", api: "anthropic-messages", model: "claude", timestamp: now + 1000 } });
  store.restore(entries);
  assert.equal(store.last?.model.provider, "anthropic");
  assert.equal(store.last?.coverage, "unobserved");
  assert.equal(verdict(store.last!).sentAsFlex, "UNKNOWN");
});

test("malformed persisted entries ignored; extra data stripped; history bounded", () => {
  const { store } = fixture();
  store.restore([
    { type: "custom", customType: STATE_ENTRY, data: { version: 2, mode: "on" } },
    { type: "custom", customType: AUDIT_ENTRY, data: { version: 1, attempts: "bad" } },
  ]);
  assert.equal(store.mode, "off");
  assert.equal(store.last, undefined);
  for (let i = 0; i < 55; i++) store.begin(model, "transport");
  assert.equal(store.records.length, 50);
  const decoded = decodeAudit({ ...store.records.at(-1), prompt: "secret", auth: "secret", model: { ...model, key: "secret" } });
  assert.ok(decoded);
  assert.equal(JSON.stringify(decoded).includes("secret"), false);
});
