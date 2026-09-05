import { AUDIT_ENTRY, type Audit, decodeAudit, type Entry, isRecord, managed, verdict } from "./audit.ts";
import { type Cost, costsMatch, decodeUsage, scaleCost, standardCost, type UsageSnapshot } from "./pricing.ts";

// Pi 0.84's native OpenAI Responses adapter applies this to returned Flex tiers.
// Do not apply it to usage.cost again: that estimate is already tier-adjusted.
export const FLEX_MULTIPLIER = 0.5;
const EXCLUSIONS = {
  unmanaged: "provider/API outside Flexy scope",
  incomplete: "pending, interrupted, failed, or aborted call",
  unverified: "no confirmed Flex/default terminal response",
  usage: "missing or invalid usage/cost metadata",
  pricing: "missing or zero-priced model rates",
  conflict: "saved Pi cost disagrees with snapshotted rates/tier",
} as const;
export type Exclusion = keyof typeof EXCLUSIONS;
interface CallIdentity { id: string; model: Audit["model"] }
export interface EstimatedSavings extends CallIdentity {
  status: "estimated";
  servedTier: "flex" | "default";
  source: "request-time-prices" | "saved-pi-cost";
  pricingCapturedAt?: string;
  usage: UsageSnapshot;
  standardCost: Cost;
  piCost: Cost;
  savedUsd: number;
  savedPercent: number;
  attemptCount: number;
}
export interface UnavailableSavings extends CallIdentity {
  status: "unavailable";
  reason: Exclusion;
}
export type CallSavings = EstimatedSavings | UnavailableSavings;
export interface SavingsReport {
  version: 1;
  currency: "USD";
  basis: "completed-responses-only";
  lastCall: CallSavings | null;
  session: {
    scope: "current-session-branch";
    auditedCalls: number;
    includedCalls: number;
    flexCalls: number;
    standardCalls: number;
    historicalCalls: number;
    unmatchedAssistantMessages: number;
    excludedCalls: number;
    exclusions: Partial<Record<Exclusion, number>>;
    standardUsd: number | null;
    piUsd: number | null;
    savedUsd: number | null;
    savedPercent: number | null;
  };
}

function percentage(saved: number, standard: number): number {
  return Number((saved / standard * 100).toFixed(6));
}

export function estimateSavings(audit: Audit): CallSavings {
  const identity = { id: audit.id, model: { ...audit.model } };
  const unavailable = (reason: Exclusion): UnavailableSavings => ({ ...identity, status: "unavailable", reason });
  if (!managed(audit.model)) return unavailable("unmanaged");
  if (audit.outcome !== "complete") return unavailable("incomplete");
  const tier = audit.attempts.at(-1)?.responseTier;
  if (audit.coverage !== "transport" || verdict(audit).servedAsFlex === "UNKNOWN" || (tier !== "flex" && tier !== "default")) return unavailable("unverified");
  const usage = decodeUsage(audit.usage);
  if (!usage || usage.totalTokens === 0) return unavailable("usage");
  if (usage.cost.total === 0 || audit.pricing === null) return unavailable("pricing");

  const multiplier = tier === "flex" ? FLEX_MULTIPLIER : 1;
  // New calls use frozen standard prices. For old audits, reconstruct a baseline
  // from the matched saved Pi estimate; never substitute today's model prices.
  const baseline = audit.pricing
    ? standardCost(audit.pricing.rates, usage)
    : scaleCost(usage.cost, 1 / multiplier);
  if (!baseline || !Number.isFinite(baseline.total) || baseline.total <= 0) return unavailable("pricing");
  if (!costsMatch(usage.cost, scaleCost(baseline, multiplier))) return unavailable("conflict");
  const savedUsd = tier === "default" ? 0 : Math.max(0, baseline.total - usage.cost.total);
  return {
    ...identity, status: "estimated", servedTier: tier,
    source: audit.pricing ? "request-time-prices" : "saved-pi-cost",
    pricingCapturedAt: audit.pricing?.capturedAt, usage,
    standardCost: baseline, piCost: { ...usage.cost }, savedUsd,
    savedPercent: percentage(savedUsd, baseline.total),
    attemptCount: audit.attemptCount,
  };
}

function messageKey(provider: unknown, api: unknown, model: unknown, timestamp: unknown): string | undefined {
  if (![provider, api, model].every(v => typeof v === "string") || typeof timestamp !== "number" || !Number.isFinite(timestamp)) return undefined;
  return JSON.stringify([provider, api, model, timestamp]);
}

