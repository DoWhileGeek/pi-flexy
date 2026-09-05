# Flexy

Session-scoped OpenAI Flex controls for [Pi](https://pi.dev), with transport-level audits.

```text
/flex on
# Send a prompt using Pi's openai provider.
/flex audit
```

**Toggle intent is not delivery evidence.** Flexy records the serialized HTTP request body and observes the response's `service_tier`. Audit distinguishes **sent as Flex**, **served as Flex**, and **unknown**.

## Try locally

Requires Node ≥22.19 and Pi ≥0.84.4, <0.85.0. Tested with Pi 0.84.4; uses Pi's current `@earendil-works` packages, not the older `@mariozechner` extension API.

From this checkout:

```bash
npm ci --ignore-scripts
pi -e ./extensions/flex.ts
```

Or register this directory as a local Pi package:

```bash
pi install /absolute/path/to/flexy
```

Then restart Pi or run `/reload`. Don't load the same extension through both mechanisms. Disable other extensions registering `/flex` before loading Flexy.

Select an **OpenAI API** model using `/model`, with OpenAI API credentials configured through Pi. `openai-codex` is a separate subscription provider; Flexy does not change it.

Public source: [DoWhileGeek/pi-flexy](https://github.com/DoWhileGeek/pi-flexy). Install directly from GitHub:

```bash
pi install git:github.com/DoWhileGeek/pi-flexy
```

npm package name: `@dowhilegeek/pi-flexy`. Once the first npm release is published:

```bash
pi install npm:@dowhilegeek/pi-flexy
```

Use one installation source at a time to avoid duplicate `/flex` commands. The `pi-package` keyword makes the npm package discoverable in [Pi's package gallery](https://pi.dev/packages); repository creation alone does not publish it.

## Commands

| Command | Behavior |
| --- | --- |
| `/flex` | Same as `/flex status`; never silently toggles |
| `/flex on` | Subsequent managed calls request `service_tier: "flex"` |
| `/flex off` | Subsequent managed calls request `service_tier: "default"` |
| `/flex toggle` | Switch on/off |
| `/flex status` | Selected mode, active provider/model, scope, last observed call |
| `/flex audit` | Detailed audit of the latest observed AI call |
| `/flex audit --json` | Same metadata and verdict as JSON |
| `/flex savings` | Estimated standard cost, Pi cost, and savings for the last call and current session branch |
| `/flex savings --json` | Same estimates, usage breakdown, provenance, and coverage as JSON |
| `/flex history [n]` | Most recent `n` calls, newest first; default 10, range 1–50 |
| `/flex help` | Command reference |

Subcommands have autocomplete. Invalid arguments leave state unchanged. Commands make no model calls and do not add audit reports to model context.

Footer shows `💪 flex:on`, `💪 flex:off`, or `💪 flex:on (inactive)` when the current provider/API is outside scope.

## Scope and state

- **Default off.** Off explicitly requests `default`, not `auto` or the project's default tier.
- **Provider `openai`, API `openai-responses` only.** This is Pi's native OpenAI API path. Chat Completions, Codex OAuth/subscriptions, Azure, OpenRouter, custom provider names, and WebSockets are not managed.
- Custom base URLs under this provider/API remain supported. Audit records the origin and cannot prove what a proxy sends upstream.
- No hard-coded model allowlist. OpenAI validates current Flex availability. Unsupported models can fail instead of silently becoming more expensive requests. Check [OpenAI's current Flex model availability](https://developers.openai.com/api/docs/guides/flex-processing).
- **No automatic standard-tier fallback.** Pi's existing retries retain the selected payload. To choose standard processing after a capacity error, run `/flex off` and retry yourself.
- Mode changes apply to the **next call**, not an in-flight call or its retries. A tool-use loop can contain multiple calls.
- Mode and audit snapshots live in Pi session custom entries. Resume/reload restores them; tree navigation restores branch-specific state; a new session starts off. No global settings or auth files are changed by Flexy.
- Existing provider retry, timeout, auth, header, tool, and token-accounting behavior stays with Pi. Flexy reports savings estimates but does not rewrite Pi usage costs or increase timeouts. Flex may be slower; configure Pi's provider timeouts when needed.

## Savings

```text
/flex savings
/flex savings --json
```

Reports **last-call estimates** and **current session-branch totals**. For example:

```text
Standard, same token/cache usage: $1.364580
Pi estimate (already tier-adjusted): $0.682290
Estimated saved: $0.682290 (50.0%)
```

Pi already discounts its token cost estimate when OpenAI reports Flex. **Flexy never halves that cost again.**

- **New calls:** snapshot Pi's model prices at request start and token usage/cost at completion. Calculate the standard-price baseline from those frozen prices; compare against Pi's already-adjusted estimate. Later model or price changes cannot rewrite past estimates.
- **Older Flexy audits:** match the saved assistant message by provider, API, model, timestamp, and observed response ID. Recover its saved Pi cost; reconstruct the standard baseline using Pi 0.84's Flex multiplier. Output labels these as historical reconstructions. No current catalog prices are substituted, and session files are not rewritten.
- **Usage:** handle input, cached reads, cache writes, and output separately. Reasoning tokens are already part of output, not another charge. Request-wide price tiers use total input tokens, including cache reads/writes, matching Pi's threshold rules.
- **Evidence:** require a successful terminal response with a confirmed `flex` or `default` tier. A confirmed standard response earns zero Flex savings even if the toggle was on. Missing usage/rates, placeholder zero prices, mismatched cost calculations, failed calls, and unverified tiers are excluded—not assumed free.
- **Totals:** scan all audit snapshots in the active session branch, not only the 50-call history window. Count each audit ID once; show included/excluded audits and unmatched assistant messages. Branch navigation changes the scope. Calls before transport auditing cannot establish Flex savings.
- **No API calls:** `/flex savings` is read-only. No billing credentials, network pricing lookup, or model request is needed.

These are **token-cost estimates, not invoices**. The standard comparison holds token/cache usage constant; it is not a prediction of a separately executed standard request. Each included call prices only its completed response. Charges from earlier failed/retried attempts, hosted tool fees, taxes, negotiated discounts, regional adjustments, or other account-specific billing are not included. An empty eligible set reports unknown totals, not `$0` spend.

## Audit semantics

Example after a successfully observed Flex response:

```text
Flex audit — <call UUID>
openai/gpt-5.4 (openai-responses)
Started: <ISO timestamp> | outcome: complete
Mode at call: on | coverage: transport
Payload hook tier: flex
Sent as Flex: YES (serialized body handed to HTTP transport)
Served as Flex: YES (successful terminal response service_tier)
Attempt 1: sent=flex, HTTP=200, response=flex
  Origin: https://api.openai.com
  Request ID: req_...
  Response ID: resp_...
```

Audit records evidence at three boundaries:

1. **Payload hook:** tier after Pi's chained `before_provider_request` handlers when Flexy's adapter is active. With `payload-only` coverage, this is the value seen by Flexy's handler; later handlers may change it.
2. **Transport:** tier parsed from the final JSON body passed to the request's `fetch`. Retries get separate attempt records. This proves local dispatch intent, not server receipt when the network fails.
3. **Response:** `service_tier` from a terminal Responses API event. An early `response.created` event is not enough. A successful HTTP response plus successful Pi completion is required for a served-tier verdict.

A selected Flex mode followed by `default` on the wire or in the terminal response gets a **MISMATCH** warning. Standard/priority/scale terminal responses are not Flex. `auto`, omitted, or unrecognized response tiers remain unverified.

`UNKNOWN` is deliberate, not an alias for standard processing:

- No observed serialized request, missing response tier, failed/aborted call, or incomplete evidence.
- A different provider made the most recent AI call. Audit reports that call, never an older OpenAI success as though it were current.
- A call predates Flexy, or another extension replaced its provider adapter. Hook-only records are labelled `payload-only`; historical mode is not guessed for unobserved calls.
- Reload during a pending call restores it as `interrupted`, not permanently running.

Before any observed call, audit says so. While a call is running, audit shows pending evidence. The extension also observes auxiliary requests that pass through its registered OpenAI provider adapter; requests made by unrelated tools or subprocesses are outside scope.

### Evidence limits

Audit is **not a billing receipt or packet capture**. Another custom fetch implementation, an HTTP proxy, or the server can change behavior beyond this local boundary. Server-reported tiers are evidence, not independent verification of charges.

- Latest 50 calls retained in memory and reconstructed for history.
- Latest 20 HTTP attempts retained per call; truncation is shown and prevents an all-attempt transmission verdict.
- SSE/JSON inspection capped at 256 Ki characters per event, request inspection at 16 Mi characters. Oversized or unsupported bodies remain unverified; they are still forwarded unchanged.
- Response inspection uses a backpressure-aware transform, not `Response.clone()` or a background reader. SSE bytes are forwarded unchanged; cancellation propagates.
- Session files retain metadata snapshots according to Pi's normal session lifetime. The 50-call limit is not a disk-retention policy.

## Privacy and composition

No prompt, completion text, tool arguments, API keys, auth headers, arbitrary response headers, URL credentials, query strings, or error bodies are saved in audit entries. Saved fields are mode, model identity, timestamps, status, service tiers, endpoint origin, request/response IDs, outcome, token counts, Pi-estimated costs, and request-time model prices. These metadata can still be sensitive; protect session files accordingly.

No global `fetch` patch. Flexy wraps only Pi's OpenAI Responses adapter and injects a per-call fetch observer. Provider credentials, catalogs, and `models.json` overrides remain owned by Pi.

Other payload handlers can change the selected tier; audit reflects the serialized result rather than hiding the conflict. Multiple extensions replacing the same provider adapter cannot guarantee full transport coverage. Prefer one owner; inspect `coverage` in the audit.

## Development

```bash
npm ci --ignore-scripts
npm run check
npm run check:package
```

Tests cover mode/state, branching, malformed session entries, command parsing, provider isolation, final-payload overrides, request/response mismatches, retries, HTTP errors, cancellation, bounded SSE parsing, metadata privacy, savings math without double-discounting, price-tier thresholds, historical recovery, full-branch totals beyond 50 calls, native OpenAI SDK requests to a local HTTP server, and loading/reloading through a real Pi agent session. No real OpenAI credentials or paid API requests are needed.

Layout:

```text
extensions/flex.ts  Pi commands, lifecycle, scoped provider adapter
src/audit.ts        Session state, metadata validation, audit verdicts
src/transport.ts    Serialized request and bounded response observation
src/pricing.ts      Validated usage/price snapshots and standard-price math
src/savings.ts      Last-call and full-branch savings estimates/reporting
test/              Unit, HTTP integration, real Pi loader/session tests
```

## Publishing

See [PUBLISHING.md](https://github.com/DoWhileGeek/pi-flexy/blob/main/PUBLISHING.md) for first-release authentication, npm trusted publishing, tag-based releases, and gallery verification. CI tests Node 22 and 24; npm publication is triggered only by version tags, not ordinary pushes.

## Inspiration

Inspired by the interaction concept in [laxman-patel/pi-flex-processing](https://github.com/laxman-patel/pi-flex-processing): switch OpenAI processing tiers from inside Pi. Flexy's implementation was written independently; request/response auditing, transport observation, state handling, and tests are its own.

See also [OpenAI Flex processing](https://developers.openai.com/api/docs/guides/flex-processing) and [Pi extension documentation](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md).
