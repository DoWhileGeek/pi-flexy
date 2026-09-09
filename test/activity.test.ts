import assert from "node:assert/strict";
import { test } from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { ACTIVITY_ENTRY, decodeActivity, formatActivity, renderActivity, type Activity } from "../src/activity.ts";

const base = { version: 1 as const, at: "2026-09-09T20:10:11.123Z", auditId: "test-call" };
const retry: Activity = { ...base, kind: "retry-scheduled", retry: 1, limit: 2, delayMs: 2000 };
const fallback: Activity = { ...base, kind: "fallback-started", flexAttempts: 3 };
const entry = (data: unknown) => ({ type: "custom" as const, id: "test", parentId: null, timestamp: base.at, customType: ACTIVITY_ENTRY, data });

test("activity text includes durable UTC timestamp, retry counts/delay and explicit pricing switch", () => {
  assert.equal(formatActivity(retry), "[2026-09-09 20:10:11.123 UTC] Flexy: Flex request failed. Retry 1/2 scheduled in 2s (still Flex pricing).");
  assert.match(formatActivity({ ...base, kind: "retry-started", retry: 1, limit: 2 }), /Retrying failed request on Flex \(1\/2\)/);
  assert.match(formatActivity(fallback), /Falling back to non-Flex after 3 failed Flex attempt/);
  assert.match(formatActivity(fallback), /Requesting default tier at standard pricing for this call only/);
  assert.match(formatActivity(fallback), /Session Flex mode unchanged/);
});

test("renderer wraps narrow terminals, highlights fallback, and expands audit identity", () => {
  const colors: string[] = [];
  const theme = { fg: (color: string, text: string) => { colors.push(color); return text; } } as Theme;
  for (const activity of [retry, fallback]) {
    const component = renderActivity(entry(activity), { expanded: false }, theme)!;
    for (const width of [20, 40, 80, 120]) {
      const lines = component.render(width);
      assert.ok(lines.length > 0);
      assert.ok(lines.every(line => visibleWidth(line) <= width));
      assert.doesNotMatch(lines.join("\n"), /test-call/);
    }
    component.invalidate();
    const expanded = renderActivity(entry(activity), { expanded: true }, theme)!;
    assert.match(expanded.render(120).join("\n"), /Call: test-call/);
  }
  assert.ok(colors.includes("warning"));
  assert.ok(colors.includes("accent"));
});

test("resumed activity is validated and stripped of arbitrary payload/provider text", () => {
  const theme = { fg: (_color: string, text: string) => text } as Theme;
  assert.deepEqual(decodeActivity({ ...retry, payload: "private", errorMessage: "private" }), retry);
  assert.deepEqual(decodeActivity(fallback), fallback);
  for (const invalid of [null, {}, { ...retry, version: 2 }, { ...retry, at: "today\x1b[2J" },
    { ...retry, auditId: "\x1b[2J" }, { ...retry, retry: 0 }, { ...retry, limit: 11 },
    { ...retry, retry: 3 }, { ...retry, delayMs: Infinity }, { ...retry, delayMs: 31000 },
    { ...fallback, flexAttempts: 0 }, { ...fallback, flexAttempts: 12 }, { ...fallback, kind: "unknown" }]) {
    assert.equal(decodeActivity(invalid), undefined);
    assert.equal(renderActivity(entry(invalid), { expanded: false }, theme), undefined);
  }
});
