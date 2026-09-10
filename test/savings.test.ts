import assert from "node:assert/strict";
import { test } from "node:test";
import { AUDIT_ENTRY, type Audit, AuditStore, decodeAudit, type Entry } from "../src/audit.ts";
import { capturePricing, decodePricing, decodeUsage, standardCost } from "../src/pricing.ts";
import { estimateSavings, formatSavings, savingsReport, type EstimatedSavings } from "../src/savings.ts";

const model = { provider: "openai", api: "openai-responses", id: "test-model" };
const now = Date.parse("2026-09-04T23:27:13.464Z");
const rates = { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 };
const usage = {
  input: 3, output: 211, cacheRead: 0, cacheWrite: 108320,
  reasoning: 176, totalTokens: 108534,
  cost: { input: 0.000015, output: 0.005275, cacheRead: 0, cacheWrite: 0.677, total: 0.68229 },
};
function close(actual: number, expected: number): void {
  assert.ok(Math.abs(actual - expected) <= 1e-12, `${actual} != ${expected}`);
}
function call(id = "test_call"): Audit {
  return {
    version: 1, id, startedAt: new Date(now).toISOString(), finishedAt: new Date(now + 1000).toISOString(),
    messageTimestamp: now, model: { ...model }, mode: "on", coverage: "transport", outcome: "complete",
    payloadTier: "flex", attemptCount: 1,
    attempts: [{ number: 1, startedAt: new Date(now).toISOString(), sentTier: "flex", status: 200, terminalResponse: true, responseTier: "flex", responseId: "resp_test" }],
    pricing: capturePricing(rates, new Date(now).toISOString()), usage: decodeUsage(usage),
  };
}
function auditEntry(audit: Audit): Entry { return { type: "custom", customType: AUDIT_ENTRY, data: structuredClone(audit) }; }
function messageEntry(audit: Audit): Entry {
  return { type: "message", message: { role: "assistant", provider: audit.model.provider, api: audit.model.api, model: audit.model.id, timestamp: audit.messageTimestamp, responseId: audit.attempts.at(-1)?.responseId, usage, content: "SECRET" } };
}
function estimated(audit: Audit): EstimatedSavings {
  const result = estimateSavings(audit);
  assert.equal(result.status, "estimated", JSON.stringify(result));
  return result as EstimatedSavings;
}

test("same sample usage: standard $1.36458, Pi Flex $0.68229, saved $0.68229; no double discount", () => {
  const audit = call();
  const before = structuredClone(audit);
  const result = estimated(audit);
  assert.equal(result.standardCost.total.toFixed(5), "1.36458");
  assert.equal(result.piCost.total, 0.68229);
  assert.equal(result.savedUsd.toFixed(5), "0.68229");
  assert.equal(result.savedPercent, 50);
  assert.equal(result.source, "request-time-prices");
  assert.deepEqual(audit, before, "pricing must not mutate Pi usage or audit metadata");
  const text = formatSavings(savingsReport([auditEntry(audit)]));
  assert.match(text, /\$0.682290 \(50.0%\)/);
  assert.doesNotMatch(text, /Last AI call|Served tier:|Tokens:|Reasoning:|Basis:/);
  assert.match(text, /Session branch:/);
  assert.match(text, /Estimates, not billing/);
});

test("actual returned tier wins over toggle; confirmed standard contributes zero savings", () => {
  const audit = call();
  audit.mode = "off";
  assert.equal(estimated(audit).savedPercent, 50, "returned Flex, not current toggle, earns savings");
  audit.mode = "on";
  audit.attempts[0]!.responseTier = "default";
  audit.usage!.cost = { input: 0.00003, output: 0.01055, cacheRead: 0, cacheWrite: 1.354, total: 1.36458 };
  const result = estimated(audit);
  assert.equal(result.servedTier, "default");
  assert.equal(result.savedUsd, 0);
  assert.equal(result.savedPercent, 0);
});

test("request-wide price tiers include cached/write tokens; threshold is strictly greater", () => {
  const snapshot = capturePricing({ ...rates, tiers: [
    { inputTokensAbove: 272000, input: 20, output: 75, cacheRead: 2, cacheWrite: 25 },
    { inputTokensAbove: 100, input: 11, output: 51, cacheRead: 1.1, cacheWrite: 13 },
  ] }, new Date(now).toISOString())!;
  const atThreshold = decodeUsage({ ...usage, input: 0, cacheRead: 271999, cacheWrite: 1, output: 10, reasoning: 0, totalTokens: 272010 })!;
  const aboveThreshold = { ...atThreshold, cacheRead: 272000, totalTokens: 272011 };
  const at = standardCost(snapshot.rates, atThreshold)!;
  const above = standardCost(snapshot.rates, aboveThreshold)!;
  close(at.output, 10 * 51 / 1e6);
  close(above.output, 10 * 75 / 1e6);
  close(above.cacheRead, 272000 * 2 / 1e6);
  close(above.cacheWrite, 25 / 1e6);
});

