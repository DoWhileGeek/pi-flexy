import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { isRetryableAssistantError, type Model, type SimpleStreamOptions } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext, ProviderConfig, RegisteredCommand, EntryRenderer } from "@earendil-works/pi-coding-agent";
import { configureFlexy } from "../extensions/flex.ts";
import { AUDIT_ENTRY, decodeAudit, type Entry, isRecord, verdict } from "../src/audit.ts";

import { ACTIVITY_ENTRY, decodeActivity, formatActivity } from "../src/activity.ts";
import { FlexConfig } from "../src/config.ts";
const testDir = mkdtempSync(join(tmpdir(), "flexy-config-tests-"));
after(() => rmSync(testDir, { recursive: true, force: true }));
let configIndex = 0;

type Command = Omit<RegisteredCommand, "name" | "sourceInfo">;
type Handler = (event: never, ctx: ExtensionCommandContext) => unknown;
const baseModel: Model<"openai-responses"> = {
  provider: "openai", api: "openai-responses", id: "gpt-5.4", name: "GPT-5.4",
  baseUrl: "http://127.0.0.1/v1", reasoning: false, input: ["text"],
  cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 256,
};
function harness(options: { flex?: boolean; flexRetries?: string; configPath?: string; onAppend?: (type: string, data: unknown) => void } = {}) {
  let entries: Entry[] = [];
  const notices: string[] = [];
  const noticeLevels: Array<string | undefined> = [];
  const statuses = new Map<string, string | undefined>();
  const handlers = new Map<string, Handler>();
  const renderers = new Map<string, EntryRenderer>();
  const commands = new Map<string, Command>();
  const flags = new Map<string, { description?: string; type: "boolean" | "string"; default?: boolean | string }>();
  const flagValues = new Map<string, boolean | string>();
  if (options.flex !== undefined) flagValues.set("flex", options.flex);
  if (options.flexRetries !== undefined) flagValues.set("flex-retries", options.flexRetries);
  let provider: ProviderConfig | undefined;
  const ctx = {
    model: { ...baseModel }, hasUI: true,
    ui: { notify: (text: string, level?: string) => { notices.push(text); noticeLevels.push(level); }, setStatus: (key: string, value: string | undefined) => statuses.set(key, value) },
    sessionManager: {
      getBranch: () => entries, getEntries: () => entries,
      getSessionId: () => "harness-session", getSessionFile: () => undefined,
      getSessionDir: () => join(testDir, "sessions"), getHeader: () => undefined,
    },
  } as unknown as ExtensionCommandContext;
  const api = {
    on: (name: string, handler: Handler) => handlers.set(name, handler),
    registerEntryRenderer: (name: string, renderer: EntryRenderer) => renderers.set(name, renderer),
    registerCommand: (name: string, command: Command) => commands.set(name, command),
    registerFlag: (name: string, flag: { description?: string; type: "boolean" | "string"; default?: boolean | string }) => {
      flags.set(name, flag);
      if (!flagValues.has(name) && flag.default !== undefined) flagValues.set(name, flag.default);
    },
    getFlag: (name: string) => flagValues.get(name),
    registerProvider: (name: string, config: ProviderConfig) => { assert.equal(name, "openai"); provider = config; },
    appendEntry: (customType: string, data: unknown) => {
      options.onAppend?.(customType, data);
      entries.push({ type: "custom", customType, data: structuredClone(data) });
    },
  } as unknown as ExtensionAPI;
  const configPath = options.configPath ?? join(testDir, `${++configIndex}.json`);
  configureFlexy(api, new FlexConfig(configPath));
  const emit = (name: string, event: unknown = {}) => handlers.get(name)?.(event as never, ctx);
  const command = (text: string) => commands.get("flex")!.handler(text, ctx);
  const lastAudit = () => decodeAudit(entries.filter(e => e.customType === AUDIT_ENTRY).at(-1)?.data)!;
  const run = async (options: SimpleStreamOptions = {}) => {
    const stream = provider!.streamSimple!(ctx.model!, { messages: [{ role: "user", content: "secret-prompt", timestamp: Date.now() }] }, {
      apiKey: "fake-test-key", maxRetries: 0,
      ...options,
      onPayload: async (payload, model) => {
        const changed = await emit("before_provider_request", { payload });
        const final = changed === undefined ? payload : changed;
        return options.onPayload ? (await options.onPayload(final, model)) ?? final : final;
      },
    });
    const events: string[] = [];
    for await (const event of stream) events.push(event.type);
    const message = await stream.result();
    await emit("message_end", { message });
    entries.push({ type: "message", message });
    return { message, events };
  };
  return { configPath, ctx, renderers, commands, flags, command, emit, notices, noticeLevels, statuses, run, lastAudit,
    get entries() { return entries; }, replaceBranch: (next: Entry[]) => { entries = next; } };
}

