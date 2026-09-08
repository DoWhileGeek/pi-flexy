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

function completedSse(id: string, tier: string): string {
  const response = { id, object: "response", status: "completed", service_tier: tier, output: [], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } };
  return `data: ${JSON.stringify({ type: "response.created", response })}\n\ndata: ${JSON.stringify({ type: "response.completed", response })}\n\n`;
}

function failedSse(id: string, tier: string): string {
  const response = {
    id, object: "response", status: "failed", service_tier: tier, output: [], usage: null,
    error: { code: "server_error", message: "We're currently processing too many requests — please try again later." },
  };
  return `data: ${JSON.stringify({ type: "response.failed", response })}\n\n`;
}

test("real Pi loader + startup flag + agent session + reload: commands stay local, audits and savings survive", async (t) => {
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
    res.end(completedSse(`resp_sdk_${tiers.length}`, tier));
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
    const loadedExtensions = resourceLoader.getExtensions();
    assert.deepEqual(loadedExtensions.extensions[0]?.flags.get("flex"), {
      name: "flex",
      description: "Start with OpenAI Flex enabled",
      type: "boolean",
      default: false,
      extensionPath: loadedExtensions.extensions[0]?.path,
    });
    assert.deepEqual(loadedExtensions.extensions[0]?.flags.get("flex-retries"), {
      name: "flex-retries",
      description: "Flex stream retries after the initial attempt (0-10)",
      type: "string",
      extensionPath: loadedExtensions.extensions[0]?.path,
    });
    loadedExtensions.runtime.flagValues.set("flex", true);
    const sessionManager = SessionManager.inMemory(dir);
    const { session, extensionsResult } = await createAgentSession({ cwd: dir, agentDir: dir, model, modelRuntime, resourceLoader, sessionManager, settingsManager, noTools: "all", thinkingLevel: "off" });
    dispose = () => session.dispose();
    assert.deepEqual(extensionsResult.errors, []);
    assert.equal(extensionsResult.extensions.length, 1);
    const errors: string[] = [];
    await session.bindExtensions({ onError: error => errors.push(error.error) });
    assert.equal(tiers.length, 0, "startup flag must not make model requests");
    assert.match(logs.at(-1)!, /Flex: ON/);
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

test("real Pi session keeps steering out of frozen Flex retry payload", async () => {
  const dir = await mkdtemp(join(tmpdir(), "flexy-sdk-retry-"));
  const bodies: string[] = [];
  let failAll = false;
  let firstSeenResolve: (() => void) | undefined;
  const firstSeen = new Promise<void>(resolve => { firstSeenResolve = resolve; });
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += String(chunk);
    bodies.push(body);
    const tier = JSON.parse(body).service_tier as string;
    res.writeHead(200, { "content-type": "text/event-stream", "x-request-id": `req_${bodies.length}` });
    if (failAll || bodies.length === 1) {
      res.end(failedSse("resp_failed", tier));
      firstSeenResolve?.();
    } else {
      res.end(completedSse(`resp_success_${bodies.length}`, tier));
    }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  let dispose: (() => void) | undefined;
  try {
    const baseUrl = `http://127.0.0.1:${address.port}/v1`;
    await writeFile(join(dir, "models.json"), JSON.stringify({ providers: { openai: { baseUrl } } }));
    const modelRuntime = await ModelRuntime.create({
      authPath: join(dir, "auth.json"), modelsPath: join(dir, "models.json"), modelsStorePath: join(dir, "models-store.json"),
      allowModelNetwork: false, refreshOnCreate: false,
    });
    await modelRuntime.setRuntimeApiKey("openai", "fake-sdk-test-key");
    const builtin = modelRuntime.getModel("openai", "gpt-5.4");
    assert.ok(builtin);
    const settingsManager = SettingsManager.inMemory({ retry: { enabled: true, maxRetries: 3, baseDelayMs: 1 }, compaction: { enabled: false } });
    const resourceLoader = new DefaultResourceLoader({
      cwd: dir, agentDir: dir, settingsManager,
      additionalExtensionPaths: [fileURLToPath(new URL("../extensions/flex.ts", import.meta.url))],
      noExtensions: true, noSkills: true, noThemes: true, noContextFiles: true, noPromptTemplates: true,
      systemPrompt: "Reply briefly.",
    });
    await resourceLoader.reload();
    const loadedExtensions = resourceLoader.getExtensions();
    loadedExtensions.runtime.flagValues.set("flex", true);
    loadedExtensions.runtime.flagValues.set("flex-retries", "1");
    const sessionManager = SessionManager.inMemory(dir);
    const { session } = await createAgentSession({
      cwd: dir, agentDir: dir, model: { ...builtin, baseUrl }, modelRuntime, resourceLoader, sessionManager, settingsManager,
      noTools: "all", thinkingLevel: "off",
    });
    dispose = () => session.dispose();
    await session.bindExtensions({ onError: error => assert.fail(error.error) });

    const run = session.prompt("first instruction");
    await firstSeen;
    assert.equal(session.isStreaming, true);
    await session.prompt("second queued instruction", { streamingBehavior: "steer" });
    await run;

    assert.equal(bodies.length, 3, "failed call, frozen retry, then queued steering turn");
    assert.equal(bodies[0], bodies[1], "queued steering must not alter retry payload");
    assert.notEqual(bodies[1], bodies[2]);
    assert.doesNotMatch(bodies[1]!, /second queued instruction/);
    assert.match(bodies[2]!, /second queued instruction/);
    assert.deepEqual(session.messages.map(message => [message.role, message.role === "assistant" ? message.stopReason : undefined]), [
      ["user", undefined], ["assistant", "stop"], ["user", undefined], ["assistant", "stop"],
    ]);
    const auditsById = new Map(sessionManager.getBranch()
      .filter(entry => entry.type === "custom" && entry.customType === AUDIT_ENTRY)
      .map(entry => decodeAudit((entry as { data: unknown }).data)!)
      .map(audit => [audit.id, audit]));
    const audits = [...auditsById.values()];
    assert.equal(audits.length, 2);
    assert.deepEqual(audits[0]?.flexRetry, { limit: 1, performed: 1, terminalReason: "success" });
    assert.equal(audits[0]?.attemptCount, 2);

    await session.prompt("/flex retries 0");
    failAll = true;
    const requestsBeforeExhaustion = bodies.length;
    await session.prompt("exhaust retry budget");
    assert.equal(bodies.length, requestsBeforeExhaustion + 1, "Pi auto-retry must stop after Flexy exhausts configured budget");
    const last = session.messages.at(-1);
    assert.equal(last?.role, "assistant");
    if (last?.role === "assistant") assert.match(last.errorMessage!, /1 total stream attempt/);
  } finally {
    dispose?.();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
});
