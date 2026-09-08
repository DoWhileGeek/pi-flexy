import { randomUUID } from "node:crypto";
import { decodePricing, decodeUsage, type PricingSnapshot, type UsageSnapshot } from "./pricing.ts";
import { DEFAULT_FLEX_RETRIES, parseFlexRetries, type FlexRetryTerminalReason } from "./retry.ts";

export const STATE_ENTRY = "flexy:state";
export const AUDIT_ENTRY = "flexy:audit";
export const HISTORY_LIMIT = 50;
export const ATTEMPT_LIMIT = 20;
export type Mode = "on" | "off";
export type Tier = "flex" | "default" | "auto" | "priority" | "scale" | "omitted" | "unknown";
export type Outcome = "pending" | "complete" | "error" | "aborted" | "interrupted";
export interface ModelIdentity { provider: string; id: string; api: string }
export interface Attempt {
  number: number;
  startedAt: string;
  origin?: string;
  sentTier: Tier;
  status?: number;
  requestId?: string;
  responseId?: string;
  responseTier?: Tier;
  terminalResponse?: boolean;
  networkError?: boolean;
  inspectionLimited?: boolean;
}
export interface FlexRetrySummary {
  limit: number;
  performed: number;
  terminalReason?: FlexRetryTerminalReason;
}
export interface Audit {
  version: 1;
  id: string;
  startedAt: string;
  finishedAt?: string;
  messageTimestamp?: number;
  model: ModelIdentity;
  mode: Mode | "unknown";
  coverage: "transport" | "payload-only" | "unobserved";
  payloadTier?: Tier;
  outcome: Outcome;
  attemptCount: number;
  attempts: Attempt[];
  flexRetry?: FlexRetrySummary;
  // Undefined is a pre-savings audit; null means pricing was unavailable for a new call.
  pricing?: PricingSnapshot | null;
  usage?: UsageSnapshot;
}
export interface Entry { type: string; customType?: string; data?: unknown; message?: unknown }

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
export function tierOf(payload: unknown): Tier {
  if (!isRecord(payload)) return "unknown";
  if (!("service_tier" in payload)) return "omitted";
  const value = payload.service_tier;
  return value === "flex" || value === "default" || value === "auto" || value === "priority" || value === "scale"
    ? value : "unknown";
}
function savedTier(value: unknown): Tier {
  return value === "omitted" || value === "unknown" ? value : tierOf({ service_tier: value });
}
function outcomeFor(stopReason: unknown): Outcome {
  return stopReason === "error" ? "error" : stopReason === "aborted" ? "aborted" : "complete";
}
export function managed(model: ModelIdentity | undefined): boolean {
  return model?.provider === "openai" && model.api === "openai-responses";
}
export function scopeReason(model: ModelIdentity | undefined): string {
  if (!model) return "No active model.";
  if (model.provider === "openai-codex") return "Codex subscription is not OpenAI API Flex; requests untouched.";
  if (!managed(model)) return "Only provider=openai, api=openai-responses is managed; requests untouched.";
  return "OpenAI Responses API. Model availability is validated by OpenAI; no standard-tier fallback.";
}
export function identity(model: ModelIdentity): ModelIdentity {
  return { provider: model.provider, id: model.id, api: model.api };
}
export function safeId(value: unknown): string | undefined {
  return typeof value === "string" && /^[\w.:/-]{1,200}$/.test(value) ? value : undefined;
}
export function safeOrigin(value: string): string | undefined {
  try { return new URL(value).origin; } catch { return undefined; }
}