function sse(tier: string | undefined = "flex"): string {
  const item = { type: "message", id: "msg_test", role: "assistant", status: "completed", content: [{ type: "output_text", text: "pong 🦴", annotations: [] }] };
  const response = { id: "resp_test", object: "response", status: "completed", service_tier: tier, model: "gpt-5.4", output: [item], usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 } };
  const events = [
    { type: "response.created", response: { id: "resp_test", status: "in_progress" } },
    { type: "response.output_item.added", output_index: 0, item: { ...item, content: [] } },
    { type: "response.output_text.delta", output_index: 0, content_index: 0, delta: "pong 🦴" },
    { type: "response.output_item.done", output_index: 0, item },
    { type: "response.completed", response },
  ];
  return events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
}
function mockFetch(tier: string | undefined = "flex"): typeof fetch {
  return async () => new Response(sse(tier), { headers: { "content-type": "text/event-stream", "x-request-id": "req_test" } });
}
function failedSse(): string {
  const response = {
    id: "resp_failed", object: "response", status: "failed", service_tier: "flex", output: [],
    error: { code: "server_error", message: "We're currently processing too many requests — please try again later." },
    usage: null,
  };
  return `event: response.failed\ndata: ${JSON.stringify({ type: "response.failed", response })}\n\n`;
}
async function listen(server: Server): Promise<string> {
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return `http://127.0.0.1:${address.port}/v1`;
}
async function close(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}

test("commands, autocomplete, invalid args, branch restoration, instance isolation", async () => {
  const h = harness();
  await h.emit("session_start");
  await h.command("");
  assert.match(h.notices.at(-1)!, /OFF/);
  await h.command("ON");
  assert.equal(h.statuses.get("flexy"), "💪 flex:on");
  await h.command("retries 5");
  assert.match(h.notices.at(-1)!, /5 after initial/);
  assert.equal((await h.commands.get("flex")!.getArgumentCompletions!("retries 1"))?.[0]?.value, "retries 1");
  const branch = structuredClone(h.entries);
  await h.command("toggle");
  assert.equal(h.statuses.get("flexy"), "💪 flex:off");
  await h.command("on extra");
  assert.match(h.notices.at(-1)!, /Invalid/);
  await h.command("history 51");
  assert.match(h.notices.at(-1)!, /Invalid/);
  await h.command("retries 11");
  assert.match(h.notices.at(-1)!, /Invalid/);
  await h.command("audit");
  assert.match(h.notices.at(-1)!, /no AI call/);
  const completions = await h.commands.get("flex")!.getArgumentCompletions!("a");
  assert.equal(completions?.[0]?.value, "audit");
  h.replaceBranch(branch);
  await h.emit("session_tree");
  assert.equal(h.statuses.get("flexy"), "💪 flex:on");
  await h.command("retries");
  assert.match(h.notices.at(-1)!, /5 after initial/);
  h.replaceBranch([]);
  await h.emit("session_tree");
  assert.equal(h.statuses.get("flexy"), "💪 flex:off");
  await h.command("retries");
  assert.match(h.notices.at(-1)!, /5 after initial/);
  const second = harness();
  await second.emit("session_start");
  await h.command("on");
  await second.command("status");
  assert.match(second.notices.at(-1)!, /OFF/);
});

