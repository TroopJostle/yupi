# Feature Task Specs

Implementation task specifications for bringing pi to parity with modern coding-agent harnesses (Claude Code, Codex CLI, Gemini CLI, OpenCode, ZCode). Each spec is self-contained: an implementing agent needs only the spec, its research dossier, and the repo — no conversation context.

Numbering follows the original feature list; 03 (declarative permission modes + OS sandboxing) is intentionally excluded.

| # | Feature | Spec | Research dossier |
|---|---------|------|------------------|
| 01 | Subagent delegation (`task` tool, read-only explore type) | [01-subagent-delegation.md](01-subagent-delegation.md) | [research/01-subagent-delegation.md](research/01-subagent-delegation.md) |
| 02 | Plan mode + todo tracking | [02-plan-mode-and-todo-tracking.md](02-plan-mode-and-todo-tracking.md) | [research/02-plan-mode-and-todo-tracking.md](research/02-plan-mode-and-todo-tracking.md) |
| 04 | Web tools (webfetch, websearch) | [04-web-tools.md](04-web-tools.md) | [research/04-web-tools.md](research/04-web-tools.md) |
| 05 | Skill invocation tool (harness-loaded SKILL.md) | [05-skill-invocation-tool.md](05-skill-invocation-tool.md) | [research/05-skill-invocation-tool.md](research/05-skill-invocation-tool.md) |
| 06 | Background bash execution | [06-background-bash.md](06-background-bash.md) | [research/06-background-bash.md](research/06-background-bash.md) |
| 07 | MCP client support | [07-mcp-client.md](07-mcp-client.md) | [research/07-mcp-client.md](research/07-mcp-client.md) |
| 08 | File checkpoints / rewind | [08-file-checkpoints-rewind.md](08-file-checkpoints-rewind.md) | [research/08-file-checkpoints-rewind.md](research/08-file-checkpoints-rewind.md) |
| 09 | System-prompt communication contract | [09-prompt-communication-contract.md](09-prompt-communication-contract.md) | [research/09-prompt-communication-contract.md](research/09-prompt-communication-contract.md) |

Each spec contains: metadata (priority/effort/risk/dependencies), problem statement with example traces, cited prior art (verbatim tool schemas and prompt language from primary sources), proposed design (exact JSON schemas, literal prompt text, integration points into named pi files), file-by-file implementation plan, testing plan (vitest + faux provider per repo rules), changelog draft, risks, and acceptance criteria.

## Notable findings during research

- Feature 01: the repo already contains `packages/coding-agent/vendor/pi-subagents` (untracked, from a concurrent session) — a near-complete Claude-Code-style subagents extension wired into `resource-loader.ts`. The spec scopes the remaining gaps rather than a rewrite.
- Feature 09: pi's TUI does render interim assistant text between tool calls, so the contract's visibility rule is worded accordingly (unlike ZCode's "may not be shown").
- Feature 07: MCP spec 2025-06-18 handshake is the recommended target; hand-rolled minimal client beats the official SDK given pi's exact-pin dependency constraints.

## Suggested implementation order

1. 09 (contract) — smallest, immediate effect on every turn.
2. 06 (background bash) — self-contained, unblocks long-running workflows.
3. 02 (plan mode + todos) — pairs with 01's approval semantics.
4. 01 (subagent delegation) — completes the vendored extension.
5. 05 (skill tool) — small, builds on existing skills.ts.
6. 04 (web tools) — independent; needs API-key decisions.
7. 08 (checkpoints) — independent; pairs with session fork.
8. 07 (MCP) — largest effort, do last.

Dependencies between specs are noted in each spec's Metadata section.
