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

Run `/flex on`, send a prompt, then `/flex audit` after the reply.

| Command | What it does |
| --- | --- |
| `/flex on` | Use Flex for subsequent calls |
| `/flex off` | Return to standard processing |
| `/flex toggle` | Switch Flex on or off |
| `/flex status` | Show current mode and last-call summary |
| `/flex audit` | Check whether the last call was sent and served as Flex |
| `/flex savings` | Show estimated savings for the last call and current session branch |
| `/flex history` | Show recent calls |
| `/flex help` | Show all options |

The footer shows `💪 flex:on` or `💪 flex:off`. New sessions start with Flex off.

Flex can be slower or unavailable. Flexy won't silently switch to standard pricing; use `/flex off` if you want to retry without Flex. Savings are estimates, not billing records.

Inspired by [pi-flex-processing](https://github.com/laxman-patel/pi-flex-processing).