test("CLI flags enable Flex and configure retries before first managed call", async () => {
  const h = harness({ flex: true, flexRetries: "3" });
  assert.deepEqual(h.flags.get("flex"), {
    description: "Start with OpenAI Flex enabled",
    type: "boolean",
    default: false,
  });
  assert.deepEqual(h.flags.get("flex-retries"), {
    description: "Flex stream retries after the initial attempt (0-10)",
    type: "string",
  });
  await h.emit("session_start");
  assert.equal(h.statuses.get("flexy"), "💪 flex:on");
  assert.match(h.notices.at(-1)!, /Flex: ON/);
  assert.match(h.notices.at(-1)!, /Flex retries: 3/);
  assert.equal(h.noticeLevels.at(-1), "info");
  await h.run({ fetch: mockFetch() });
  assert.equal(h.lastAudit().mode, "on");
  assert.equal(verdict(h.lastAudit()).sentAsFlex, "YES");

  const invalid = harness({ flexRetries: "99" });
  await invalid.emit("session_start");
  assert.match(invalid.notices.at(-1)!, /Invalid --flex-retries/);
  await invalid.command("retries");
  assert.match(invalid.notices.at(-1)!, /2 after initial/);

  const inactive = harness({ flex: true });
  inactive.ctx.model = { ...baseModel, provider: "openai-codex", api: "openai-codex-responses" };
  await inactive.emit("session_start");
  assert.equal(inactive.statuses.get("flexy"), undefined, "out-of-scope model renders no Flex status line");
  assert.equal(inactive.noticeLevels.at(-1), "warning");
  assert.match(inactive.notices.at(-1)!, /Codex subscription/);
  const payload = { model: "gpt-5.4" };
  assert.equal(await inactive.emit("before_provider_request", { payload }), payload);
  assert.equal("service_tier" in payload, false);
  await inactive.command("on");
  assert.equal(inactive.statuses.get("flexy"), undefined, "explicit mode change cannot revive a status line for an out-of-scope model");
  inactive.ctx.model = { ...baseModel };
  await inactive.emit("model_select");
  assert.equal(inactive.statuses.get("flexy"), "💪 flex:on", "status returns when a managed model is selected");
});

test("native SDK hits local HTTP server: on/off wire tiers, request ID, no stream regression", async () => {
  const received: Record<string, unknown>[] = [];
  const server = createServer(async (req, res) => {
    let text = "";
    for await (const chunk of req) text += String(chunk);
    const body = JSON.parse(text) as Record<string, unknown>;
    received.push(body);
    assert.equal(req.url, "/v1/responses");
    assert.equal(req.headers.authorization, "Bearer fake-test-key");
    res.writeHead(200, { "content-type": "text/event-stream", "x-request-id": "req_http" });
    res.end(sse(String(body.service_tier)));
  });
  const baseUrl = await listen(server);
  try {
    const h = harness();
    h.ctx.model = { ...baseModel, baseUrl };
    await h.emit("session_start");
    await h.command("on");
    let responseHooks = 0;
    const { message, events } = await h.run({ onResponse: () => { responseHooks++; } });
    assert.equal(message.stopReason, "stop", message.errorMessage);
    assert.ok(events.includes("text_delta"));
    assert.equal(message.content[0]?.type, "text");
    assert.equal(responseHooks, 1);
    assert.equal(received[0]?.service_tier, "flex");
    assert.equal(received[0]?.input !== undefined, true);
    const audit = h.lastAudit();
    assert.deepEqual(verdict(audit), { sentAsFlex: "YES", servedAsFlex: "YES", mismatch: false });
    assert.equal(audit.attempts[0]?.requestId, "req_http");
    assert.equal(new Set(h.entries.filter(e => e.customType === AUDIT_ENTRY).map(e => decodeAudit(e.data)?.id)).size, 1);
    assert.doesNotMatch(JSON.stringify(h.entries.filter(e => e.type === "custom")), /secret-prompt|fake-test-key|pong/);
    await h.command("off");
    const standard = await h.run();
    assert.equal(standard.message.stopReason, "stop");
    assert.equal(received[1]?.service_tier, "default");
    assert.equal(verdict(h.lastAudit()).sentAsFlex, "NO");
    await h.command("audit --json");
    assert.equal(JSON.parse(h.notices.at(-1)!).audit.mode, "off");
    await h.command("history 2");
    assert.match(h.notices.at(-1)!, /newest first/);
  } finally { await close(server); }
});

test("later payload mutation is audited as sent, not as selected", async () => {
  const h = harness();
  await h.emit("session_start");
  await h.command("on");
  await h.run({ fetch: mockFetch("default"), onPayload: payload => ({ ...(payload as object), service_tier: "default" }) });
  const audit = h.lastAudit();
  assert.equal(audit.mode, "on");
  assert.equal(audit.payloadTier, "default");
  assert.equal(verdict(audit).sentAsFlex, "NO");
  assert.equal(verdict(audit).mismatch, true);
  assert.ok(h.notices.some(n => n.includes("mismatch detected")));
});

