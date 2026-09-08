import type { Model } from "@earendil-works/pi-ai";
// Pi 0.84's Jiti loader supports this explicit alias, not arbitrary pi-ai/api/* subpaths.
import { openAIResponsesApi } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI, ExtensionContext, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
  AuditStore, type Audit, formatAudit, identity, isRecord, managed, scopeReason, tierOf, verdict,
} from "../src/audit.ts";
import { auditedFetch } from "../src/transport.ts";
import { capturePricing } from "../src/pricing.ts";
import { formatSavings, savingsReport } from "../src/savings.ts";

const COMMANDS = [
  { value: "on", description: "Request Flex for subsequent OpenAI Responses calls" },
  { value: "off", description: "Request standard processing (service_tier=default)" },
  { value: "toggle", description: "Switch on/off for this session branch" },
  { value: "status", description: "Show selected mode and active model scope" },
  { value: "audit", description: "Inspect last AI call; optional --json" },
  { value: "savings", description: "Estimate last-call and session savings; optional --json" },
  { value: "history", description: "Show recent calls; optional count 1–50" },
  { value: "help", description: "Show usage and audit guarantees" },
];
const HELP = [
  "Flexy — OpenAI Flex controls",
  ...COMMANDS.map(c => `/flex ${c.value.padEnd(9)} ${c.description}`),
  "/flex              Same as /flex status",
  "pi --flex          Start a session with Flex on before the first prompt",
  "Mode defaults off unless --flex is passed; stored in this session branch, not global config.",
  "On requests flex; off requests default. No silent standard-tier fallback.",
  "Applies only to openai / openai-responses. Codex subscriptions and other APIs are untouched.",
  "Audit observes serialized HTTP bodies and final response service_tier; never infers delivery from the toggle.",
  "Savings use confirmed response tiers and Pi's already-adjusted token cost estimates, not billing receipts.",
].join("\n");

function show(ctx: ExtensionContext, text: string, level: "info" | "warning" | "error" = "info"): void {
  if (ctx.hasUI) ctx.ui.notify(text, level);
  else console.log(text);
}