test("price snapshots are independent of later model catalog mutations", () => {
  const original = { ...rates, tiers: [{ ...rates, inputTokensAbove: 100 }] };
  const snapshot = capturePricing(original, new Date(now).toISOString())!;
  original.input = 999;
  original.tiers[0]!.output = 999;
  assert.equal(snapshot.rates.input, 10);
  assert.equal(snapshot.rates.tiers![0]!.output, 50);
});

test("cache reads, cache writes, and 1h writes priced separately; reasoning not charged twice", () => {
  const counts = decodeUsage({ ...usage, input: 100, cacheRead: 200, cacheWrite: 300, cacheWrite1h: 100, output: 1000, reasoning: 900, totalTokens: 1600 })!;
  const cost = standardCost(rates, counts)!;
  close(cost.input, 0.001);
  close(cost.cacheRead, 0.0002);
  close(cost.cacheWrite, (200 * 12.5 + 100 * 10 * 2) / 1e6);
  close(cost.output, 0.05);
});

test("failed, pending, unverified, and unsupported calls never claim savings", () => {
  for (const outcome of ["pending", "error", "aborted", "interrupted"] as const) {
    assert.equal(estimateSavings({ ...call(), outcome }).status, "unavailable");
  }
  for (const responseTier of [undefined, "unknown", "omitted", "auto", "priority", "scale"] as const) {
    const audit = call();
    audit.attempts[0]!.responseTier = responseTier;
    assert.equal(estimateSavings(audit).status, "unavailable");
  }
  for (const coverage of ["payload-only", "unobserved"] as const) assert.equal(estimateSavings({ ...call(), coverage }).status, "unavailable");
  assert.equal(estimateSavings({ ...call(), model: { ...model, provider: "openai-codex" } }).status, "unavailable");
  const early = call();
  early.attempts[0]!.terminalResponse = false;
  assert.equal(estimateSavings(early).status, "unavailable");
});

test("zero/missing rates and mismatched Pi estimates are unknown, not free or guessed", () => {
  const zero = call();
  zero.usage!.cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
  assert.equal(estimateSavings(zero).status, "unavailable");
  assert.equal(estimateSavings({ ...call(), pricing: null }).status, "unavailable");
  assert.equal(estimateSavings({ ...call(), usage: undefined }).status, "unavailable");
  const mismatch = call();
  mismatch.usage!.cost = { input: 0.00003, output: 0.01055, cacheRead: 0, cacheWrite: 1.354, total: 1.36458 };
  const result = estimateSavings(mismatch);
  assert.equal(result.status, "unavailable");
  if (result.status === "unavailable") assert.equal(result.reason, "conflict");
});

test("numeric metadata validation rejects corrupt counts, rates, totals, and leaked fields", () => {
  for (const input of [-1, NaN, Infinity, "3", 1.5]) assert.equal(decodeUsage({ ...usage, input }), undefined);
  assert.equal(decodeUsage({ ...usage, totalTokens: 42 }), undefined);
  assert.equal(decodeUsage({ ...usage, reasoning: 212 }), undefined);
  assert.equal(decodeUsage({ ...usage, cacheWrite1h: 200000 }), undefined);
  assert.equal(decodeUsage({ ...usage, cost: { ...usage.cost, total: 99 } }), undefined);
  assert.equal(capturePricing({ ...rates, input: -1 }, new Date(now).toISOString()), undefined);
  assert.equal(decodePricing({ rates, source: "unexpected" }), undefined);
  const audit = decodeAudit({ ...call(), pricing: { invalid: true }, usage: { ...usage, prompt: "SECRET", cost: { ...usage.cost, secret: "SECRET" } } })!;
  assert.equal(audit.pricing, null);
  assert.doesNotMatch(JSON.stringify(audit), /SECRET/);
  assert.equal(estimateSavings(audit).status, "unavailable");
});

test("old audits recover exact saved message cost without current prices or writing entries", () => {
  const legacy = call();
  delete legacy.usage;
  delete legacy.pricing;
  const entries = [auditEntry(legacy), messageEntry(legacy)];
  const before = structuredClone(entries);
  const report = savingsReport(entries);
  assert.equal(report.lastCall?.status, "estimated");
  if (report.lastCall?.status === "estimated") {
    assert.equal(report.lastCall.source, "saved-pi-cost");
    assert.equal(report.lastCall.piCost.total, 0.68229);
    assert.equal(report.lastCall.savedUsd.toFixed(5), "0.68229");
  }
  assert.equal(report.session.historicalCalls, 1);
  assert.equal(report.session.unmatchedAssistantMessages, 0);
  assert.deepEqual(entries, before);
  assert.doesNotMatch(JSON.stringify(report), /SECRET/);
});

