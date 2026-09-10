import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm, stat, symlink, link } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { AUDIT_ENTRY, type Audit, type Entry } from "../src/audit.ts";
import { capturePricing, decodeUsage } from "../src/pricing.ts";
import { allSavingsReport, formatAllSavings, rollupSavings } from "../src/all-savings.ts";
import { MAX_SESSION_LINE_BYTES, scanSavingsSessions, type SavingsSession } from "../src/session-scan.ts";

const at = "2026-09-09T10:00:00.000Z";
function audit(id: string, tier: "flex" | "default" = "flex"): Audit {
  const factor = tier === "flex" ? 1 : 2;
  return {
    version: 1, id, startedAt: at, finishedAt: "2026-09-09T10:01:00.000Z", messageTimestamp: Date.parse(at),
    model: { provider: "openai", api: "openai-responses", id: "test-model" },
    mode: "on", coverage: "transport", outcome: "complete", attemptCount: 1,
    attempts: [{ number: 1, startedAt: at, sentTier: tier, status: 200, terminalResponse: true, responseTier: tier, responseId: `resp_${id}` }],
    pricing: capturePricing({ input: 2, output: 4, cacheRead: 0.2, cacheWrite: 0 }, at),
    usage: decodeUsage({ input: 1e6, output: 1e6, cacheRead: 0, cacheWrite: 0, totalTokens: 2e6,
      cost: { input: factor, output: factor * 2, cacheRead: 0, cacheWrite: 0, total: factor * 3 } }),
  };
}
const ae = (a: Audit): Entry => ({ type: "custom", customType: AUDIT_ENTRY, data: a });
const message = (a: Audit): Entry => ({ type: "message", message: { role: "assistant", ...a.model, model: a.model.id,
  timestamp: a.messageTimestamp, responseId: a.attempts.at(-1)?.responseId, usage: a.usage,
  content: [{ type: "text", text: "private generated output" }], errorMessage: "private error" } });
function session(id: string, calls: Audit[], createdAt = "2026-09-09T09:00:00.000Z"): SavingsSession {
  return { id, createdAt, entries: calls.map(ae) };
}
function rollup(sessions: SavingsSession[]) {
  return rollupSavings({ sessions, roots: ["/test/sessions"], filesRead: sessions.length, duplicateFiles: 0, warnings: [] });
}
async function fixture(t: { after: (fn: () => Promise<void>) => void }): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "flexy-all-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
async function save(path: string, s: SavingsSession, tail = ""): Promise<void> {
  const header = { type: "session", version: 3, id: s.id, timestamp: s.createdAt, cwd: "/test" };
  await writeFile(path, [header, ...s.entries].map(e => JSON.stringify(e)).join("\n") + "\n" + tail);
}

test("all-session rollup deduplicates forks/snapshots/responses and attributes each call once", () => {
  const first = audit("first"), second = audit("second", "default");
  const pending = { ...first, outcome: "pending" as const, usage: undefined };
  const original = session("original", [pending, first, second]);
  const fork = session("fork", [first, second, audit("third")], "2026-09-10T09:00:00.000Z");
  const duplicate = { ...first, id: "different-audit-id" };
  const report = rollup([fork, session("export", [duplicate], "2026-09-11T00:00:00.000Z"), original]);
  assert.equal(report.totals.calls, 3);
  assert.equal(report.totals.flexCalls, 2);
  assert.equal(report.totals.standardCalls, 1);
  assert.equal(report.totals.standardUsd, 18);
  assert.equal(report.totals.piUsd, 12);
  assert.equal(report.totals.savedUsd, 6);
  assert.equal(report.totals.savedPercent, 33.333333);
  assert.equal(report.coverage.duplicateAuditCopies, 2);
  assert.equal(report.coverage.duplicateResponses, 1);
  assert.equal(report.bySession.find(s => s.id === "original")?.totals.savedUsd, 3);
  assert.equal(report.bySession.find(s => s.id === "fork")?.totals.savedUsd, 3);
  assert.equal(report.bySession.find(s => s.id === "export")?.totals.includedCalls, 0);
  assert.equal(report.byModel[0]?.totals.savedUsd, 6);
  assert.equal(report.byDay[0]?.totals.savedUsd, 6);
});

