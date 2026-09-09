import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { FlexConfig } from "../src/config.ts";

test("preferences persist across independent instances; fields merge and unknown data survives", t => {
  const dir = mkdtempSync(join(tmpdir(), "flexy-config-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "flexy.json");
  const first = new FlexConfig(path), second = new FlexConfig(path);
  assert.deepEqual(first.load(), { retries: 2, fallback: false });
  first.update({ retries: 0 });
  assert.deepEqual(second.load(), { retries: 0, fallback: false });
  second.update({ fallback: true });
  assert.deepEqual(first.load(), { retries: 0, fallback: true });
  const data = JSON.parse(readFileSync(path, "utf8"));
  writeFileSync(path, JSON.stringify({ ...data, future: "keep" }));
  first.update({ retries: 10 });
  assert.equal(JSON.parse(readFileSync(path, "utf8")).future, "keep");
  assert.deepEqual(second.load(), { retries: 10, fallback: true });
});

test("invalid config and concurrent writes fail visibly without destructive repair", t => {
  const dir = mkdtempSync(join(tmpdir(), "flexy-config-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "flexy.json"), config = new FlexConfig(path);
  for (const text of ["broken", '{"version":2}', '{"version":1,"fallback":"true"}', '{"version":1,"retries":11}']) {
    writeFileSync(path, text);
    assert.throws(() => config.load());
    assert.throws(() => config.update({ fallback: true }));
    assert.equal(readFileSync(path, "utf8"), text);
  }
  writeFileSync(path, '{"version":1,"retries":0,"fallback":false}');
  writeFileSync(`${path}.lock`, "");
  assert.throws(() => config.update({ fallback: true }), /EEXIST/);
  assert.equal(config.load().fallback, false);
});