test("Flex retry policy stays inactive for standard mode and later payload removal", async () => {
  const standard = harness();
  await standard.emit("session_start");
  let standardRequests = 0;
  const standardResult = await standard.run({ fetch: async () => {
    standardRequests++;
    return new Response(failedSse(), { headers: { "content-type": "text/event-stream" } });
  } });
  assert.equal(standardRequests, 1);
  assert.match(standardResult.message.errorMessage!, /too many requests/i);
  assert.equal(standard.lastAudit().flexRetry, undefined);

  const h = harness();
  await h.emit("session_start");
  await h.command("on");
  await h.command("retries 0");
  const result = await h.run({
    fetch: async () => new Response(failedSse(), { headers: { "content-type": "text/event-stream" } }),
    onPayload: payload => ({ ...(payload as object), service_tier: "default" }),
  });
  assert.equal(result.message.stopReason, "error");
  assert.match(result.message.errorMessage!, /too many requests/i, "non-Flex failure must pass through unchanged");
  assert.deepEqual(h.lastAudit().flexRetry, { limit: 0, performed: 0, terminalReason: "pass-through" });
  assert.equal(h.lastAudit().attempts[0]?.sentTier, "default");
});

test("Flex stream capacity retry freezes payload and hides failed attempt from Pi", async () => {
  const h = harness();
  await h.emit("session_start");
  await h.command("on");
  await h.command("retries 1");
  let requests = 0;
  let payloadHooks = 0;
  const bodies: string[] = [];
  const fetch: typeof globalThis.fetch = async (_input, init) => {
    requests++;
    bodies.push(String(init?.body));
    return requests === 1
      ? new Response(failedSse(), { headers: { "content-type": "text/event-stream", "x-request-id": "req_failed" } })
      : mockFetch()(_input, init);
  };
  const result = await h.run({
    fetch,
    onPayload: payload => { payloadHooks++; return { ...(payload as object), stable_marker: "same" }; },
  });
  assert.equal(result.message.stopReason, "stop", result.message.errorMessage);
  assert.equal(requests, 2);
  assert.equal(payloadHooks, 1, "post-hook payload must be frozen across internal retries");
  assert.equal(bodies[0], bodies[1]);
  assert.equal(result.events.filter(event => event === "start").length, 1);
  assert.equal(result.events.includes("error"), false);
  assert.deepEqual(h.lastAudit().flexRetry, { limit: 1, performed: 1, terminalReason: "success" });
  assert.deepEqual(h.lastAudit().attempts.map(a => [a.sentTier, a.status]), [["flex", 200], ["flex", 200]]);
  assert.deepEqual(h.lastAudit().attempts[0]?.providerError, {
    eventType: "response.failed", code: "server_error",
    message: "We're currently processing too many requests — please try again later.",
  });
  assert.equal(h.lastAudit().attempts[0]?.errorMessage, undefined);
  assert.equal(verdict(h.lastAudit()).servedAsFlex, "YES");
  await h.command("audit json");
  assert.deepEqual(JSON.parse(h.notices.at(-1)!).audit.attempts[0].providerError, {
    eventType: "response.failed", code: "server_error",
    message: "We're currently processing too many requests — please try again later.",
  });
  assert.equal(h.statuses.get("flexy"), "💪 flex:on");
});

test("Flex retry exhaustion is final for Pi and never falls back to default", async () => {
  const h = harness();
  await h.emit("session_start");
  await h.command("on");
  await h.command("retries 0");
  let requests = 0;
  const result = await h.run({ fetch: async (_input, init) => {
    requests++;
    assert.equal(JSON.parse(String(init?.body)).service_tier, "flex");
    return new Response(failedSse(), { headers: { "content-type": "text/event-stream" } });
  } });
  assert.equal(requests, 1);
  assert.equal(result.message.stopReason, "error");
  assert.match(result.message.errorMessage!, /1 total stream attempt/);
  assert.equal(isRetryableAssistantError(result.message), false);
  assert.deepEqual(h.lastAudit().flexRetry, { limit: 0, performed: 0, terminalReason: "budget-exhausted" });
  assert.equal(h.lastAudit().attempts[0]?.providerError?.code, "server_error");
  assert.equal(h.lastAudit().attempts[0]?.errorMessage, undefined);
  await h.command("audit");
  assert.match(h.notices.at(-1)!, /terminal: budget-exhausted/);
  assert.match(h.notices.at(-1)!, /Provider error \[response.failed\]/);
});

