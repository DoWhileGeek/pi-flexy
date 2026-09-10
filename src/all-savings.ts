import { type Audit, safeId } from "./audit.ts";
import { estimateSavings, resolveSavingsAudits, type CallSavings, type EstimatedSavings, type Exclusion } from "./savings.ts";
import { scanSavingsSessions, type SavingsSession, type SessionScan } from "./session-scan.ts";

export interface SavingsTotals {
  calls: number;
  includedCalls: number;
  flexCalls: number;
  standardCalls: number;
  historicalCalls: number;
  excludedCalls: number;
  exclusions: Partial<Record<Exclusion, number>>;
  standardUsd: number | null;
  piUsd: number | null;
  savedUsd: number | null;
  savedPercent: number | null;
}
export interface AllSavingsReport {
  version: 1;
  currency: "USD";
  scope: "all-local-sessions-all-branches";
  basis: "completed-responses-only";
  generatedAt: string;
  roots: string[];
  totals: SavingsTotals;
  coverage: {
    filesRead: number;
    sessions: number;
    sessionsWithoutAudits: number;
    duplicateFiles: number;
    duplicateAuditCopies: number;
    duplicateResponses: number;
    ambiguousCalls: number;
    unmatchedAssistantEntries: number;
    warnings: SessionScan["warnings"];
  };
  bySession: Array<{ id: string; path?: string; totals: SavingsTotals }>;
  byModel: Array<{ provider: string; model: string; api: string; totals: SavingsTotals }>;
  byDay: Array<{ day: string; totals: SavingsTotals }>;
}
interface Candidate { audit: Audit; session: SavingsSession; conflict?: boolean }

function summarize(calls: readonly CallSavings[]): SavingsTotals {
  const included = calls.filter((c): c is EstimatedSavings => c.status === "estimated");
  const exclusions: Partial<Record<Exclusion, number>> = {};
  for (const call of calls) if (call.status === "unavailable") exclusions[call.reason] = (exclusions[call.reason] ?? 0) + 1;
  const standard = included.reduce((sum, c) => sum + c.standardCost.total, 0);
  const pi = included.reduce((sum, c) => sum + c.piCost.total, 0);
  const saved = included.reduce((sum, c) => sum + c.savedUsd, 0);
  const available = included.length > 0 && [standard, pi, saved].every(Number.isFinite);
  return {
    calls: calls.length, includedCalls: included.length,
    flexCalls: included.filter(c => c.servedTier === "flex").length,
    standardCalls: included.filter(c => c.servedTier === "default").length,
    historicalCalls: included.filter(c => c.source === "saved-pi-cost").length,
    excludedCalls: calls.length - included.length, exclusions,
    standardUsd: available ? standard : null, piUsd: available ? pi : null,
    savedUsd: available ? saved : null, savedPercent: available && standard > 0 ? Number((saved / standard * 100).toFixed(6)) : null,
  };
}
function sessionKey(session: SavingsSession): string { return JSON.stringify([session.id, session.path]); }
function sessionOrder(a: SavingsSession, b: SavingsSession): number {
  return (a.createdAt ?? "~").localeCompare(b.createdAt ?? "~") || sessionKey(a).localeCompare(sessionKey(b));
}
function terminal(a: Audit): boolean { return a.outcome !== "pending" && a.outcome !== "interrupted"; }
function completed(a: Audit): boolean { return a.outcome === "complete"; }
function modelKey(a: Audit): string { return JSON.stringify([a.model.provider, a.model.api, a.model.id]); }
function responseKey(a: Audit): string | undefined {
  const responseId = safeId(a.attempts.at(-1)?.responseId);
  return responseId && completed(a) ? JSON.stringify([a.model.provider, a.model.api, responseId]) : undefined;
}
function messageKey(a: Audit): string | undefined {
  return a.messageTimestamp !== undefined && completed(a) ? JSON.stringify([modelKey(a), a.messageTimestamp]) : undefined;
}
function richness(a: Audit): number {
  return (terminal(a) ? 100 : 0) + (a.outcome === "complete" ? 20 : 0) +
    (estimateSavings(a).status === "estimated" ? 10 : 0) + (a.pricing ? 2 : 0) + (a.usage ? 1 : 0);
}
/** Missing old metadata can be enriched; contradictory completed evidence cannot. */
function compatible(a: Audit, b: Audit, sameResponse = false): boolean {
  if (modelKey(a) !== modelKey(b)) return false;
  if (!terminal(a) || !terminal(b)) return true;
  if (a.outcome !== b.outcome) return false;
  if (!sameResponse && a.startedAt !== b.startedAt) return false;
  const pairs: Array<[unknown, unknown]> = [
    [a.attempts.at(-1)?.responseTier, b.attempts.at(-1)?.responseTier],
    [responseKey(a), responseKey(b)], [a.usage, b.usage], [a.pricing?.rates, b.pricing?.rates],
  ];
  return pairs.every(([x, y]) => x == null || y == null || JSON.stringify(x) === JSON.stringify(y));
}

