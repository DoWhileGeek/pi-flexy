import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
assert.equal(process.env.RELEASE_REPOSITORY, "DoWhileGeek/pi-flexy", "Only the canonical repository may release this package");
assert.match(pkg.version, /^\d+\.\d+\.\d+$/, "This workflow publishes stable versions only");
assert.equal(process.env.RELEASE_TAG, `v${pkg.version}`, "Release tag must match package.json version");
assert.equal(pkg.name, "@dowhilegeek/pi-flexy");
console.log(`Verified ${process.env.RELEASE_TAG} for ${pkg.name}`);