// Session data is untrusted. Reconstruct only the documented, bounded metadata fields.
export function decodeAudit(data: unknown): Audit | undefined {
  if (!isRecord(data) || data.version !== 1 || !safeId(data.id) || typeof data.startedAt !== "string" ||
      !Number.isFinite(Date.parse(data.startedAt)) || !isRecord(data.model) ||
      ![data.model.provider, data.model.id, data.model.api].every(v => typeof v === "string" && v.length <= 200) ||
      (data.mode !== "on" && data.mode !== "off" && data.mode !== "unknown") ||
      !["transport", "payload-only", "unobserved"].includes(String(data.coverage)) ||
      !["pending", "complete", "error", "aborted", "interrupted"].includes(String(data.outcome)) ||
      !Array.isArray(data.attempts) || typeof data.attemptCount !== "number" ||
      !Number.isSafeInteger(data.attemptCount) || data.attemptCount < 0) return undefined;
  const attempts: Attempt[] = [];
  for (const raw of data.attempts.slice(-ATTEMPT_LIMIT)) {
    if (!isRecord(raw) || typeof raw.number !== "number" || !Number.isSafeInteger(raw.number) || raw.number < 1 ||
        typeof raw.startedAt !== "string" || !Number.isFinite(Date.parse(raw.startedAt))) return undefined;
    attempts.push({
      number: raw.number, startedAt: raw.startedAt, sentTier: savedTier(raw.sentTier),
      origin: typeof raw.origin === "string" ? safeOrigin(raw.origin) : undefined,
      status: typeof raw.status === "number" && Number.isInteger(raw.status) && raw.status >= 100 && raw.status <= 599 ? raw.status : undefined,
      requestId: safeId(raw.requestId), responseId: safeId(raw.responseId),
      responseTier: raw.responseTier === undefined ? undefined : savedTier(raw.responseTier),
      terminalResponse: raw.terminalResponse === true,
      networkError: raw.networkError === true,
      inspectionLimited: raw.inspectionLimited === true,
    });
  }
  let flexRetry: FlexRetrySummary | undefined;
  if (isRecord(data.flexRetry)) {
    const limit = parseFlexRetries(data.flexRetry.limit);
    const performed = parseFlexRetries(data.flexRetry.performed);
    const terminalReason = ["success", "budget-exhausted", "partial-output", "pass-through", "aborted", "internal-error"]
      .includes(String(data.flexRetry.terminalReason)) ? data.flexRetry.terminalReason as FlexRetryTerminalReason : undefined;
    if (limit !== undefined && performed !== undefined && performed <= limit) flexRetry = { limit, performed, terminalReason };
  }
  return {
    version: 1, id: data.id as string, startedAt: data.startedAt,
    finishedAt: typeof data.finishedAt === "string" && Number.isFinite(Date.parse(data.finishedAt)) ? data.finishedAt : undefined,
    messageTimestamp: typeof data.messageTimestamp === "number" && Number.isFinite(data.messageTimestamp) ? data.messageTimestamp : undefined,
    model: identity(data.model as unknown as ModelIdentity), mode: data.mode,
    coverage: data.coverage as Audit["coverage"], outcome: data.outcome as Outcome,
    payloadTier: data.payloadTier === undefined ? undefined : savedTier(data.payloadTier),
    attemptCount: data.attemptCount, attempts, flexRetry,
    pricing: data.pricing === undefined ? undefined : decodePricing(data.pricing) ?? null,
    usage: decodeUsage(data.usage),
  };
}

export class AuditStore {
  mode: Mode = "off";
  retries = DEFAULT_FLEX_RETRIES;
  records: Audit[] = [];
  constructor(private readonly save: (type: string, data: unknown) => void) {}
  get last(): Audit | undefined { return this.records.at(-1); }
  contains(audit: Audit): boolean { return this.records.includes(audit); }
  persist(audit: Audit): void {
    if (this.contains(audit)) this.save(AUDIT_ENTRY, structuredClone(audit));
  }
  private saveState(): void {
    this.save(STATE_ENTRY, { version: 1, mode: this.mode, retries: this.retries });
  }
  setMode(mode: Mode): void {
    this.mode = mode;
    this.saveState();
  }
  setRetries(retries: number): void {
    const parsed = parseFlexRetries(retries);
    if (parsed === undefined) throw new Error(`Flex retries must be an integer from 0 to 10: ${String(retries)}`);
    this.retries = parsed;
    this.saveState();
  }
  begin(model: ModelIdentity, coverage: Audit["coverage"], timestamp = Date.now()): Audit {
    const audit: Audit = {
      version: 1, id: randomUUID(), startedAt: new Date(timestamp).toISOString(),
      model: identity(model), mode: this.mode, coverage, outcome: "pending", attemptCount: 0, attempts: [],
    };
    this.records.push(audit);
    this.records = this.records.slice(-HISTORY_LIMIT);
    this.persist(audit);
    return audit;
  }
  finish(audit: Audit, message: { stopReason: string; timestamp: number; usage?: unknown }): void {
    if (!this.contains(audit)) return; // Ignore a callback from a replaced session/branch/runtime.
    audit.outcome = outcomeFor(message.stopReason);
    audit.finishedAt = new Date().toISOString();
    audit.messageTimestamp = message.timestamp;
    audit.usage = decodeUsage(message.usage);
    this.persist(audit);
  }
  restore(entries: readonly Entry[]): void {
    this.mode = "off";
    this.retries = DEFAULT_FLEX_RETRIES;
    const records = new Map<string, Audit>();
    let lastAssistant: Record<string, unknown> | undefined;
    for (const entry of entries) {
      if (entry.type === "custom" && entry.customType === STATE_ENTRY && isRecord(entry.data) && entry.data.version === 1) {
        if (entry.data.mode === "on" || entry.data.mode === "off") this.mode = entry.data.mode;
        const retries = parseFlexRetries(entry.data.retries);
        if (retries !== undefined) this.retries = retries;
      }
      if (entry.type === "custom" && entry.customType === AUDIT_ENTRY) {
        const audit = decodeAudit(entry.data);
        if (audit) records.set(audit.id, audit);
        if (records.size > HISTORY_LIMIT) records.delete(records.keys().next().value!);
      }
      if (entry.type === "message" && isRecord(entry.message) && entry.message.role === "assistant") lastAssistant = entry.message;
    }
    this.records = [...records.values()];
    for (const audit of this.records) if (audit.outcome === "pending") audit.outcome = "interrupted";
    // Never answer an audit about an older recorded call when a newer unobserved assistant exists.
    if (lastAssistant && typeof lastAssistant.timestamp === "number" && Number.isFinite(new Date(lastAssistant.timestamp).getTime()) &&
        typeof lastAssistant.provider === "string" && typeof lastAssistant.model === "string" && typeof lastAssistant.api === "string" &&
        !this.records.some(a => a.messageTimestamp === lastAssistant.timestamp && a.model.provider === lastAssistant.provider && a.model.id === lastAssistant.model) &&
        (!this.last || lastAssistant.timestamp >= Date.parse(this.last.startedAt))) {
      this.records.push({
        version: 1, id: randomUUID(), startedAt: new Date(lastAssistant.timestamp).toISOString(),
        messageTimestamp: lastAssistant.timestamp,
        model: { provider: lastAssistant.provider, id: lastAssistant.model, api: lastAssistant.api },
        mode: "unknown", coverage: "unobserved", outcome: outcomeFor(lastAssistant.stopReason), attemptCount: 0, attempts: [],
      });
      this.records = this.records.slice(-HISTORY_LIMIT);
    }
  }
}