/** Deterministic, conservative accounting: never sum per-session totals containing copied calls. */
export function rollupSavings(scan: SessionScan): AllSavingsReport {
  const byAudit = new Map<string, Candidate>();
  let duplicateAuditCopies = 0, duplicateResponses = 0, unmatchedAssistantEntries = 0, sessionsWithoutAudits = 0;
  const sessions = [...scan.sessions].sort(sessionOrder);
  for (const session of sessions) {
    const resolved = resolveSavingsAudits(session.entries, session.liveRecords);
    unmatchedAssistantEntries += resolved.unmatchedAssistantMessages;
    if (!resolved.audits.length) sessionsWithoutAudits++;
    for (const audit of resolved.audits) {
      const existing = byAudit.get(audit.id);
      if (!existing) { byAudit.set(audit.id, { audit, session }); continue; }
      duplicateAuditCopies++;
      if (!compatible(existing.audit, audit)) existing.conflict = true;
      if (richness(audit) > richness(existing.audit)) existing.audit = audit;
      // Ownership stays with the earliest retained session, not every copied fork.
    }
  }
  const byResponse = new Map<string, Candidate>();
  const unique: Candidate[] = [];
  for (const candidate of byAudit.values()) {
    const key = responseKey(candidate.audit);
    const existing = key ? byResponse.get(key) : undefined;
    if (!existing) {
      unique.push(candidate);
      if (key) byResponse.set(key, candidate);
    } else {
      duplicateResponses++;
      if (candidate.conflict || !compatible(existing.audit, candidate.audit, true)) existing.conflict = true;
      if (richness(candidate.audit) > richness(existing.audit)) existing.audit = candidate.audit;
      if (sessionOrder(candidate.session, existing.session) < 0) existing.session = candidate.session;
    }
  }
  // Different audit IDs with only the same timestamp are ambiguous, not proof of
  // either duplication or two paid calls. Exclude rather than inflate totals.
  const messages = new Map<string, Candidate[]>();
  for (const candidate of unique) {
    const key = messageKey(candidate.audit);
    if (key) { const list = messages.get(key) ?? []; list.push(candidate); messages.set(key, list); }
  }
  for (const list of messages.values()) if (list.length > 1 && list.some(c => !responseKey(c.audit))) {
    for (const candidate of list) candidate.conflict = true;
  }
  const rows = unique.map(candidate => ({ ...candidate, result: candidate.conflict
    ? { id: candidate.audit.id, model: candidate.audit.model, status: "unavailable", reason: "conflict" } as CallSavings
    : estimateSavings(candidate.audit) }));
  const byModel = new Map<string, { model: Audit["model"]; calls: CallSavings[] }>();
  const byDay = new Map<string, CallSavings[]>();
  const bySession = new Map<string, CallSavings[]>();
  for (const { audit, session, result } of rows) {
    const key = modelKey(audit), group = byModel.get(key) ?? { model: audit.model, calls: [] };
    group.calls.push(result); byModel.set(key, group);
    // Usage attributed to call start date, always UTC; no local timezone ambiguity.
    const day = new Date(audit.startedAt).toISOString().slice(0, 10);
    const daily = byDay.get(day) ?? []; daily.push(result); byDay.set(day, daily);
    const owned = bySession.get(sessionKey(session)) ?? []; owned.push(result); bySession.set(sessionKey(session), owned);
  }
  return {
    version: 1, currency: "USD", scope: "all-local-sessions-all-branches", basis: "completed-responses-only",
    generatedAt: new Date().toISOString(), roots: scan.roots, totals: summarize(rows.map(r => r.result)),
    coverage: { filesRead: scan.filesRead, sessions: sessions.length, sessionsWithoutAudits,
      duplicateFiles: scan.duplicateFiles, duplicateAuditCopies, duplicateResponses,
      ambiguousCalls: rows.filter(r => r.conflict).length, unmatchedAssistantEntries, warnings: scan.warnings },
    bySession: sessions.map(s => ({ id: s.id, path: s.path, totals: summarize(bySession.get(sessionKey(s)) ?? []) })),
    byModel: [...byModel.values()].map(g => ({ provider: g.model.provider, model: g.model.id, api: g.model.api, totals: summarize(g.calls) })),
    byDay: [...byDay].sort(([a], [b]) => a.localeCompare(b)).map(([day, calls]) => ({ day, totals: summarize(calls) })),
  };
}