test("managed retries replace SDK retries; every HTTP attempt is counted", async () => {
  const h = harness();
  await h.emit("session_start");
  await h.command("on");
  let requests = 0;
  const fetch: typeof globalThis.fetch = async (_input, init) => {
    assert.equal(JSON.parse(String(init?.body)).service_tier, "flex");
    requests++;
    return requests === 1
      ? new Response(JSON.stringify({ error: { message: "Resource unavailable", type: "rate_limit_error" } }), { status: 429, headers: { "content-type": "application/json", "retry-after-ms": "1" } })
      : mockFetch()(_input, init);
  };
  const result = await h.run({ fetch, maxRetries: 1 });
  assert.equal(result.message.stopReason, "stop", result.message.errorMessage);
  assert.equal(requests, 2);
  assert.deepEqual(h.lastAudit().attempts.map(a => [a.sentTier, a.status]), [["flex", 429], ["flex", 200]]);
  assert.equal(verdict(h.lastAudit()).servedAsFlex, "YES");
});

test("response mismatch and missing service tier stay distinct", async () => {
  const h = harness();
  await h.emit("session_start");
  await h.command("on");
  await h.run({ fetch: mockFetch("default") });
  assert.deepEqual(verdict(h.lastAudit()), { sentAsFlex: "YES", servedAsFlex: "NO", mismatch: true });
  await h.run({ fetch: async () => new Response(sse().replace(',"service_tier":"flex"', ""), { headers: { "content-type": "text/event-stream" } }) });
  assert.equal(verdict(h.lastAudit()).servedAsFlex, "UNKNOWN");
});

test("other providers stay untouched and replace last managed audit", async () => {
  const h = harness();
  await h.emit("session_start");
  await h.command("on");
  await h.run({ fetch: mockFetch() });
  h.ctx.model = { ...baseModel, provider: "openai-codex", api: "openai-codex-responses" };
  await h.emit("model_select");
  const payload = { model: "gpt-5.4", instructions: "secret" };
  const result = await h.emit("before_provider_request", { payload });
  assert.equal(result, payload);
  assert.equal("service_tier" in payload, false);
  await h.emit("message_end", { message: { role: "assistant", provider: "openai-codex", api: "openai-codex-responses", model: "gpt-5.4", stopReason: "stop", timestamp: Date.now() } });
  await h.command("audit");
  assert.match(h.notices.at(-1)!, /Codex subscription/);
  assert.equal(h.lastAudit().model.provider, "openai-codex");
  assert.equal(h.statuses.get("flexy"), undefined);
});

test("overridden transport falls back to honest payload-only evidence", async () => {
  const h = harness();
  await h.emit("session_start");
  await h.command("on");
  const result = await h.emit("before_provider_request", { payload: { model: "gpt-5.4" } });
  assert.ok(isRecord(result));
  assert.equal(result.service_tier, "flex");
  await h.emit("message_end", { message: { role: "assistant", provider: "openai", api: "openai-responses", model: "gpt-5.4", stopReason: "stop", timestamp: Date.now() } });
  assert.equal(h.lastAudit().coverage, "payload-only");
  assert.equal(verdict(h.lastAudit()).sentAsFlex, "UNKNOWN");
});

test("HTTP errors and aborted requests do not claim Flex service", async () => {
  const h = harness();
  await h.emit("session_start");
  await h.command("on");
  const failed = await h.run({ fetch: async () => new Response(JSON.stringify({ error: { message: "unsupported model" } }), { status: 400, headers: { "content-type": "application/json" } }) });
  assert.equal(failed.message.stopReason, "error");
  assert.equal(h.lastAudit().outcome, "error");
  assert.equal(h.lastAudit().attempts[0]?.status, 400);
  assert.equal(verdict(h.lastAudit()).sentAsFlex, "YES");
  assert.equal(verdict(h.lastAudit()).servedAsFlex, "UNKNOWN");
  const controller = new AbortController();
  controller.abort();
  const aborted = await h.run({ signal: controller.signal, fetch: mockFetch() });
  assert.equal(aborted.message.stopReason, "aborted");
  assert.equal(h.lastAudit().outcome, "aborted");
  assert.equal(verdict(h.lastAudit()).servedAsFlex, "UNKNOWN");
});