/** Reconstruct all branch audits (not just the 50-call UI window). Read-only. */
export function savingsReport(entries: readonly Entry[], liveRecords: readonly Audit[] = []): SavingsReport {
  const audits = new Map<string, Audit>();
  const messages = new Map<string, Array<{ index: number; responseId: unknown; usage?: UsageSnapshot }>>();
  let assistantMessages = 0;
  for (const entry of entries) {
    if (entry.type === "custom" && entry.customType === AUDIT_ENTRY) {
      const audit = decodeAudit(entry.data);
      if (audit) audits.set(audit.id, audit);
    }
    if (entry.type === "message" && isRecord(entry.message) && entry.message.role === "assistant") {
      const message = entry.message;
      const index = assistantMessages++;
      const key = messageKey(message.provider, message.api, message.model, message.timestamp);
      if (!key) continue;
      const list = messages.get(key) ?? [];
      list.push({ index, responseId: message.responseId, usage: decodeUsage(message.usage) });
      messages.set(key, list);
    }
  }
  for (const audit of liveRecords) {
    const decoded = decodeAudit(audit);
    if (decoded) audits.set(decoded.id, decoded);
  }
  const matched = new Set<number>();
  for (const audit of audits.values()) {
    const key = messageKey(audit.model.provider, audit.model.api, audit.model.id, audit.messageTimestamp);
    const responseId = audit.attempts.at(-1)?.responseId;
    const candidates = key ? (messages.get(key) ?? []).filter(m => responseId === undefined || m.responseId === responseId) : [];
    // Ambiguous identity is missing evidence, not permission to borrow another call's cost.
    if (candidates.length !== 1) continue;
    const candidate = candidates[0]!;
    if (matched.has(candidate.index)) {
      audit.usage = undefined; // Duplicate audit IDs must not count one response twice.
      continue;
    }
    matched.add(candidate.index);
    if (!audit.usage && audit.pricing === undefined) audit.usage = candidate.usage;
  }
  const results = [...audits.values()].map(estimateSavings);
  const included = results.filter((result): result is EstimatedSavings => result.status === "estimated");
  const exclusions: SavingsReport["session"]["exclusions"] = {};
  for (const result of results) {
    if (result.status === "unavailable") exclusions[result.reason] = (exclusions[result.reason] ?? 0) + 1;
  }
  const standardUsd = included.reduce((sum, call) => sum + call.standardCost.total, 0);
  const piUsd = included.reduce((sum, call) => sum + call.piCost.total, 0);
  const savedUsd = included.reduce((sum, call) => sum + call.savedUsd, 0);
  const totalsAvailable = included.length > 0 && [standardUsd, piUsd, savedUsd].every(Number.isFinite);
  const lastId = liveRecords.at(-1)?.id ?? [...audits.keys()].at(-1);
  return {
    version: 1, currency: "USD", basis: "completed-responses-only",
    lastCall: results.find(call => call.id === lastId) ?? null,
    session: {
      scope: "current-session-branch", auditedCalls: results.length,
      includedCalls: included.length,
      flexCalls: included.filter(call => call.servedTier === "flex").length,
      standardCalls: included.filter(call => call.servedTier === "default").length,
      historicalCalls: included.filter(call => call.source === "saved-pi-cost").length,
      unmatchedAssistantMessages: assistantMessages - matched.size,
      excludedCalls: results.length - included.length, exclusions,
      standardUsd: totalsAvailable ? standardUsd : null,
      piUsd: totalsAvailable ? piUsd : null,
      savedUsd: totalsAvailable ? savedUsd : null,
      savedPercent: totalsAvailable && standardUsd > 0 ? percentage(savedUsd, standardUsd) : null,
    },
  };
}

function dollars(value: number): string {
  return value > 0 && value < 0.000001 ? "<$0.000001" : `$${value.toFixed(6)}`;
}
function amounts(standard: number, pi: number, saved: number, percent: number): string[] {
  return [
    `  Standard, same token/cache usage: ${dollars(standard)}`,
    `  Pi estimate (already tier-adjusted): ${dollars(pi)}`,
    `  Estimated saved: ${dollars(saved)} (${percent.toFixed(1)}%)`,
  ];
}
export function formatSavings(report: SavingsReport): string {
  const lines = ["Flex savings — estimates (USD)"];
  const last = report.lastCall;
  if (!last) lines.push("Last AI call: none observed yet.");
  else {
    lines.push(`Last AI call: ${last.model.provider}/${last.model.id} (${last.id})`);
    if (last.status === "unavailable") lines.push(`  Estimate unavailable: ${EXCLUSIONS[last.reason]}.`);
    else {
      lines.push(`  Served tier: ${last.servedTier}`);
      lines.push(...amounts(last.standardCost.total, last.piCost.total, last.savedUsd, last.savedPercent));
      lines.push(`  Tokens: input ${last.usage.input.toLocaleString("en-US")}, cache read ${last.usage.cacheRead.toLocaleString("en-US")}, cache write ${last.usage.cacheWrite.toLocaleString("en-US")}, output ${last.usage.output.toLocaleString("en-US")}`);
      if (last.usage.reasoning) lines.push(`  Reasoning: ${last.usage.reasoning.toLocaleString("en-US")} tokens, already included in output.`);
      lines.push(last.source === "request-time-prices"
        ? `  Basis: Pi model prices snapshotted ${last.pricingCapturedAt}.`
        : "  Basis: matched saved Pi cost; standard baseline reconstructed using Pi's Flex multiplier.");
    }
  }
  const session = report.session;
  lines.push(`Session branch: ${session.includedCalls} priced completed responses (${session.flexCalls} Flex, ${session.standardCalls} standard)`);
  if (session.standardUsd !== null && session.piUsd !== null && session.savedUsd !== null && session.savedPercent !== null) {
    lines.push(...amounts(session.standardUsd, session.piUsd, session.savedUsd, session.savedPercent));
  } else lines.push(session.includedCalls
    ? "  Totals unavailable: numeric range exceeded."
    : "  No verified, priced completed responses available; totals unknown.");
  if (session.historicalCalls) lines.push(`  Historical estimates reconstructed from matched saved Pi costs: ${session.historicalCalls}.`);
  lines.push(`Coverage: ${session.auditedCalls} branch audits; ${session.excludedCalls} excluded; ${session.unmatchedAssistantMessages} unmatched assistant messages excluded.`);
  for (const [reason, count] of Object.entries(session.exclusions)) lines.push(`  ${count}: ${EXCLUSIONS[reason as Exclusion]}`);
  lines.push("All branch audits included, not just the 50-call history window. Excluded calls are unknown, not free.");
  lines.push("Estimates, not billing. Completed response tokens only; failed/retried attempt charges, tool fees, taxes, and account-specific adjustments are not included.");
  return lines.join("\n");
}
