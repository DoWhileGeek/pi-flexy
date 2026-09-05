import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
  createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { AUDIT_ENTRY, decodeAudit, verdict } from "../src/audit.ts";

test("real Pi loader + agent session + reload: commands stay local, audits and savings survive", async (t) => {
  const logs: string[] = [];
  t.mock.method(console, "log", (value: unknown) => { logs.push(String(value)); });
  const dir = await mkdtemp(join(tmpdir(), "flexy-sdk-"));
  const tiers: string[] = [];
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += String(chunk);
    const tier = JSON.parse(body).service_tier as string;
    tiers.push(tier);
    res.writeHead(200, { "content-type": "text/event-stream", "x-request-id": "req_sdk" });
    const response = { id: `resp_sdk_${tiers.length}`, object: "response", status: "completed", service_tier: tier, output: [], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } };
    res.end(`data: ${JSON.stringify({ type: "response.created", response })}\n\ndata: ${JSON.stringify({ type: "response.completed", response })}\n\n`);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  let dispose: (() => void) | undefined;
  try {
    await writeFile(join(dir, "models.json"), JSON.stringify({ providers: { openai: { baseUrl: `http://127.0.0.1:${address.port}/v1` } } }));
    const modelRuntime = await ModelRuntime.create({ authPath: join(dir, "auth.json"), modelsPath: join(dir, "models.json"), modelsStorePath: join(dir, "models-store.json"), allowModelNetwork: false, refreshOnCreate: false });
    await modelRuntime.setRuntimeApiKey("openai", "fake-sdk-test-key");
    const builtin = modelRuntime.getModel("openai", "gpt-5.4");
    assert.ok(builtin);
    const model = { ...builtin, baseUrl: `http://127.0.0.1:${address.port}/v1` };
    const settingsManager = SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false } });
    const resourceLoader = new DefaultResourceLoader({
      cwd: dir, agentDir: dir, settingsManager,
      additionalExtensionPaths: [fileURLToPath(new URL("../extensions/flex.ts", import.meta.url))],
      noExtensions: true, noSkills: true, noThemes: true, noContextFiles: true, noPromptTemplates: true,
      systemPrompt: "Reply briefly.",
    });
    await resourceLoader.reload();
    const sessionManager = SessionManager.inMemory(dir);
    const { session, extensionsResult } = await createAgentSession({ cwd: dir, agentDir: dir, model, modelRuntime, resourceLoader, sessionManager, settingsManager, noTools: "all", thinkingLevel: "off" });
    dispose = () => session.dispose();
    assert.deepEqual(extensionsResult.errors, []);
    assert.equal(extensionsResult.extensions.length, 1);
    const errors: string[] = [];
    await session.bindExtensions({ onError: error => errors.push(error.error) });
    await session.prompt("/flex on");
    assert.equal(tiers.length, 0, "slash commands must not make model requests");
    await session.prompt("Ping");
    assert.deepEqual(tiers, ["flex"], JSON.stringify(session.messages.filter(m => m.role === "assistant")));
    let audits = sessionManager.getBranch().filter(e => e.type === "custom" && e.customType === AUDIT_ENTRY).map(e => decodeAudit((e as { data: unknown }).data)!);
    assert.equal(verdict(audits.at(-1)!).servedAsFlex, "YES");
    assert.equal(new Set(audits.map(a => a.id)).size, 1, "real message_end must not duplicate the transport audit");
    await session.prompt("/flex audit");
    assert.equal(tiers.length, 1);
    await session.prompt("/flex savings --json");
    const initialSavings = JSON.parse(logs.at(-1)!);
    assert.equal(initialSavings.session.includedCalls, 1);
    assert.equal(initialSavings.lastCall.source, "request-time-prices");
    assert.equal(initialSavings.lastCall.piCost.total, audits.at(-1)!.usage!.cost.total);
    assert.equal(initialSavings.lastCall.savedPercent, 50);
    assert.equal(tiers.length, 1, "savings must not make model requests");
    await session.reload();
    await session.prompt("/flex savings --json");
    assert.deepEqual(JSON.parse(logs.at(-1)!).session, initialSavings.session);
    await session.prompt("Ping after reload");
    assert.deepEqual(tiers, ["flex", "flex"]);
    audits = sessionManager.getBranch().filter(e => e.type === "custom" && e.customType === AUDIT_ENTRY).map(e => decodeAudit((e as { data: unknown }).data)!);
    assert.equal(verdict(audits.at(-1)!).servedAsFlex, "YES");
    await session.prompt("/flex off");
    await session.prompt("Ping without Flex");
    await session.prompt("/flex savings --json");
    const mixed = JSON.parse(logs.at(-1)!);
    assert.deepEqual(tiers, ["flex", "flex", "default"]);
    assert.equal(mixed.session.includedCalls, 3);
    assert.equal(mixed.session.flexCalls, 2);
    assert.equal(mixed.session.standardCalls, 1);
    assert.equal(mixed.lastCall.savedUsd, 0);
    assert.ok(Math.abs(mixed.session.savedPercent - 100 / 3) < 1e-6);
    assert.deepEqual(errors, []);
  } finally {
    dispose?.();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
});