test("by-model display includes cost-weighted percentage, genuine zero, and unknown", () => {
  const flex = audit("flex"), standard = audit("standard", "default");
  // Make the standard call twice as costly: $3 / ($6 + $12) = 16.7%, not 25%.
  standard.usage = decodeUsage({ input: 2e6, output: 2e6, cacheRead: 0, cacheWrite: 0, totalTokens: 4e6,
    cost: { input: 4, output: 8, cacheRead: 0, cacheWrite: 0, total: 12 } });
  const onlyStandard = audit("only-standard", "default"); onlyStandard.model.id = "standard-only";
  const unknown = audit("unknown"); unknown.model.id = "unpriced"; delete unknown.usage;
  const report = rollup([session("session", [flex, standard, onlyStandard, unknown])]);
  const text = formatAllSavings(report);
  assert.match(text, /openai\/test-model: \$3\.000000 saved \(16\.7%; 2 priced calls\)/);
  assert.match(text, /openai\/standard-only: \$0\.000000 saved \(0\.0%; 1 priced calls\)/);
  assert.match(text, /openai\/unpriced: unknown saved \(percentage unknown; 0 priced calls\)/);
  assert.equal(report.byModel.find(g => g.model === "test-model")?.totals.savedPercent, 16.666667);
});

test("historical estimates recover only from matching session messages; no current catalog prices", () => {
  const old = audit("old");
  const msg = message(old);
  delete old.pricing; delete old.usage;
  const withEvidence = session("old-session", [old]); withEvidence.entries.push(msg);
  const isolated = audit("isolated"); delete isolated.pricing; delete isolated.usage;
  const report = rollup([withEvidence, session("other", [isolated])]);
  assert.equal(report.totals.savedUsd, 3);
  assert.equal(report.totals.historicalCalls, 1);
  assert.equal(report.totals.exclusions.usage, 1);
});

test("contradictory copies and ambiguous identities are excluded, never selected for maximum savings", () => {
  const a = audit("same"), b = structuredClone(a);
  b.usage!.cost = { input: 2, output: 4, cacheRead: 0, cacheWrite: 0, total: 6 };
  let report = rollup([session("one", [a]), session("two", [b])]);
  assert.equal(report.totals.savedUsd, null);
  assert.equal(report.coverage.ambiguousCalls, 1);
  b.id = "different";
  report = rollup([session("one", [a]), session("two", [b])]);
  assert.equal(report.coverage.duplicateResponses, 1);
  assert.equal(report.totals.savedUsd, null);
  const c = audit("c"), d = audit("d");
  delete c.attempts[0]!.responseId; delete d.attempts[0]!.responseId;
  report = rollup([session("one", [c]), session("two", [d])]);
  assert.equal(report.coverage.ambiguousCalls, 2);
  assert.equal(report.totals.savedUsd, null);
});

test("pending copies cannot erase completion; failed/unverified/unmanaged calls contribute no savings", () => {
  const completed = audit("complete"), pending = structuredClone(completed);
  pending.outcome = "pending"; delete pending.usage;
  const failed = audit("failed"); failed.outcome = "error";
  const unknown = audit("unknown"); unknown.attempts[0]!.responseTier = "unknown";
  const unmanaged = audit("codex"); unmanaged.model.provider = "openai-codex";
  const report = rollup([session("first", [completed]), session("later", [pending, failed, unknown, unmanaged])]);
  assert.equal(report.totals.savedUsd, 3);
  assert.deepEqual(report.totals.exclusions, { incomplete: 1, unverified: 1, unmanaged: 1 });
  assert.doesNotMatch(formatAllSavings(report), /Last AI call/);
});

test("scanner is read-only, reads every branch, strips private text, and tolerates damaged tails", async t => {
  const dir = await fixture(t), project = join(dir, "project"); await mkdir(project);
  const file = join(project, "session.jsonl");
  const a = audit("a"), b = audit("abandoned-branch");
  const s = session("session", [a, b]);
  s.entries.push(message(a), { type: "message", message: { role: "user", content: "private prompt" } });
  await save(file, s, '{"type":"message"');
  const before = await readFile(file), beforeStat = await stat(file);
  const scan = await scanSavingsSessions([dir, project]);
  assert.equal(scan.filesRead, 1);
  assert.equal(scan.sessions.length, 1);
  assert.equal(rollupSavings(scan).totals.savedUsd, 6);
  assert.ok(scan.warnings.some(w => w.reason === "unterminated tail deferred"));
  assert.doesNotMatch(JSON.stringify(scan), /private prompt|private generated|private error/);
  assert.deepEqual(await readFile(file), before);
  assert.equal((await stat(file)).mtimeMs, beforeStat.mtimeMs);
});

test("oversized/corrupt records do not prevent later audits; symlinks skipped and hard links deduplicated", async t => {
  const dir = await fixture(t), file = join(dir, "a.jsonl");
  await save(file, session("session", []));
  const header = await readFile(file, "utf8");
  await writeFile(file, header + "x".repeat(MAX_SESSION_LINE_BYTES + 1) + "\nnot json\n" + JSON.stringify(ae(audit("valid"))) + "\n");
  await symlink(file, join(dir, "b.jsonl"));
  await link(file, join(dir, "c.jsonl"));
  const report = await allSavingsReport([dir]);
  assert.equal(report.totals.savedUsd, 3);
  assert.equal(report.coverage.duplicateFiles, 1);
  assert.ok(report.coverage.warnings.some(w => w.reason.includes("oversized")));
  assert.ok(report.coverage.warnings.some(w => w.reason.includes("malformed")));
  assert.ok(report.coverage.warnings.some(w => w.reason.includes("symlink")));
});

