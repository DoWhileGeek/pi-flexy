import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const cwd = fileURLToPath(new URL("..", import.meta.url));
const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
assert.equal(pkg.name, "@dowhilegeek/pi-flexy");
assert.notEqual(pkg.private, true);
assert.equal(pkg.license, "MIT");
assert.ok(pkg.keywords.includes("pi-package"), "Pi gallery discovery requires the pi-package keyword");
assert.deepEqual(pkg.pi.extensions, ["./extensions/flex.ts"]);
assert.equal(pkg.repository.url, "git+https://github.com/DoWhileGeek/pi-flexy.git");
assert.equal(pkg.publishConfig.access, "public");
assert.equal(pkg.publishConfig.registry, "https://registry.npmjs.org/");
for (const name of ["@earendil-works/pi-ai", "@earendil-works/pi-coding-agent"]) {
  assert.equal(pkg.peerDependencies[name], "*", "Pi supplies core packages at runtime");
  assert.equal(pkg.peerDependenciesMeta[name].optional, true);
  assert.equal(pkg.dependencies?.[name], undefined, "Do not bundle another Pi runtime");
}

// No archive, network request, or publish: inspect the exact npm packing file list.
const npmArgs = ["pack", "--dry-run", "--json", "--ignore-scripts"];
const output = process.env.npm_execpath
  ? execFileSync(process.execPath, [process.env.npm_execpath, ...npmArgs], { cwd, encoding: "utf8" })
  : execFileSync("npm", npmArgs, { cwd, encoding: "utf8" });
const [packed] = JSON.parse(output);
const allowed = [
  "LICENSE", "README.md", "package.json", "extensions/flex.ts",
  "src/audit.ts", "src/pricing.ts", "src/retry.ts", "src/savings.ts", "src/transport.ts",
];
assert.deepEqual(packed.files.map(file => file.path).sort(), allowed.sort(), "Unexpected or missing npm files; review before releasing");
assert.equal(packed.name, pkg.name);
assert.equal(packed.version, pkg.version);
assert.ok(packed.unpackedSize < 1_000_000, "Package unexpectedly exceeds 1 MB unpacked");
console.log(`${packed.id}: ${packed.files.length} reviewed files, ${packed.unpackedSize} bytes unpacked; package ready.`);