test("savings command shows session totals without last-call section; JSON remains compatible and read-only", async () => {
  const h = harness();
  await h.emit("session_start");
  await h.command("savings");
  assert.match(h.notices.at(-1)!, /totals unknown/);
  assert.doesNotMatch(h.notices.at(-1)!, /Last AI call/);
  await h.command("savings --bad");
  assert.match(h.notices.at(-1)!, /Invalid/);
  assert.equal((await h.commands.get("flex")!.getArgumentCompletions!("sav"))?.[0]?.value, "savings");
  assert.equal((await h.commands.get("flex")!.getArgumentCompletions!("savings --j"))?.[0]?.value, "savings --json");
  await h.command("on");
  let fetches = 0;
  const result = await h.run({ fetch: async (input, init) => { fetches++; return mockFetch()(input, init); } });
  const before = structuredClone(h.entries);
  await h.command("savings --json");
  const report = JSON.parse(h.notices.at(-1)!);
  assert.equal(report.lastCall.status, "estimated");
  assert.equal(report.lastCall.source, "request-time-prices");
  assert.equal(report.lastCall.piCost.total, result.message.usage.cost.total);
  assert.equal(report.lastCall.savedPercent, 50);
  assert.equal(report.session.includedCalls, 1);
  assert.equal(report.session.historicalCalls, 0);
  assert.equal(fetches, 1, "savings must not make an API request");
  assert.deepEqual(h.entries, before, "savings must not append or mutate session data");
  assert.doesNotMatch(h.notices.at(-1)!, /secret-prompt|fake-test-key|pong/);
  await h.command("off");
  await h.command("savings");
  assert.match(h.notices.at(-1)!, /50.0%/);
  assert.match(h.notices.at(-1)!, /already tier-adjusted/);
});

test("savings survives price changes and reload; old audits backfill saved usage", async () => {
  const h = harness();
  await h.emit("session_start");
  await h.command("on");
  await h.run({ fetch: mockFetch() });
  await h.command("savings --json");
  const original = JSON.parse(h.notices.at(-1)!);
  h.ctx.model = { ...baseModel, cost: { input: 999, output: 999, cacheRead: 999, cacheWrite: 999 } };
  await h.emit("model_select");
  await h.emit("session_tree");
  await h.command("savings --json");
  assert.equal(JSON.parse(h.notices.at(-1)!).lastCall.standardCost.total, original.lastCall.standardCost.total);
  const historical = structuredClone(h.entries);
  for (const entry of historical) {
    if (entry.customType === AUDIT_ENTRY && isRecord(entry.data)) {
      delete entry.data.pricing;
      delete entry.data.usage;
    }
  }
  h.replaceBranch(historical);
  await h.emit("session_tree");
  await h.command("savings --json");
  const recovered = JSON.parse(h.notices.at(-1)!);
  assert.equal(recovered.lastCall.status, "estimated");
  assert.equal(recovered.lastCall.source, "saved-pi-cost");
  assert.equal(recovered.lastCall.piCost.total, original.lastCall.piCost.total);
  assert.equal(recovered.lastCall.standardCost.total, original.lastCall.standardCost.total);
});