export async function allSavingsReport(roots: readonly string[], current?: SavingsSession): Promise<AllSavingsReport> {
  return rollupSavings(await scanSavingsSessions(roots, current));
}
const money = (value: number | null): string => value === null ? "unknown" : `$${value.toFixed(6)}`;
const label = (value: string): string => value.replace(/[\u0000-\u001f\u007f-\u009f]/g, "?");
export function formatAllSavings(report: AllSavingsReport): string {
  const t = report.totals, c = report.coverage;
  const lines = ["Flex savings — all local sessions, all branches (USD estimates)",
    `Standard, same token/cache usage: ${money(t.standardUsd)}`,
    `Pi estimate (already tier-adjusted): ${money(t.piUsd)}`,
    `Estimated saved: ${money(t.savedUsd)}${t.savedPercent === null ? "" : ` (${t.savedPercent.toFixed(1)}%)`}`,
    `Coverage: ${c.sessions} sessions; ${t.includedCalls} priced completed calls (${t.flexCalls} Flex, ${t.standardCalls} standard); ${t.excludedCalls} excluded.`,
    `Historical estimates from saved Pi costs: ${t.historicalCalls}.`,
    `Deduplicated: ${c.duplicateAuditCopies} audit copies, ${c.duplicateResponses} response copies, ${c.duplicateFiles} duplicate files.`,
    `Unverified: ${c.sessionsWithoutAudits} sessions without audits; ${c.unmatchedAssistantEntries} unmatched assistant entries (includes copied history).`,
  ];
  for (const [reason, count] of Object.entries(t.exclusions)) lines.push(`  Excluded ${count}: ${reason}${reason === "conflict" ? " (ambiguous identity or contradictory pricing/evidence)" : ""}.`);
  lines.push("By model:");
  for (const g of report.byModel) {
    const percent = g.totals.savedPercent === null ? "percentage unknown" : `${g.totals.savedPercent.toFixed(1)}%`;
    lines.push(`  ${label(g.provider)}/${label(g.model)}: ${money(g.totals.savedUsd)} saved (${percent}; ${g.totals.includedCalls} priced calls)`);
  }
  lines.push("By session — top 10 by savings (each call belongs to earliest retained session copy):");
  for (const g of [...report.bySession].sort((a, b) => (b.totals.savedUsd ?? 0) - (a.totals.savedUsd ?? 0)).slice(0, 10)) {
    lines.push(`  ${label(g.id)}: ${money(g.totals.savedUsd)} saved (${g.totals.includedCalls} priced calls)`);
  }
  lines.push("By day — latest 10 UTC call-start dates:");
  for (const g of report.byDay.slice(-10)) lines.push(`  ${g.day}: ${money(g.totals.savedUsd)} saved (${g.totals.includedCalls} priced calls)`);
  if (c.warnings.length) {
    lines.push(`Scan incomplete: ${c.warnings.reduce((n, w) => n + w.count, 0)} warning(s).`);
    for (const w of c.warnings.slice(0, 5)) lines.push(`  ${w.reason} (${w.count}): ${JSON.stringify(w.path)}`);
  }
  lines.push("Roots: " + report.roots.map(p => JSON.stringify(p)).join(", "));
  lines.push("Use /flex savings all json for every group and scan warning.");
  lines.push("Read-only snapshot; active sessions can change during scan. Missing/deleted histories and unknown calls are not zero cost.");
  lines.push("Estimates, not billing. Completed responses only; failed-attempt charges, tool/summary fees, taxes, and account adjustments excluded.");
  return lines.join("\n");
}