test("live session replaces stale on-disk view without double count and ephemeral sessions work", async t => {
  const dir = await fixture(t), file = join(dir, "session.jsonl");
  const a = audit("same"), pending = { ...a, outcome: "pending" as const };
  await save(file, session("session", [pending]));
  const live = { ...session("session", [a]), path: file };
  const report = await allSavingsReport([dir], live);
  assert.equal(report.totals.savedUsd, 3);
  assert.equal(report.coverage.sessions, 1);
  const ephemeral = await allSavingsReport([join(dir, "missing")], session("ephemeral", [a]));
  assert.equal(ephemeral.totals.savedUsd, 3);
  assert.equal(ephemeral.coverage.filesRead, 0);
});

test("empty/unaudited histories stay unknown, and UTC breakdown dates use call start", async t => {
  const dir = await fixture(t);
  const empty = await allSavingsReport([dir]);
  assert.equal(empty.totals.savedUsd, null);
  const unaudited = session("pre-flexy", []); unaudited.entries.push(message(audit("not-audited")));
  const old = audit("midnight"); old.startedAt = "2026-09-08T23:59:59.000Z";
  const report = rollup([unaudited, session("new", [old])]);
  assert.equal(report.coverage.sessionsWithoutAudits, 1);
  assert.equal(report.coverage.unmatchedAssistantEntries, 1);
  assert.equal(report.byDay[0]?.day, "2026-09-08");
});

test("response IDs deduplicate across reported model names; mismatches are excluded", () => {
  const a = audit("a"), b = audit("b");
  b.attempts[0]!.responseId = a.attempts[0]!.responseId;
  b.model.id = "different-model";
  const report = rollup([session("one", [a]), session("two", [b])]);
  assert.equal(report.totals.calls, 1);
  assert.equal(report.totals.savedUsd, null);
  assert.equal(report.coverage.ambiguousCalls, 1);
});

test("reports span beyond 50 calls and weighted sums agree across breakdowns", () => {
  const calls = Array.from({ length: 80 }, (_, i) => {
    const a = audit(`call-${i}`, i % 2 ? "default" : "flex");
    a.startedAt = `2026-09-${String(i % 20 + 1).padStart(2, "0")}T10:00:00.000Z`;
    a.model.id = i % 3 ? "model-A" : "model-B";
    return a;
  });
  const report = rollup([session("one", calls.slice(0, 40)), session("two", calls.slice(40))]);
  assert.equal(report.totals.includedCalls, 80);
  assert.equal(report.totals.savedUsd, 120);
  for (const groups of [report.byDay, report.byModel, report.bySession]) {
    assert.equal(groups.reduce((sum, g) => sum + (g.totals.savedUsd ?? 0), 0), 120);
  }
  assert.match(formatAllSavings(report), /latest 10 UTC/);
  assert.equal(report.byDay.length, 20, "JSON keeps every date, not only visible top/latest rows");
});

test("overflowing global sums remain unknown, never Infinity or fabricated zero", () => {
  const calls = [audit("huge-1"), audit("huge-2")];
  for (const a of calls) {
    a.pricing = capturePricing({ input: 1e308, output: 0, cacheRead: 0, cacheWrite: 0 }, at);
    a.usage = decodeUsage({ input: 1e6, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 1e6,
      cost: { input: 5e307, output: 0, cacheRead: 0, cacheWrite: 0, total: 5e307 } });
  }
  const report = rollup([session("huge", calls)]);
  assert.equal(report.totals.includedCalls, 2);
  assert.equal(report.totals.standardUsd, null);
  assert.equal(report.totals.savedUsd, null);
  assert.doesNotMatch(formatAllSavings(report), /Infinity|NaN/);
});

test("valid legacy headers are read without migration; unrelated JSONL files are reported and ignored", async t => {
  const dir = await fixture(t), file = join(dir, "legacy.jsonl");
  const text = JSON.stringify({ type: "session", version: 1, id: "legacy", timestamp: at }) + "\n" +
    JSON.stringify(ae(audit("legacy"))) + "\n";
  await writeFile(file, text);
  await writeFile(join(dir, "unrelated.jsonl"), '{"type":"dataset","id":"not-a-session"}\n');
  const report = await allSavingsReport([dir]);
  assert.equal(report.totals.savedUsd, 3);
  assert.equal(report.coverage.sessions, 1);
  assert.ok(report.coverage.warnings.some(w => w.reason.includes("header")));
  assert.equal(await readFile(file, "utf8"), text);
});