test("legacy backfill requires matching provider/model/api/timestamp/response ID, rejects ambiguous match", () => {
  const legacy = call();
  delete legacy.usage;
  delete legacy.pricing;
  const message = messageEntry(legacy);
  for (const key of ["provider", "api", "model", "timestamp", "responseId"]) {
    const changed = structuredClone(message);
    (changed.message as Record<string, unknown>)[key] = key === "timestamp" ? now + 1 : "other";
    const report = savingsReport([auditEntry(legacy), changed]);
    assert.equal(report.session.includedCalls, 0, key);
    assert.equal(report.session.unmatchedAssistantMessages, 1);
  }
  assert.equal(savingsReport([auditEntry(legacy), message, message]).session.includedCalls, 0);
});

test("snapshots dedupe by audit ID; separate audit IDs cannot borrow one response twice", () => {
  const audit = call();
  const report = savingsReport([auditEntry(audit), auditEntry(audit), messageEntry(audit)], [audit]);
  assert.equal(report.session.includedCalls, 1);
  const second = { ...audit, id: "duplicate_audit" };
  const duplicate = savingsReport([auditEntry(audit), auditEntry(second), messageEntry(audit)]);
  assert.equal(duplicate.session.includedCalls, 1);
  assert.equal(duplicate.session.excludedCalls, 1);
});

test("session totals span more than 50 calls, survive restore, and follow active branch", () => {
  const entries: Entry[] = [];
  const store = new AuditStore((customType, data) => entries.push({ type: "custom", customType, data }));
  for (let i = 0; i < 65; i++) {
    const audit = store.begin(model, "transport", now + i);
    audit.pricing = capturePricing(rates, audit.startedAt)!;
    audit.attemptCount = 1;
    audit.attempts = [{ ...call().attempts[0]!, responseId: `resp_${i}` }];
    store.finish(audit, { stopReason: "stop", timestamp: now + i, usage });
  }
  assert.equal(store.records.length, 50);
  let report = savingsReport(entries, store.records);
  assert.equal(report.session.includedCalls, 65);
  assert.equal(report.session.savedUsd!.toFixed(5), (65 * 0.68229).toFixed(5));
  store.restore(entries);
  report = savingsReport(entries, store.records);
  assert.equal(report.session.includedCalls, 65);
  const branch = entries.slice(0, 6); // Three calls, with start/end snapshots.
  store.restore(branch);
  report = savingsReport(branch, store.records);
  assert.equal(report.session.includedCalls, 3);
});

test("empty/excluded totals are unknown; mixed Flex/default percentages are weighted", () => {
  const empty = savingsReport([]);
  assert.equal(empty.session.savedUsd, null);
  assert.match(formatSavings(empty), /totals unknown/);
  assert.doesNotMatch(formatSavings(empty), /Last AI call/);
  const flex = call("flex_call");
  const standard = call("standard_call");
  standard.attempts[0]!.responseTier = "default";
  standard.usage!.cost = { input: 0.00003, output: 0.01055, cacheRead: 0, cacheWrite: 1.354, total: 1.36458 };
  const missing = { ...call("missing_call"), usage: undefined };
  const report = savingsReport([auditEntry(flex), auditEntry(standard), auditEntry(missing), { type: "message", message: { role: "assistant", timestamp: 42 } }]);
  assert.equal(report.session.includedCalls, 2);
  assert.equal(report.session.flexCalls, 1);
  assert.equal(report.session.standardCalls, 1);
  assert.equal(report.session.excludedCalls, 1);
  assert.equal(report.session.unmatchedAssistantMessages, 1);
  assert.equal(report.session.savedPercent, 25);
  assert.equal(report.lastCall?.status, "unavailable", "do not substitute the last successful call");
});

test("live pending call replaces older saved completion in last-call report", () => {
  const earlier = call("earlier");
  const pending = { ...call("pending"), outcome: "pending" as const, usage: undefined, attempts: [], attemptCount: 0 };
  const report = savingsReport([auditEntry(earlier), auditEntry(pending)], [earlier, pending]);
  assert.equal(report.lastCall?.id, "pending");
  assert.equal(report.lastCall?.status, "unavailable");
  assert.equal(report.session.includedCalls, 1);
});

test("overflowing session sums remain unknown rather than emitting Infinity or NaN", () => {
  const first = call("huge_1");
  delete first.pricing;
  first.usage!.cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 8e307, total: 8e307 };
  const second = { ...first, id: "huge_2" };
  const report = savingsReport([auditEntry(first), auditEntry(second)]);
  assert.equal(report.session.includedCalls, 2);
  assert.equal(report.session.standardUsd, null);
  assert.equal(report.session.savedPercent, null);
  assert.doesNotMatch(formatSavings(report), /Infinity|NaN/);
  assert.match(formatSavings(report), /numeric range exceeded/);
});
