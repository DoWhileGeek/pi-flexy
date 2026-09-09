import { closeSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { DEFAULT_FLEX_RETRIES, parseFlexRetries } from "./retry.ts";

export interface Preferences { retries: number; fallback: boolean }
export const DEFAULT_PREFERENCES: Preferences = { retries: DEFAULT_FLEX_RETRIES, fallback: false };

/** Global preferences, independent of branch history. Invalid files never enable spending. */
export class FlexConfig {
  constructor(readonly path: string) {}
  private read(): Record<string, unknown> {
    let text: string;
    try { text = readFileSync(this.path, "utf8"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw error;
    }
    const data = JSON.parse(text);
    if (!data || typeof data !== "object" || Array.isArray(data) || data.version !== 1 ||
        (data.retries !== undefined && (typeof data.retries !== "number" || parseFlexRetries(data.retries) === undefined)) ||
        (data.fallback !== undefined && typeof data.fallback !== "boolean")) {
      throw new Error("Invalid Flexy configuration; expected version 1, retries 0–10, and boolean fallback.");
    }
    return data;
  }
  load(): Preferences {
    const data = this.read();
    return { retries: data.retries as number ?? DEFAULT_PREFERENCES.retries, fallback: data.fallback as boolean ?? false };
  }
  update(patch: Partial<Preferences>): Preferences {
    if (patch.retries !== undefined && parseFlexRetries(patch.retries) === undefined) throw new Error("Invalid retry count.");
    if (patch.fallback !== undefined && typeof patch.fallback !== "boolean") throw new Error("Invalid fallback setting.");
    mkdirSync(dirname(this.path), { recursive: true });
    // Fail visibly on concurrent writers instead of overwriting another session's setting.
    const lock = `${this.path}.lock`;
    const fd = openSync(lock, "wx", 0o600);
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    try {
      const data = { ...DEFAULT_PREFERENCES, ...this.read(), ...patch, version: 1 };
      writeFileSync(temporary, JSON.stringify(data, null, 2) + "\n", { mode: 0o600, flag: "wx" });
      renameSync(temporary, this.path);
      return { retries: data.retries, fallback: data.fallback };
    } finally {
      try {
        try { unlinkSync(temporary); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      } finally {
        closeSync(fd);
        unlinkSync(lock);
      }
    }
  }
}