test("savings does not invent a discount for unknown tier, standard fallback, or zero prices", async () => {
  const h = harness();
  await h.emit("session_start");
  await h.command("on");
  await h.run({ fetch: mockFetch("default") });
  await h.command("savings --json");
  assert.equal(JSON.parse(h.notices.at(-1)!).lastCall.savedUsd, 0);
  await h.run({ fetch: async () => new Response(sse().replace(',"service_tier":"flex"', ""), { headers: { "content-type": "text/event-stream" } }) });
  await h.command("savings --json");
  assert.equal(JSON.parse(h.notices.at(-1)!).lastCall.status, "unavailable");
  h.ctx.model = { ...baseModel, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
  await h.run({ fetch: mockFetch() });
  await h.command("savings --json");
  assert.equal(JSON.parse(h.notices.at(-1)!).lastCall.status, "unavailable");
});

test("global retries/fallback survive new sessions, tree navigation and other active sessions", async () => {
  const h = harness();
  await h.emit("session_start");
  await h.command("retries 0");
  await h.command("fallback on");
  assert.match(h.notices.at(-1)!, /standard pricing/);
  const other = harness({ configPath: h.configPath });
  await other.emit("session_start");
  await other.command("status");
  assert.match(other.notices.at(-1)!, /Flex retries: 0/);
  assert.match(other.notices.at(-1)!, /fallback: ON/);
  h.replaceBranch([]);
  await h.emit("session_tree");
  await h.command("status");
  assert.match(h.notices.at(-1)!, /Flex retries: 0/);
  assert.match(h.notices.at(-1)!, /fallback: ON/);
  await other.command("fallback off");
  await h.command("fallback");
  assert.match(h.notices.at(-1)!, /OFF/);
  await h.command("fallback yes");
  assert.match(h.notices.at(-1)!, /Invalid/);
});

test("one default fallback changes only tier; next new call stays Flex, audit and savings stay honest", async () => {
  const h = harness();
  await h.emit("session_start");
  await h.command("on");
  await h.command("retries 0");
  await h.command("fallback on");
  const bodies: Record<string, unknown>[] = [];
  const mutable = { value: "original" };
  let hooks = 0;
  const result = await h.run({
    maxRetries: 5,
    onPayload: payload => { hooks++; return { ...(payload as object), metadata: mutable }; },
    fetch: async (_input, init) => {
      const body = JSON.parse(String(init?.body));
      bodies.push(body);
      if (body.service_tier === "flex") {
        mutable.value = "changed outside provider";
        return new Response(failedSse(), { headers: { "content-type": "text/event-stream" } });
      }
      return mockFetch("default")(_input, init);
    },
  });
  assert.equal(result.message.stopReason, "stop");
  assert.equal(hooks, 1);
  assert.equal(bodies.length, 2);
  assert.deepEqual(bodies[1], { ...bodies[0], service_tier: "default" });
  const audit = h.lastAudit();
  assert.deepEqual(audit.fallback, { enabled: true, attemptNumber: 2 });
  assert.deepEqual(verdict(audit), { sentAsFlex: "MIXED", servedAsFlex: "NO", mismatch: false });
  const activity = h.entries.filter(e => e.customType === ACTIVITY_ENTRY).map(e => decodeActivity(e.data)!);
  assert.deepEqual(activity.map(a => a.kind), ["fallback-started"]);
  assert.equal(activity[0]!.at, audit.attempts[1]!.startedAt);
  assert.match(formatActivity(activity[0]!), /standard pricing/);
  await h.command("audit");
  assert.match(h.notices.at(-1)!, /attempt 2 \(standard pricing\)/);
  await h.command("savings --json");
  assert.equal(JSON.parse(h.notices.at(-1)!).lastCall.savedUsd, 0);
  await h.run({ fetch: mockFetch() });
  assert.equal(h.lastAudit().attempts[0]?.sentTier, "flex");
  assert.equal(h.lastAudit().fallback?.attemptNumber, undefined);
  assert.equal(h.statuses.get("flexy"), "💪 flex:on");
});

test("cancelled backoff renders scheduled retry only; no false fallback pricing switch", async () => {
  const controller = new AbortController();
  const h = harness({ onAppend: (type, data) => {
    if (type === ACTIVITY_ENTRY && decodeActivity(data)?.kind === "retry-scheduled") controller.abort();
  } });
  await h.emit("session_start");
  await h.command("on");
  await h.command("retries 1");
  await h.command("fallback on");
  let requests = 0;
  const result = await h.run({ signal: controller.signal, fetch: async () => {
    requests++;
    return new Response(failedSse(), { headers: { "content-type": "text/event-stream" } });
  } });
  assert.equal(result.message.stopReason, "aborted");
  assert.equal(requests, 1);
  assert.equal(h.lastAudit().attempts[0]?.providerError?.code, "server_error");
  assert.equal(h.lastAudit().attempts[0]?.errorMessage, undefined);
  assert.deepEqual(h.entries.filter(e => e.customType === ACTIVITY_ENTRY).map(e => decodeActivity(e.data)?.kind), ["retry-scheduled"]);
  assert.equal(h.statuses.get("flexy"), "💪 flex:on");
});

test("abort before default transport handoff does not render a pricing switch", async () => {
  const controller = new AbortController();
  const h = harness({ onAppend: (type, data) => {
    if (type === AUDIT_ENTRY && decodeAudit(data)?.fallback?.attemptNumber) controller.abort();
  } });
  await h.emit("session_start");
  await h.command("on");
  await h.command("retries 0");
  await h.command("fallback on");
  let requests = 0;
  const result = await h.run({ signal: controller.signal, fetch: async () => {
    requests++;
    return new Response(failedSse(), { headers: { "content-type": "text/event-stream" } });
  } });
  assert.equal(result.message.stopReason, "aborted");
  assert.equal(requests, 1);
  assert.equal(h.entries.filter(e => e.customType === ACTIVITY_ENTRY).length, 0);
});

test("activity persistence/UI failure cannot prevent fallback HTTP request", async () => {
  const h = harness({ onAppend: type => {
    if (type === ACTIVITY_ENTRY) throw new Error("Simulated entry write failure");
  } });
  await h.emit("session_start");
  await h.command("on");
  await h.command("retries 0");
  await h.command("fallback on");
  const setStatus = h.ctx.ui.setStatus;
  h.ctx.ui.setStatus = (key, text) => {
    if (text?.includes("current:default")) throw new Error("Simulated UI failure");
    setStatus(key, text);
  };
  let requests = 0;
  const result = await h.run({ fetch: async (input, init) => {
    requests++;
    return requests === 1 ? new Response(failedSse(), { headers: { "content-type": "text/event-stream" } }) : mockFetch("default")(input, init);
  } });
  assert.equal(requests, 2);
  assert.equal(result.message.stopReason, "stop");
  assert.ok(h.notices.some(n => n.includes("Session activity entry could not be saved")));
});

test("bare savings arguments and legacy aliases work in either order and remain read-only", async () => {
  const h = harness();
  await h.emit("session_start");
  await h.command("on");
  await h.run({ fetch: mockFetch() });
  const before = JSON.stringify(h.entries);
  await h.command("savings all json");
  const report = JSON.parse(h.notices.at(-1)!);
  assert.equal(report.scope, "all-local-sessions-all-branches");
  assert.equal(report.totals.includedCalls, 1);
  assert.equal(report.totals.flexCalls, 1);
  assert.ok(report.totals.savedUsd > 0);
  for (const args of ["savings json all", "savings --all --json", "savings --json --all", "savings all --json"]) {
    await h.command(args);
    assert.deepEqual(JSON.parse(h.notices.at(-1)!).totals, report.totals);
  }
  await h.command("savings json");
  assert.equal(JSON.parse(h.notices.at(-1)!).session.includedCalls, 1);
  await h.command("audit json");
  assert.equal(JSON.parse(h.notices.at(-1)!).audit.id, h.lastAudit().id);
  await h.command("savings all");
  assert.match(h.notices.at(-1)!, /all local sessions, all branches/);
  assert.doesNotMatch(h.notices.at(-1)!, /Last AI call/);
  assert.equal(JSON.stringify(h.entries), before);
  assert.equal(h.statuses.get("flexy-savings"), undefined);
  for (const args of ["savings all all", "savings json --json", "savings all --all", "savings all bad", "audit all", "audit json --json", "savings --all --all", "savings --json --json", "savings --all --bad", "audit --all"]) {
    await h.command(args);
    assert.match(h.notices.at(-1)!, /Invalid/);
  }
  const complete = h.commands.get("flex")!.getArgumentCompletions!;
  assert.equal((await complete("savings --all --j"))?.[0]?.value, "savings --all --json");
  assert.deepEqual((await complete("savings "))?.map(c => c.value), ["savings all", "savings json"]);
  assert.equal((await complete("savings all j"))?.[0]?.value, "savings all json");
  assert.equal((await complete("savings json a"))?.[0]?.value, "savings json all");
  assert.equal((await complete("audit j"))?.[0]?.value, "audit json");
  assert.equal(await complete("savings all all "), null);
  assert.equal(await complete("savings all json "), null);
});

test("all-savings avoids ephemeral cwd discovery and rejects concurrent scans", async () => {
  const h = harness();
  await h.emit("session_start");
  h.ctx.sessionManager.getSessionDir = () => { throw new Error("Ephemeral cwd is not session storage"); };
  const first = h.command("savings --all");
  await h.command("savings --all");
  assert.match(h.notices.at(-1)!, /scan already running/);
  await first;
  assert.match(h.notices.at(-1)!, /all local sessions/);
  assert.equal(h.statuses.get("flexy-savings"), undefined);
});
