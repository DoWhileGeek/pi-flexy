# Flexy

Toggle OpenAI Flex in [Pi](https://pi.dev), check whether your last call used it, and see estimated savings.

## Install

```bash
pi install npm:@dowhilegeek/pi-flexy
```

Start Pi or run `/reload` in an existing session. Installation works even if Flexy isn't listed in Pi's package gallery.

Requires Node ≥22.19, Pi ≥0.84.4 and <0.85.0, and an OpenAI API key. ChatGPT/Codex subscriptions aren't supported.

## Use

In Pi, use `/login` to add your OpenAI API key, then `/model` to select a [Flex-supported model](https://developers.openai.com/api/docs/guides/flex-processing) under `openai`.

Start Pi with Flex enabled before first prompt:

```bash
pi --flex
```

Flexy retries transient, zero-output Flex failures twice by default. Set a different retry budget at startup if needed:

```bash
pi --flex --flex-retries 4
```

`--flex-retries 4` means four retries after the first attempt, for five total stream attempts. Accepted values are `0` through `10`.

You can also run `/flex on` in an existing session. Send a prompt, then run `/flex audit` after the reply.

| Command | What it does |
| --- | --- |
| `/flex on` | Use Flex for subsequent calls |
| `/flex off` | Return to standard processing |
| `/flex toggle` | Switch Flex on or off |
| `/flex status` | Show current mode and last-call summary |
| `/flex audit` | Check whether the last call was sent and served as Flex |
| `/flex savings` | Show estimated savings for the last call and current session branch |
| `/flex history` | Show recent calls |
| `/flex retries` | Show retry budget |
| `/flex retries N` | Save global retry budget, from 0–10 |
| `/flex fallback` | Show standard-tier fallback preference |
| `/flex fallback on\|off` | Save global fallback preference (default off) |
| `/flex help` | Show all options |

The footer shows `💪 flex:on` or `💪 flex:off`. New sessions start with Flex off unless launched with `--flex`.

Both `--flex` and `/flex on` affect only models using Pi's native `openai` provider and `openai-responses` API. With Codex subscriptions or other providers, Flexy shows `flex:on (inactive)` and leaves requests untouched.

## Retries and standard-tier fallback

Retryable errors can arrive inside an HTTP 200 stream, not just as HTTP errors. Flexy handles retries inside the original provider call, so queued steering does not enter the retried request. Error classification uses Pi's transient-error classifier; it does not imply a particular HTTP status or prove a Flex capacity rejection.

By default, Flexy allows two Flex retries after the initial attempt, with fallback **off**. Backoff starts at two seconds, doubles, and caps at 30 seconds. Text, reasoning, or tool-call output prevents automatic replay. Cancellation and non-retryable errors do not trigger fallback.

Enable one standard-tier attempt after the Flex budget is exhausted:

```text
/flex retries 2
/flex fallback on
```

That sequence permits **Flex → Flex → Flex → default**. For an immediate switch after the initial Flex failure, use `/flex retries 0` with fallback enabled: **Flex → default**.

**Fallback uses standard pricing.** It changes only the failed provider call, not your session's Flex mode. The next new model call starts on Flex again. Fallback gets exactly one attempt; if it fails, Flexy stops rather than returning to Flex or allowing Pi to add more retries. Managed Flex calls disable SDK-level retries so HTTP retries cannot multiply this budget. Standard-mode calls keep their normal Pi behavior.

Retries use a detached snapshot of the final post-hook JSON payload. Fallback changes only `service_tier` to `default`; it does not rerun payload hooks or include queued input. `/flex audit` records each HTTP attempt, the retry budget, and whether fallback was used. A successful default-tier response contributes no Flex savings.

### Session activity

Retries and fallback appear live in the Pi transcript, not just in transient notifications:

```text
[2026-09-09 20:10:11.123 UTC] Flexy: Flex request failed. Retry 1/2 scheduled in 2s (still Flex pricing).
[2026-09-09 20:10:13.125 UTC] Flexy: Retrying failed request on Flex (1/2).
...
[2026-09-09 20:10:25.400 UTC] Flexy: Falling back to non-Flex after 3 failed Flex attempt(s).
Requesting default tier at standard pricing for this call only. Session Flex mode unchanged.
```

The fallback notice uses warning coloring and is recorded when the default-tier request reaches the HTTP transport. It reports requested pricing, not a billing confirmation; `/flex audit` shows the response-tier evidence. Cancelling before that handoff does not produce a fallback marker.

Entries retain their original UTC timestamps across resume and reload. Expand an entry to see its audit call ID. The footer also shows retry/backoff or the current standard-tier fallback while active. These are custom session entries, never model messages: they do not steer the agent, trigger extra turns, or enter prompts/compaction context. No prompts, generated output, or raw provider errors are stored in activity entries. Print mode writes the same activity text to stderr; JSON/RPC clients receive native `entry_appended` events.

### Preferences across sessions

`/flex retries N` and `/flex fallback on|off` save preferences in `~/.pi/agent/flexy.json` (or `$PI_CODING_AGENT_DIR/flexy.json`). Existing sessions read preferences before each new managed call. In-flight calls keep the policy they started with. Branch navigation does not rewind these preferences; older branch-local retry settings are superseded by global preferences. Flex on/off mode remains branch-local.

Startup flags also save these preferences:

```bash
pi --flex --flex-retries 0 --flex-fallback on
```

Omit those preference flags to keep saved values; `--flex-fallback off` disables fallback. Invalid configuration produces a warning and uses two retries with fallback off, without rewriting the file. Failed preference writes are reported instead of silently changing the active policy.

Flex can still be slow or unavailable. Fallback is never enabled implicitly. Savings are estimates, not billing records.

Inspired by [pi-flex-processing](https://github.com/laxman-patel/pi-flex-processing).
