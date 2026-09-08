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
| `/flex retries N` | Set retries after initial attempt, from 0–10 |
| `/flex help` | Show all options |

The footer shows `💪 flex:on` or `💪 flex:off`. New sessions start with Flex off unless launched with `--flex`.

Both `--flex` and `/flex on` affect only models using Pi's native `openai` provider and `openai-responses` API. With Codex subscriptions or other providers, Flexy shows `flex:on (inactive)` and leaves requests untouched.

## Retries

Flex capacity errors can arrive inside an HTTP 200 event stream. Flexy retries those failures inside the original provider call, before Pi sees a failed assistant turn. This keeps any steering message you type while waiting out of the retry payload.

Retries use the same post-hook payload and stay on `service_tier=flex`. Backoff starts at two seconds, doubles, and caps at 30 seconds. Flexy retries only transient failures that produced no text, reasoning, or tool calls. Once output starts, it will not replay the request.

After the configured budget is exhausted, Flexy returns one terminal error that Pi will not retry again. `/flex audit` shows the retry count, every observed HTTP attempt, and whether the budget was exhausted. Retry count follows the current session branch, like Flex mode.

Flex can still be slow or unavailable. Flexy won't silently switch to standard pricing; use `/flex off` if you want to retry without Flex. Savings are estimates, not billing records.

Inspired by [pi-flex-processing](https://github.com/laxman-patel/pi-flex-processing).
