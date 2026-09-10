import { constants } from "node:fs";
import { lstat, open, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { AUDIT_ENTRY, decodeAudit, isRecord, safeId, type Audit, type Entry } from "./audit.ts";
import { decodeUsage } from "./pricing.ts";

export const MAX_SESSION_LINE_BYTES = 16 * 1024 * 1024;
export interface SavingsSession {
  id: string;
  path?: string;
  createdAt?: string;
  entries: Entry[];
  liveRecords?: readonly Audit[];
}
export interface ScanWarning { path: string; reason: string; count: number }
export interface SessionScan {
  sessions: SavingsSession[];
  roots: string[];
  filesRead: number;
  duplicateFiles: number;
  warnings: ScanWarning[];
}

/** Keep only accounting metadata. Never retain prompts, tool output, or assistant content. */
export function savingsEntry(value: unknown): Entry | undefined {
  if (!isRecord(value)) return undefined;
  if (value.type === "custom" && value.customType === AUDIT_ENTRY) {
    const audit = decodeAudit(value.data);
    return audit ? { type: "custom", customType: AUDIT_ENTRY, data: audit } : undefined;
  }
  if (value.type !== "message" || !isRecord(value.message) || value.message.role !== "assistant") return undefined;
  const m = value.message;
  return { type: "message", message: {
    role: "assistant", provider: typeof m.provider === "string" ? m.provider.slice(0, 200) : undefined,
    api: typeof m.api === "string" ? m.api.slice(0, 200) : undefined,
    model: typeof m.model === "string" ? m.model.slice(0, 200) : undefined,
    timestamp: typeof m.timestamp === "number" ? m.timestamp : undefined,
    responseId: safeId(m.responseId), usage: decodeUsage(m.usage),
  } };
}

/** No SessionManager.open(): opening legacy sessions can migrate/rewrite them. */
export async function scanSavingsSessions(roots: readonly string[], current?: SavingsSession): Promise<SessionScan> {
  const result: SessionScan = { sessions: [], roots: [...new Set(roots.map(p => resolve(p)))].sort(), filesRead: 0, duplicateFiles: 0, warnings: [] };
  // Detach current-session state before yielding; it may change while other files are read.
  const live = current && {
    ...current, path: current.path ? resolve(current.path) : undefined,
    entries: current.entries.flatMap(e => { const saved = savingsEntry(e); return saved ? [saved] : []; }),
    liveRecords: current.liveRecords?.flatMap(a => { const saved = decodeAudit(a); return saved ? [saved] : []; }),
  };
  const warnings = new Map<string, ScanWarning>();
  function warn(path: string, reason: string): void {
    const key = JSON.stringify([path, reason]);
    const warning = warnings.get(key) ?? { path, reason, count: 0 };
    warning.count++;
    warnings.set(key, warning);
  }
  const paths = new Set<string>();
  async function discover(path: string): Promise<void> {
    if (paths.has(path)) return;
    paths.add(path);
    try {
      const stat = await lstat(path);
      if (stat.isSymbolicLink()) { warn(path, "symlink skipped"); return; }
      if (stat.isFile() && path.endsWith(".jsonl")) { files.add(path); return; }
      if (stat.isDirectory()) {
        const children = await readdir(path);
        for (const child of children.sort()) await discover(resolve(path, child));
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") warn(path, `directory/file unavailable (${(error as NodeJS.ErrnoException).code ?? "read error"})`);
    }
  }
  const files = new Set<string>();
  for (const root of result.roots) await discover(root);
  if (live?.path) files.add(live.path);
  const inodes = new Set<string>();
  for (const path of [...files].sort()) {
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const stat = await handle.stat();
      if (!stat.isFile()) { warn(path, "not a regular file"); continue; }
      const inode = `${stat.dev}:${stat.ino}`;
      if (inodes.has(inode)) { result.duplicateFiles++; continue; }
      inodes.add(inode);
      result.filesRead++;
      let session: SavingsSession | undefined;
      let sawFirstRecord = false;
      function line(bytes: Buffer): void {
        if (!bytes.toString("utf8").trim()) return;
        let value: unknown;
        try { value = JSON.parse(bytes.toString("utf8")); }
        catch { warn(path, "malformed JSONL record"); return; }
        if (!sawFirstRecord) {
          sawFirstRecord = true;
          if (!isRecord(value) || value.type !== "session" || !safeId(value.id) ||
              ![1, 2, 3].includes(Number(value.version ?? 1))) { warn(path, "invalid/unsupported session header"); return; }
          session = { id: value.id as string, path,
            createdAt: typeof value.timestamp === "string" && Number.isFinite(Date.parse(value.timestamp)) ? new Date(value.timestamp).toISOString() : undefined,
            entries: [] };
          return;
        }
        if (!session) return;
        const entry = savingsEntry(value);
        if (entry) session.entries.push(entry);
        else if (isRecord(value) && value.type === "custom" && value.customType === AUDIT_ENTRY) warn(path, "invalid Flexy audit");
      }
      // Read only bytes present at open: never chase a concurrently growing session.
      const chunk = Buffer.alloc(64 * 1024);
      let position = 0, size = 0, dropping = false;
      let parts: Buffer[] = [];
      while (position < stat.size) {
        const { bytesRead } = await handle.read(chunk, 0, Math.min(chunk.length, stat.size - position), position);
        if (!bytesRead) { warn(path, "file shortened during scan"); break; }
        position += bytesRead;
        let start = 0;
        for (let i = 0; i <= bytesRead; i++) {
          if (i !== bytesRead && chunk[i] !== 10) continue;
          const part = chunk.subarray(start, i);
          size += part.length;
          if (!dropping && size > MAX_SESSION_LINE_BYTES) {
            dropping = true; parts = []; warn(path, "oversized JSONL record skipped");
          }
          if (!dropping && part.length) parts.push(Buffer.from(part));
          if (i < bytesRead) {
            if (!dropping) line(Buffer.concat(parts, size));
            parts = []; size = 0; dropping = false;
          }
          start = i + 1;
        }
      }
      // A tail without LF might still be written by another Pi process. Defer it.
      if (size || dropping) warn(path, "unterminated tail deferred");
      if (session) result.sessions.push(session);
      else if (!sawFirstRecord) warn(path, "empty/unreadable session header");
    } catch (error) {
      if (!(live?.path === path && (error as NodeJS.ErrnoException).code === "ENOENT")) {
        warn(path, `file unavailable (${(error as NodeJS.ErrnoException).code ?? "read error"})`);
      }
    } finally { await handle?.close(); }
  }
  if (live) {
    const existing = result.sessions.find(s => s.path === live.path && s.id === live.id);
    if (existing) {
      // getEntries() covers every branch, including not-yet-flushed entries. Prefer
      // that coherent snapshot over a racing disk view of this same session.
      existing.entries = live.entries;
      existing.liveRecords = live.liveRecords;
    } else result.sessions.push(live);
  }
  result.warnings = [...warnings.values()];
  return result;
}
