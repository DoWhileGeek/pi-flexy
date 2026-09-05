import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const script = fileURLToPath(new URL("../scripts/verify-release.mjs", import.meta.url));
function verify(repository: string, tag: string) {
  return spawnSync(process.execPath, [script], {
    encoding: "utf8",
    env: { ...process.env, RELEASE_REPOSITORY: repository, RELEASE_TAG: tag },
  });
}

test("release guard accepts only canonical repository and matching stable version tag", () => {
  const result = verify("DoWhileGeek/pi-flexy", `v${pkg.version}`);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /@dowhilegeek\/pi-flexy/);
});

test("release guard rejects ordinary branch pushes, mismatched tags, and forks", () => {
  for (const tag of ["main", "v999.0.0", `v${pkg.version}-beta.1`, ""]) {
    const result = verify("DoWhileGeek/pi-flexy", tag);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Release tag must match/);
  }
  const fork = verify("someone-else/pi-flexy", `v${pkg.version}`);
  assert.notEqual(fork.status, 0);
  assert.match(fork.stderr, /canonical repository/);
});