export function verdict(audit: Audit): { sentAsFlex: string; servedAsFlex: string; mismatch: boolean } {
  const tiers = audit.attempts.map(a => a.sentTier);
  const unknown = !tiers.length || tiers.includes("unknown") || audit.attemptCount > tiers.length;
  const sentAsFlex = unknown ? "UNKNOWN" : tiers.every(t => t === "flex") ? "YES" : tiers.every(t => t !== "flex") ? "NO" : "MIXED";
  const last = audit.attempts.at(-1);
  const confirmed = audit.outcome === "complete" && last?.terminalResponse && last.status !== undefined && last.status >= 200 && last.status < 300;
  const servedAsFlex = confirmed && last.responseTier === "flex" ? "YES"
    : confirmed && ["default", "priority", "scale"].includes(last.responseTier ?? "") ? "NO" : "UNKNOWN";
  const expected = audit.mode === "on" ? "flex" : "default";
  const mismatch = audit.mode !== "unknown" && managed(audit.model) && (tiers.some(t => t !== "unknown" && t !== expected) ||
    (confirmed === true && last?.responseTier !== undefined && last.responseTier !== "unknown" && last.responseTier !== expected));
  return { sentAsFlex, servedAsFlex, mismatch };
}

export function formatAudit(audit: Audit | undefined): string {
  if (!audit) return "Flex audit: no AI call observed in this session branch yet. Send a prompt, then /flex audit.";
  const result = verdict(audit);
  const lines = [
    `Flex audit — ${audit.id}`,
    `${audit.model.provider}/${audit.model.id} (${audit.model.api})`,
    `Started: ${audit.startedAt} | outcome: ${audit.outcome}`,
    `Mode at call: ${audit.mode} | coverage: ${audit.coverage}`,
    `Payload hook tier: ${audit.payloadTier ?? "not observed"}`,
    `Sent as Flex: ${result.sentAsFlex} (serialized body handed to HTTP transport)`,
    `Served as Flex: ${result.servedAsFlex} (successful terminal response service_tier)`,
  ];
  if (!managed(audit.model)) lines.push(scopeReason(audit.model));
  if (audit.coverage === "payload-only") lines.push("Hook-only evidence: later payload handlers may have changed this tier; no transport proof.");
  if (result.mismatch) lines.push("MISMATCH: observed tier differs from selected mode. Check other provider/payload extensions.");
  if (audit.flexRetry) {
    const terminal = audit.flexRetry.terminalReason ? ` | terminal: ${audit.flexRetry.terminalReason}` : "";
    lines.push(`Flex stream retries: ${audit.flexRetry.performed}/${audit.flexRetry.limit}${terminal}`);
  }
  for (const attempt of audit.attempts) {
    lines.push(`Attempt ${attempt.number}: sent=${attempt.sentTier}, HTTP=${attempt.status ?? "not received"}, response=${attempt.responseTier ?? "not reported"}${attempt.networkError ? ", transport error" : ""}`);
    if (attempt.origin) lines.push(`  Origin: ${attempt.origin}`);
    if (attempt.requestId) lines.push(`  Request ID: ${attempt.requestId}`);
    if (attempt.responseId) lines.push(`  Response ID: ${attempt.responseId}`);
    if (attempt.inspectionLimited) lines.push("  Response inspection limit reached; some evidence unavailable.");
  }
  if (audit.attemptCount > audit.attempts.length) lines.push(`Showing last ${audit.attempts.length} of ${audit.attemptCount} transport attempts.`);
  if (result.servedAsFlex === "UNKNOWN") lines.push("Missing evidence is not proof of standard processing. Payload intent alone is not proof of delivery or Flex service.");
  lines.push("Local transport evidence, not a billing receipt. Proxies can rewrite requests after this boundary.");
  return lines.join("\n");
}
