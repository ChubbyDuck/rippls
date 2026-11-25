# A Claude Harness on the Agent SDK beside Sandcastle

Rippls ran every Harness through Sandcastle, which starts `claude --print` and writes its output to a log file. The ticket loop drives Claude Code through the Agent SDK. That gives the full Claude Code agent with every setting source, auto permission mode, a live view of the session, its session identity for `claude --resume`, the list of commands a session has, and structured output. We added a Claude Harness on the Agent SDK and made it the default. The Sandcastle Claude Harness stays, selected by `via` in config. Sandcastle also stays for Ticket Worktrees and the other Harnesses.

## Considered options

- **Sandcastle only, with its new permission mode and effort options.** Rejected. Its provider can add to the environment but not remove a variable, it gives no structured output for the Classifier, and it cannot check that a slash command exists before the prompt is sent.
- **The Agent SDK only, dropping the Sandcastle Claude Harness.** Rejected for now. Keeping it costs little and leaves a way back while the new Harness earns trust.

## Consequences

- The Agent SDK runs the `claude` executable on PATH, or the one config names, so the Agent has the version and the login of the developer's own sessions, and the package needs no platform-specific binary.
- The Harness removes `CLAUDECODE` and `CLAUDE_CODE_*` from the Agent's environment, so a run started from inside a Claude Code session starts a top-level session. Other variables, such as `ANTHROPIC_API_KEY`, are left to the caller.
- With no model set, the Agent runs the CLI's default model. A model demand maps to the `haiku`, `sonnet`, and `opus` aliases, so Rippls names no model version that goes stale.
- A Harness run returns the session identity and the Agent's final message. An Escalation in place holds the session, and a verdict is read from the final message.
- The Classifier always runs on the Agent SDK, whatever Harness does the work.
- Rippls depends on both Sandcastle and the Agent SDK.
