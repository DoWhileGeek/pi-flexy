import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { test } from "node:test";
import type { Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext, ProviderConfig, RegisteredCommand } from "@earendil-works/pi-coding-agent";
import flexy from "../extensions/flex.ts";
import { AUDIT_ENTRY, decodeAudit, type Entry, isRecord, verdict } from "../src/audit.ts";

type Command = Omit<RegisteredCommand, "name" | "sourceInfo">;
type Handler = (event: never, ctx: ExtensionCommandContext) => unknown;
const baseModel: Model<"openai-responses"> = {
  provider: "openai", api: "openai-responses", id: "gpt-5.4", name: "GPT-5.4",
  baseUrl: "http://127.0.0.1/v1", reasoning: false, input: ["text"],
  cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 256,
};
function harness() {
  let entries: Entry[] = [];
  const notices: string[] = [];
  const statuses = new Map<string, string | undefined>();
  const handlers = new Map<string, Handler>();
  const commands = new Map<string, Command>();
  let provider: ProviderConfig | undefined;
  const ctx = {
    model: { ...baseModel }, hasUI: true,
    ui: { notify: (text: string) => notices.push(text), setStatus: (key: string, value: string | undefined) => statuses.set(key, value) },
    sessionManager: { getBranch: () => entries },
  } as unknown as ExtensionCommandContext;
  const api = {
    on: (name: string, handler: Handler) => handlers.set(name, handler),
    registerCommand: (name: string, command: Command) => commands.set(name, command),
    registerProvider: (name: string, config: ProviderConfig) => { assert.equal(name, "openai"); provider = config; },
    appendEntry: (customType: string, data: unknown) => entries.push({ type: "custom", customType, data: structuredClone(data) }),
  } as unknown as ExtensionAPI;
  flexy(api);
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
  return { ctx, commands, command, emit, notices, statuses, run, lastAudit,
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
  const branch = structuredClone(h.entries);
  await h.command("toggle");
  assert.equal(h.statuses.get("flexy"), "💪 flex:off");
  await h.command("on extra");
  assert.match(h.notices.at(-1)!, /Invalid/);
  await h.command("history 51");
  assert.match(h.notices.at(-1)!, /Invalid/);
  await h.command("audit");
  assert.match(h.notices.at(-1)!, /no AI call/);
  const completions = await h.commands.get("flex")!.getArgumentCompletions!("a");
  assert.equal(completions?.[0]?.value, "audit");
  h.replaceBranch(branch);
  await h.emit("session_tree");
  assert.equal(h.statuses.get("flexy"), "💪 flex:on");
  h.replaceBranch([]);
  await h.emit("session_tree");
  assert.equal(h.statuses.get("flexy"), "💪 flex:off");
  const second = harness();
  await second.emit("session_start");
  await h.command("on");
  await second.command("status");
  assert.match(second.notices.at(-1)!, /OFF/);
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

test("native retries remain Flex; no invisible fallback; records every HTTP attempt", async () => {
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
  assert.equal(h.statuses.get("flexy"), "💪 flex:on (inactive)");
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

test("savings command reports last call/session, JSON, autocomplete, and is read-only", async () => {
  const h = harness();
  await h.emit("session_start");
  await h.command("savings");
  assert.match(h.notices.at(-1)!, /none observed yet/);
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
