import { Text } from "@earendil-works/pi-tui";
import type { EntryRenderer } from "@earendil-works/pi-coding-agent";
import { isRecord, safeId } from "./audit.ts";
import { FLEX_RETRY_MAX_DELAY_MS, MAX_FLEX_RETRIES } from "./retry.ts";

export const ACTIVITY_ENTRY = "flexy:activity";
interface ActivityBase { version: 1; at: string; auditId: string }
export type ActivityDetails =
  | { kind: "retry-scheduled"; retry: number; limit: number; delayMs: number }
  | { kind: "retry-started"; retry: number; limit: number }
  | { kind: "fallback-started"; flexAttempts: number };
export type Activity = ActivityBase & ActivityDetails;

/** Only bounded metadata renders from resumed sessions; never provider text or payloads. */
export function decodeActivity(data: unknown): Activity | undefined {
  if (!isRecord(data) || data.version !== 1 || typeof data.at !== "string" ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(data.at) || !Number.isFinite(Date.parse(data.at)) ||
      !safeId(data.auditId)) return undefined;
  const base: ActivityBase = { version: 1, at: data.at, auditId: data.auditId as string };
  if (data.kind === "fallback-started" && typeof data.flexAttempts === "number" &&
      Number.isSafeInteger(data.flexAttempts) && data.flexAttempts >= 1 && data.flexAttempts <= MAX_FLEX_RETRIES + 1) {
    return { ...base, kind: data.kind, flexAttempts: data.flexAttempts };
  }
  if (typeof data.retry !== "number" || typeof data.limit !== "number" || !Number.isSafeInteger(data.retry) ||
      !Number.isSafeInteger(data.limit) || data.retry < 1 || data.retry > data.limit || data.limit > MAX_FLEX_RETRIES) return undefined;
  const retry = { ...base, retry: data.retry, limit: data.limit };
  if (data.kind === "retry-started") return { ...retry, kind: data.kind };
  if (data.kind === "retry-scheduled" && typeof data.delayMs === "number" && Number.isFinite(data.delayMs) &&
      data.delayMs >= 0 && data.delayMs <= FLEX_RETRY_MAX_DELAY_MS) return { ...retry, kind: data.kind, delayMs: data.delayMs };
  return undefined;
}

export function formatActivity(activity: Activity): string {
  const prefix = `[${activity.at.replace("T", " ").replace("Z", " UTC")}] Flexy: `;
  switch (activity.kind) {
    case "retry-scheduled":
      return `${prefix}Flex request failed. Retry ${activity.retry}/${activity.limit} scheduled in ${activity.delayMs / 1000}s (still Flex pricing).`;
    case "retry-started":
      return `${prefix}Retrying failed request on Flex (${activity.retry}/${activity.limit}).`;
    case "fallback-started":
      return `${prefix}Falling back to non-Flex after ${activity.flexAttempts} failed Flex attempt(s).\nRequesting default tier at standard pricing for this call only. Session Flex mode unchanged.`;
  }
}

// Custom entries persist and render live via entry_appended, but never enter LLM context.
export const renderActivity: EntryRenderer<unknown> = (entry, options, theme) => {
  const activity = decodeActivity(entry.data);
  if (!activity) return undefined;
  const color = activity.kind === "fallback-started" ? "warning" : "accent";
  const details = options.expanded ? `\n${theme.fg("dim", `Call: ${activity.auditId}`)}` : "";
  return new Text(theme.fg(color, formatActivity(activity)) + details, 0, 0);
};