export default function flexy(pi: ExtensionAPI): void {
  pi.registerFlag("flex", {
    description: "Start with OpenAI Flex enabled",
    type: "boolean",
    default: false,
  });

  let active = true;
  let uiContext: ExtensionContext | undefined;
  const store = new AuditStore((type, data) => { if (active) pi.appendEntry(type, data); });
  let insideManagedHook = 0;
  let fallbackCall: Audit | undefined;
  const managedMessages = new WeakSet<object>();
  const openAI = openAIResponsesApi();

  function updateStatus(ctx: ExtensionContext): void {
    uiContext = ctx;
    if (ctx.hasUI) ctx.ui.setStatus("flexy", `💪 flex:${store.mode}${managed(ctx.model) ? "" : " (inactive)"}`);
  }
  function restore(ctx: ExtensionContext): void {
    fallbackCall = undefined;
    store.restore(ctx.sessionManager.getBranch());
    updateStatus(ctx);
  }

  // Override only the native OpenAI Responses stream implementation. Pi continues to
  // own auth, models.json, headers, tools, token accounting, cancellation, and retries.
  pi.registerProvider("openai", {
    api: "openai-responses",
    streamSimple(model, context, options) {
      const audit = store.begin(identity(model), "transport");
      audit.pricing = capturePricing(model.cost, audit.startedAt) ?? null;
      const selectedTier = audit.mode === "on" ? "flex" : "default";
      const stream = openAI.streamSimple(model as Model<"openai-responses">, context, {
        ...options,
        fetch: auditedFetch(audit, options?.fetch ?? globalThis.fetch),
        onPayload: async (payload, requestModel) => {
          const selected = isRecord(payload) ? { ...payload, service_tier: selectedTier } : payload;
          insideManagedHook++;
          let replacement: unknown;
          try { replacement = await options?.onPayload?.(selected, requestModel); }
          finally { insideManagedHook--; }
          const final = replacement === undefined ? selected : replacement;
          audit.payloadTier = tierOf(final);
          return final;
        },
      });
      // result() observes the final message without consuming or duplicating stream events.
      void stream.result().then(message => {
        managedMessages.add(message);
        if (!active || !store.contains(audit)) return;
        store.finish(audit, message);
        if (verdict(audit).mismatch && uiContext) {
          show(uiContext, "Flex tier mismatch detected. /flex audit shows request/response evidence.", "warning");
        }
      }).catch(() => {
        // Session teardown can invalidate Pi's append API. Never break the provider stream.
        if (active && uiContext) show(uiContext, "Flex audit could not be saved; current transport evidence may be incomplete.", "warning");
      });
      return stream;
    },
  });

  // Record non-managed calls too: /flex audit must not silently report an older OpenAI call.
  // Also provides honestly labelled payload-only coverage if another provider extension replaces ours.
  pi.on("before_provider_request", (event, ctx) => {
    if (insideManagedHook || !ctx.model) return;
    fallbackCall = store.begin(identity(ctx.model), "payload-only");
    const payload = managed(ctx.model) && isRecord(event.payload)
      ? { ...event.payload, service_tier: store.mode === "on" ? "flex" : "default" }
      : event.payload;
    fallbackCall.payloadTier = tierOf(payload);
    return payload;
  });

  pi.on("message_end", (event, ctx) => {
    if (event.message.role !== "assistant" || managedMessages.has(event.message)) return;
    const message = event.message;
    const audit = fallbackCall && store.contains(fallbackCall) && fallbackCall.model.provider === message.provider && fallbackCall.model.id === message.model
      ? fallbackCall : store.begin({ provider: message.provider, id: message.model, api: message.api }, "unobserved", message.timestamp);
    fallbackCall = undefined;
    store.finish(audit, message);
    updateStatus(ctx);
  });

  pi.on("session_start", (_event, ctx) => {
    restore(ctx);
    if (pi.getFlag("flex") === true) {
      if (store.mode !== "on") store.setMode("on");
      updateStatus(ctx);
      show(ctx, status(ctx), managed(ctx.model) ? "info" : "warning");
    }
  });
  pi.on("session_tree", (_event, ctx) => restore(ctx));
  pi.on("model_select", (_event, ctx) => updateStatus(ctx));
  pi.on("session_shutdown", (_event, ctx) => {
    active = false;
    if (ctx.hasUI) ctx.ui.setStatus("flexy", undefined);
  });

  function status(ctx: ExtensionContext): string {
    return [
      `Flex: ${store.mode.toUpperCase()} (session branch; next managed call requests ${store.mode === "on" ? "flex" : "default"})`,
      `Active model: ${ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "none"}`,
      scopeReason(ctx.model),
      `Last call: ${store.last ? `${store.last.model.provider}/${store.last.model.id}; /flex audit for evidence` : "none observed"}`,
    ].join("\n");
  }

  async function command(args: string, ctx: ExtensionCommandContext): Promise<void> {
    const [raw = "status", ...rest] = args.trim().split(/\s+/).filter(Boolean);
    const subcommand = raw.toLowerCase();
    const valid = COMMANDS.some(c => c.value === subcommand);
    const validArgs = subcommand === "audit" || subcommand === "savings" ? rest.length === 0 || (rest.length === 1 && rest[0] === "--json")
      : subcommand === "history" ? rest.length === 0 || (rest.length === 1 && /^(?:[1-9]|[1-4][0-9]|50)$/.test(rest[0]!))
      : rest.length === 0;
    if (!valid || !validArgs) { show(ctx, "Invalid /flex command or arguments.\n" + HELP, "warning"); return; }
    if (subcommand === "on" || subcommand === "off" || subcommand === "toggle") {
      store.setMode(subcommand === "toggle" ? store.mode === "on" ? "off" : "on" : subcommand);
      updateStatus(ctx);
      show(ctx, status(ctx), managed(ctx.model) ? "info" : "warning");
    } else if (subcommand === "status") {
      show(ctx, status(ctx));
    } else if (subcommand === "help") {
      show(ctx, HELP);
    } else if (subcommand === "audit") {
      const audit = store.last;
      show(ctx, rest[0] === "--json" ? JSON.stringify({ audit: audit ?? null, verdict: audit ? verdict(audit) : null }, null, 2) : formatAudit(audit));
    } else if (subcommand === "savings") {
      const report = savingsReport(ctx.sessionManager.getBranch(), store.records);
      show(ctx, rest[0] === "--json" ? JSON.stringify(report, null, 2) : formatSavings(report));
    } else if (subcommand === "history") {
      const records = store.records.slice(-Number(rest[0] ?? 10)).reverse();
      show(ctx, records.length ? ["Flex history — newest first", ...records.map(a => {
        const v = verdict(a);
        return `${a.startedAt} ${a.model.provider}/${a.model.id} mode=${a.mode} sent-flex=${v.sentAsFlex} served-flex=${v.servedAsFlex} ${a.outcome}${v.mismatch ? " MISMATCH" : ""}`;
      })].join("\n") : "Flex history: no calls observed in this session branch.");
    }
  }

  pi.registerCommand("flex", {
    description: "OpenAI Flex on/off, status, transport audit, savings, and history",
    getArgumentCompletions(prefix) {
      for (const command of ["audit", "savings"]) {
        if (prefix.startsWith(`${command} `)) {
          const value = `${command} --json`;
          return "--json".startsWith(prefix.slice(command.length + 1)) ? [{ value, label: value }] : null;
        }
      }
      const matches = COMMANDS.filter(c => c.value.startsWith(prefix.toLowerCase()));
      return matches.length ? matches.map(c => ({ ...c, label: c.value })) : null;
    },
    handler: command,
  });
}
