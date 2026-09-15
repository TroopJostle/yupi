# Feature 01: Subagent Delegation

This spec covers subagent delegation in the "yupi" coding-agent harness (a fork of earendil-works/pi): a single `Agent` tool that lets the main (parent) model spawn a child agent with its own fresh context window, a per-type system prompt, and a restricted tool set; the parent receives only the child's final message as the tool result and must relay it to the user. The feature is largely already present in the working tree as `packages/coding-agent/vendor/pi-subagents/` (~12.4k lines, untracked, added by a concurrent session) plus hardwired loading in `resource-loader.ts` and two test files. This spec does not re-implement that work; it positions against it, records what is already done, and scopes the remaining integration work: an opt-out kill switch, allowlist-enforced read-only `Explore`/`Plan` defaults, fail-closed dispatch on unknown agent types, a cap on inline child results, and the test coverage that pins the delegation contract (round-trip, tool restriction, recursion guard, result relay).

Jargon used in this document:

- **Subagent / child agent**: a second agent loop started by a tool call inside the parent's turn, with its own conversation history. Nothing the child does enters the parent's context except the text returned by the tool.
- **Context window**: the token budget a model sees per request. Child agents exist to keep bulky tool output (greps, file dumps) out of the parent's window.
- **Frontmatter**: YAML block delimited by `---` at the top of a Markdown agent-definition file.
- **Faux provider**: `@earendil-works/pi-ai/compat`'s scriptable test provider (`registerFauxProvider`, `fauxAssistantMessage`, `fauxToolCall`) used by `packages/coding-agent/test/suite/harness.ts`; agent-level tests here must use it, never real providers.

## Metadata

- **Priority**: high
- **Effort**: M (roughly 2-4 focused days; most machinery exists, work is gap-closing plus tests)
- **Risk**: medium. The changes touch vendored third-party code (divergence from upstream `tintinweb/pi-subagents`), and two items change default behavior (read-only defaults lose `bash`; unknown agent types stop falling back to `general-purpose`).
- **Depends on**: none (no other `feature-tasks/*.md` specs exist yet; related research dossiers `02-plan-mode-and-todo-tracking.md`, `05-skill-invocation-tool.md` are independent)
- **Research**: `feature-tasks/research/01-subagent-delegation.md` (primary prior-art source; all URLs and verbatim quotes below come from it)
- **Status of vendored pi-subagents code**: present and complete as a working tree. `packages/coding-agent/vendor/pi-subagents/` (from TroopJostle/pi-subagents, a fork of tintinweb/pi-subagents, upstream rev e955e29c / 0.19.0) is untracked; `packages/coding-agent/src/core/resource-loader.ts` (modified) injects `vendor/pi-subagents/src/index.ts` into the extension set at lines ~455 and ~562 unless `--no-extensions`; `packages/coding-agent/package.json` (modified) lists `vendor` in `files`; `packages/coding-agent/test/bundled-subagents.test.ts` and `packages/coding-agent/test/suite/bundled-subagents.test.ts` (untracked) test loading and model selection; `packages/coding-agent/CHANGELOG.md` (modified) already has an `[Unreleased] → Added` entry for the bundled extension. Decision of this spec: **keep the vendored extension as the implementation**; do not promote it into `packages/agent` and do not rewrite it. All new work happens inside the vendor tree plus small core touches.

## Problem

Without delegation, any broad investigation pollutes the parent's context window and never leaves. Concrete trace in pi today (no subagents, single session):

1. User: "Find every place this repo applies retry backoff, then fix the bug in the caller that ignores the returned delay."
2. Parent calls `grep` for `backoff|retry` across a large monorepo: ~15 grep/read results, each 50-400 lines, land as full tool results in the parent's transcript (~40k tokens).
3. Parent reads 9 candidate files (`read` on each) to rule out false positives: another ~60k tokens, most of it irrelevant by the end.
4. Only now can the parent edit the one buggy caller. The other ~90k tokens of investigation stay in context for the rest of the session, crowding out later work and degrading cache/compaction behavior (pi compaction has to summarize material the final task never needed).

With the `Agent` tool, step 2-3 run inside an `Explore` child whose grep/read output lives in the child's own window; the parent receives one bounded message ("retry backoff is applied in X, Y, Z; the caller ignoring the delay is `packages/coding-agent/src/core/foo.ts:123`") and edits the file directly. Five parallel investigations become five tool calls in one assistant message (pi executes tool calls concurrently by default; see `ToolExecutionMode` in `packages/agent/src/types.ts`).

The failure modes this design must defend against (all documented across harnesses in the research dossier): terse non-self-contained prompts (children have not seen the conversation), the parent racing/duplicating delegated work, unbounded child final messages re-polluting the parent, children spawning children without limit, and read-only agents that are read-only in name only.

## Prior art

Per harness, from the dossier (quotes verbatim, URLs as given there):

### Claude Code
Tool `Task`, renamed `Agent` in v2.1.63. Parameter schema (2.0-era dump):

```json
{
  "type": "object",
  "properties": {
    "description": { "type": "string", "description": "A short (3-5 word) description of the task" },
    "prompt":      { "type": "string", "description": "The task for the agent to perform" },
    "subagent_type": { "type": "string", "description": "The type of specialized agent to use for this task" }
  },
  "required": ["description", "prompt", "subagent_type"],
  "additionalProperties": false
}
```

Contract language: "Launch a new agent to handle complex, multi-step tasks autonomously."; "1. Launch multiple agents concurrently whenever possible, to maximize performance; to do that, use a single message with multiple tool uses"; "2. When the agent is done, it will return a single message back to you. The result returned by the agent is not visible to the user. To show the user the result, you should send a text message back to the user with a concise summary of the result."; "3. Each agent invocation is stateless. ... your prompt should contain a highly detailed task description for the agent to perform autonomously and you should specify exactly what information the agent should return back to you in its final and only message to you."; "5. Clearly tell the agent whether you expect it to write code or just to do research (search, file reads, web fetches, etc.), since it is not aware of the user's intent". Definitions are Markdown + frontmatter (`name`, `description`, optional `tools`, `model`, ...). Nesting: default depth 3 (`CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH`), concurrency cap 20; at the depth limit the `Agent` tool is withheld from children (registry-level, not prompt-level). If a `tools` list resolves to zero tools, spawn fails naming the unresolved entries. Source: https://code.claude.com/docs/en/sub-agents and https://raw.githubusercontent.com/x1xhlol/system-prompts-and-models-of-ai-tools/main/Anthropic/Claude%20Code/Tools.json

### OpenCode
Tool `task`, same three core params plus `task_id` (resume) and `background` (experimental). Key contract additions over Claude Code: "2. Once you have delegated work to an agent, do not duplicate that work yourself. Continue with non-overlapping tasks, or wait for the result." and "6. ... Tell it how to verify its work if possible (e.g., relevant test commands)." Result envelope: `<task id="{sessionID}" state="running|completed|error"><summary>...</summary><task_result|task_error>{text}</...></task>`; result text is the child's last text part. Recursion guard is two-layer: depth via `parentID` walk (`subagent_depth` default 1) **and** registry denial of `task`/`todowrite` in child sessions unless explicitly re-allowed — "enforcement lives in the tool registry, not the prompt". The spawn itself is a permissioned action (`permission.task` glob patterns; deny removes the agent from the tool description). Built-ins: `general` (subagent, all tools) and `explore` (subagent, read-only). Sources: https://raw.githubusercontent.com/sst/opencode/dev/packages/opencode/src/tool/task.ts, .../task.txt, https://opencode.ai/docs/agents/

### Gemini CLI
Agent-as-tool outlier: each subagent becomes its own tool; no generic `subagent_type` param. Isolation (verbatim): "Each subagent runs in its own isolated context loop"; "Independent history: the subagent's conversation history does not bloat the main agent's context"; "Recursion protection: ... subagents cannot call other subagents. If a subagent is granted the `*` tool wildcard, it will still be unable to see or invoke other agents." Frontmatter: `name`, `description` (required), optional `tools` (allowlist with wildcards; "If omitted, it inherits all tools from the parent session"), `model` ("Defaults to `inherit`"), `max_turns` ("Defaults to `30`."), `timeout_mins` ("Defaults to `10`."). Source: https://raw.githubusercontent.com/google-gemini/gemini-cli/main/docs/core/subagents.md

### OpenAI Codex CLI
Absent. No subagent/orchestration docs or config keys; only user-level orchestration via separate `codex exec` processes. Sources: https://github.com/openai/codex/tree/main/docs, https://raw.githubusercontent.com/openai/codex/main/docs/config.md

### ZCode (firsthand, per dossier)
Agent tool params `{ subagent_type, prompt, description, run_in_background }`; shipped types include `Explore` (read-only; "reads excerpts rather than whole files, so it locates code; it doesn't review or audit"; caller specifies breadth `medium` / `very thorough`). Contract: prompt must be self-contained; child's final message is NOT shown to the user — parent must relay; "once you've delegated a search, don't also run it yourself — wait for the result"; multiple independent agents go in one message with multiple tool uses; `run_in_background: true` notifies on completion; agents resumable by id.

### Cross-harness convergence (design constraints this spec follows)
1. One generic tool with `subagent_type`, not per-agent tools (constant parent tool list; one guard code path).
2. The contract text in the tool description is load-bearing; copy it near-verbatim.
3. Recursion guard belongs in the tool registry, not the prompt.
4. Ship a small default set: general-purpose + read-only explorer (Cursor `readonly: true` "Blocks file edits and state-changing shell commands" is the enforcement bar).
5. Markdown + frontmatter is the definition surface.
6. Cost model: "five parallel subagents ≈ 5× a single agent's usage" (Cursor docs, https://cursor.com/docs/subagents) — cap concurrency and unbounded results.

## Proposed design

### Tool name and schema

Keep the vendored name: **`Agent`** (matches Claude Code's current name; the satellite tools keep their vendored names `get_subagent_result`, `steer_subagent`). One generic tool with `subagent_type`; no per-agent tools (rejects Gemini's model).

Required parameter contract (the stable core; defined with TypeBox `Type.Object` in `vendor/pi-subagents/src/index.ts` ~line 1596):

| Parameter | Type | Required | Semantics |
|---|---|---|---|
| `prompt` | string | yes | The task for the agent to perform. Must be self-contained. |
| `description` | string | yes | "A short (3-5 word) description of the task (shown in UI)." |
| `subagent_type` | string | yes | Which agent type to spawn; description lists available types dynamically. |
| `name` | string | no | Memorable handle for `@mention`/`steer_subagent`. |
| `model` | string | no | `"provider/modelId"` or fuzzy name; `"inherit"` = parent model. Unavailable models fail without substitution (already enforced; see existing suite test). |
| `thinking` | string | no | Thinking level: off, minimal, low, medium, high, xhigh, max. |
| `max_turns` | number (min 1) | no | Turn cap for this child. Omit for the `defaultMaxTurns` setting. |
| `run_in_background` | boolean | no | **Default true**: returns an agent id immediately, completion notification arrives in a later turn. `false` blocks and returns the full output inline. (Decision: keep the vendored default-true; it is documented, tested, and the surrounding "don't race / never fabricate a pending result" text depends on it.) |
| `resume` | string | no | Agent id to continue a previous run. |
| `isolated` | boolean | no | No extension/MCP tools for the child. |
| `inherit_context` | boolean | no | Fork parent conversation into the child (default false = fresh context). |
| `isolation`, `schedule` | conditional | no | Worktree isolation and scheduling params; present in the schema only when the corresponding settings enable them (existing vendored behavior). |

### Result contract

"Conclusions, not transcripts": the tool result delivered to the parent is the child's **final assistant message only** — never its intermediate tool calls — prefixed by a short machine-generated headline. Today's foreground format (keep): `Agent completed in {duration} ({N} tool uses, {tokens}).\n\n{child final message}`. The parent must relay: the result is not visible to the user, and the tool description says so verbatim (already present: "When the agent is done, it returns a single message back to you. The result is not visible to the user — to show the user, send a text message with a concise summary."). Trust stance (vendored, keep): "Trust but verify: an agent's summary describes what it intended to do, not necessarily what it did" — the parent checks claimed edits before reporting done.

New in this spec: an inline-result cap. The child's final message is unbounded today; a verbose child re-creates the context-pollution problem in one shot. Add `maxInlineResultChars` (default `100_000` chars, `0` = unlimited) applied to foreground spawn and foreground resume results (and the nested `formatRecord` path in `nested-tools.ts`): when exceeded, truncate and append `[Result truncated at {N} chars — use get_subagent_result with agent id {id} for the full output{, or read {output-file path}}]`. Background path already truncates its notification preview and defers to `get_subagent_result` (unchanged). No OpenCode-style XML envelope: the headline-plus-text form is already shipped and tested; an envelope would churn every consumer for no behavioral gain.

### Agent types

Registry merges embedded defaults with user Markdown files (case-insensitive names; same name overrides; per-file `enabled: false` disables). Defaults stay the vendored three (kept intentionally — the dossier's "only two" advice saves one description entry; removing `Plan` is churn against intentional upstream functionality):

- **`general-purpose`** — all built-in tools plus extension/skill tools; empty `systemPrompt` with `promptMode: "append"` (inherits pi's standard system prompt).
- **`Explore`** (read-only) — **hardened in this spec** to exactly pi's existing read-only tool set: `read`, `grep`, `find`, `ls` (`createReadOnlyTools` in `packages/coding-agent/src/core/tools/index.ts` line 204). Today it also includes `bash`, which is read-only only by prompt text — an allowlist that includes a full shell is not a read-only agent. `bash` is removed; the system prompt's "Use Bash ONLY for read-only operations: ls, git status, ..." lines are replaced with instructions to use `grep`/`find`/`read`. Users who need git access define `.yupi/agents/my-explorer.md` with `tools: read, grep, find, ls, bash` (documented trade-off, not silent behavior). Keep the description's breadth parameter ("quick" / "medium" / "very thorough") and the "locates code, doesn't audit it" caveat verbatim — cross-harness best practice.
- **`Plan`** (read-only) — same hardening as `Explore` (drop `bash`, keep the "Critical Files for Implementation" output format).

User-defined agents: `.yupi/agents/*.md` (project) and `<agentDir>/agents/*.md` (global, `getAgentDir()`); frontmatter fields supported (existing, unchanged): `name`, `display_name`, `description`, `color`, `tools` (CSV; `ext:` entries select extension tools), `disallowed_tools`, `extensions`, `exclude_extensions`, `skills`, `model`, `thinking`, `max_turns`, `persist_session`, `output_transcript`, `session_dir`, `allowed_subagents`, `system prompt body`, `prompt_mode` (replace/append), `inherit_context`, `run_in_background`, `isolated`, `memory`, `isolation`, `enabled`. A `tools` list that names no known built-in warns at spawn (existing behavior); keep.

Dispatch policy (changed in this spec): a caller-supplied `subagent_type` that does not resolve to exactly one enabled agent **fails closed** with `Unknown or disabled agent type: "{raw}". Available: ...` instead of silently running all-tools `general-purpose`. Rationale: a typo'd type falling back to an unrestricted agent is a tool-restriction bypass (ask for `explrer`, get full write access). The `fallbackSubagent` setting remains the escape hatch (set it to `general-purpose` to restore old behavior, or to any agent name); only the *unset* default changes. The nested path (`resolveEnabledTypeIn`) is already strict.

### How a child run maps onto pi's architecture

Verified against source; the implementing agent should re-read these files:

1. Parent turn: pi's agent loop (`packages/agent/src/agent-loop.ts`, driven by `Agent` from `@earendil-works/pi-agent-core`) validates the `Agent` tool call args and, because `ToolExecutionMode` defaults to `"parallel"` (`packages/agent/src/types.ts` line 42), multiple `Agent` calls in one assistant message execute concurrently — no extra work needed for parallel delegation.
2. `Agent.execute` (`vendor/pi-subagents/src/index.ts` ~1771) resolves the type and invocation config (`invocation-config.ts`), resolves the model against the parent's `ctx.modelRegistry` (`model-resolver.ts`; parent `ctx.model` is the default), then calls `AgentManager.spawnAndWait` (foreground) or `spawn` (background) → `runAgent` in `vendor/pi-subagents/src/agent-runner.ts`.
3. `runAgent` builds the child as a real pi session: a fresh `DefaultResourceLoader` with `systemPromptOverride` (the agent-type prompt, built by `buildAgentPrompt` honoring `promptMode` replace/append), `noContextFiles`, `noPromptTemplates`; a `SessionManager.inMemory` by default (or a persisted session when `persist_session`/`rememberAgents`); then `createAgentSession(sessionOpts)` from `packages/coding-agent/src/core/sdk.ts` line 173. `createAgentSession` constructs the core `Agent` (agent-loop) whose `streamFn` routes through `modelRuntime.streamSimple` — i.e. children use the same `packages/ai` providers and auth as the parent; no separate provider stack.
4. Tool restriction is enforced at the session/registry level, not the prompt: built-ins the type did not ask for and all orchestration tools (`EXCLUDED_TOOL_NAMES` = `Agent`, `SubagentWorkflow`, `get_subagent_result`, `steer_subagent`, `agent-runner.ts` line 41-49) are denied via `tools`/`excludeTools` on `createAgentSession`; nested delegation tools are only injected when the agent file opts in via `allowed_subagents` (`agent-runner.ts` ~828-850, `nested-tools.ts` `createNestedSubagentTools`).
5. The child is driven with `session.prompt(params.prompt)`; the child's final assistant text becomes `record.result` and the tool result (contract above). Steering/resume reuse `AgentSession.steer` (`agent-session.ts` line 1425) and stored session files.

### Recursion / depth guards

Already implemented; keep exactly: (a) registry denial — child sessions never see `Agent`/`SubagentWorkflow`/`get_subagent_result`/`steer_subagent` unless the agent's frontmatter sets `allowed_subagents` ("all" or a type list), in which case ownership-scoped nested variants of the three delegation tools are injected; (b) hard depth cap `maxSubagentDepth` (default 2; `0`/`1` = nesting off) checked in the nested tool's execute (`nested-tools.ts` ~199: `Nested subagent call blocked (depth=..., max=...)`); (c) nested spawns default to foreground (`defaultRunInBackground: false` in the nested path) so a detached child cannot be killed by its parent settling. This is OpenCode's belt-and-braces strategy, already in place.

### Context-size caps

Existing mechanisms (keep, document): `max_turns` per call/agent; `defaultMaxTurns` + `graceTurns` settings (`0` = unlimited turns — the default); per-child session compaction (children are full `AgentSession`s, so pi's auto-compaction applies; the vendored code tracks `compactionCount`); concurrency pools `maxConcurrent` (background) and `maxConcurrentForeground`; output transcripts spooled under the session's tasks dir (`output-file.ts`) so transcripts never enter the model context. New: `maxInlineResultChars` (above). No new turn-count default is introduced — `defaultMaxTurns: 0` (unlimited) stays; a numeric default would silently truncate legitimate long runs, and the depth/concurrency/result caps already bound the blast radius.

### System-prompt additions (literal text)

Mechanism: `ToolDefinition.promptSnippet` / `promptGuidelines` (`packages/coding-agent/src/core/extensions/types.ts` lines 458-461) flow through `AgentSession._rebuildSystemPrompt` (`agent-session.ts` line 1061) into `buildSystemPrompt`'s Guidelines section (`packages/coding-agent/src/core/system-prompt.ts` lines 114-119). The vendored tool already registers the required set; it is the baseline this spec mandates (verbatim, already in `vendor/pi-subagents/src/index.ts` lines 1589-1595):

```text
promptSnippet: "Launch autonomous sub-agents for complex multi-step tasks"

promptGuidelines:
"Use Agent with specialized agents when the task matches an agent type's description. Subagents are valuable for parallelizing independent queries or for protecting the main context window from excessive results, but should not be used excessively when not needed. Importantly, avoid duplicating work that subagents are already doing — if you delegate research to a subagent, do not also perform the same searches yourself."
"For broad codebase exploration or research, spawn Agent with an appropriate subagent_type (e.g. Explore). Otherwise use direct tools (read, grep, find) when the target is already known."
"When an agent runs in the background, you will be notified on completion — do not poll or sleep waiting for it. Continue with other work instead."
"Trust but verify: an agent's summary describes intent, not outcome. When an agent writes or edits code, check the actual changes before reporting the work as done."
```

No additional guidelines are introduced (the tool description body already carries the full contract: self-contained prompts, single-message parallelism, result-not-visible, write-code-vs-research, resume/steer). Child-side system prompts: `Explore`/`Plan` keep their read-only preamble (edited only to remove the bash instructions per the hardening above); `general-purpose` inherits pi's standard prompt.

### TUI rendering of running children

Already implemented via the standard tool renderer hooks on the `ToolDefinition` (`renderCall`/`renderResult`, `extensions/types.ts` lines 491-499): a colored type badge + description call line; a spinner + live stats line ("model · turns · tool uses · tokens") plus current activity while running; result states for background-started (id line), completed (check + duration + expandable result preview capped at 50 lines), stopped, and error. A persistent widget/fleet list shows background/queued agents below the editor (`widgetMode`/`fleetView` settings). Foreground progress streams through `onUpdate` partials of `AgentToolResult`. No TUI work is in scope; tests assert tool-result content, not pixels.

### Config surface

- `<cwd>/.yupi/subagents.json` (project, written by `/agents` → Settings) over `~/.yupi/agent/subagents.json` (global, hand-edited). Existing keys (unchanged): `maxConcurrent`, `maxConcurrentForeground`, `defaultMaxTurns`, `graceTurns`, `backgroundByDefault` (default true), `schedulingEnabled`, `scopeModels`, `strictAgentFiles`, `disableDefaultAgents`, `toolDescriptionMode` (full/compact/custom), `fleetView`, `widgetMode`, `mentionMode`, `joinMode`, `viewerMarkdown`, `fallbackSubagent`, `rememberAgents`, `outputTranscript`, `showCost`, `maxSubagentDepth`, `enabledModels` scoping, `worktreeIsolation`, scheduling options.
- New keys: `enabled` (boolean, default true — master kill switch for the whole extension; see implementation plan) and `maxInlineResultChars` (number, default 100000, `0` = unlimited, validated 0..2000000).
- Agent files: `.yupi/agents/*.md`, `<agentDir>/agents/*.md` (frontmatter listed above).
- Existing `--no-extensions` / `-ne` (`packages/coding-agent/src/cli/args.ts` line 169) already removes the extension along with all others; unchanged.

### Out of scope

- Claude-Code-style injection scanning of child output for "instruction-shaped patterns" (`core/output-guard.ts` is stdout-takeover machinery, unrelated; building a scanner is a separate feature — open question below).
- Permission gating of the spawn itself (pi has no permission system today; revisit with one).
- Worktree isolation, scheduling, workflows (`SubagentWorkflow`), `@mention` routing, memory directories, structured output — all shipped in the vendor tree; this spec changes none of them.
- Changing `run_in_background` default, the XML result envelope, OpenCode-style child-session TUI navigation keys, `mode: primary|subagent|all` primary-agent switching.
- Promoting any of this into `packages/agent` core or adding new user-facing docs files (repo rule: no proactive `*.md`; the `/agents` settings UI and CHANGELOG are the surfaces).

## Implementation plan

Ordered. Steps 1-4 are the actual deltas; step 0 is verified-existing inventory requiring no work. All TypeScript shown is erasable-syntax-only (no enums, namespaces, parameter properties, `import =`).

### Step 0 — already implemented (no work; do not duplicate)

Everything listed in "Proposed design" as existing: tool + schema + contract text; default/custom agent registry and `.md` loading; child session construction over `createAgentSession`; registry-level tool restriction and orchestration-tool denial; nested-tools depth guard; model resolution with fail-without-substitution; background/foreground paths, resume/steer, notifications; TUI rendering + widget/fleet; usage accounting; `resource-loader.ts` injection (lines ~455, ~562) and package `files` entry; tests `test/bundled-subagents.test.ts` and `test/suite/bundled-subagents.test.ts`; CHANGELOG `[Unreleased] → Added` entry for the bundle.

### Step 1 — kill switch (`enabled: false`)

Problem: the extension is injectable only by nuking all extensions (`--no-extensions`). Fix inside the vendor tree; no `resource-loader.ts` behavior change (add a one-line comment at each injection site naming the bundled extension so the hardwiring is explicit).

1. `vendor/pi-subagents/src/settings.ts`: add `enabled?: boolean;` to `SubagentsSettings`; parse it alongside the other booleans (the `typeof r.X === "boolean"` block around line 399).
2. `vendor/pi-subagents/src/index.ts`: in the extension entry (the factory receiving `ExtensionAPI`), after `applyAndEmitLoaded(loadSettings(...))` runs, if the effective `enabled === false`, return without registering tools, commands, or event handlers. Sketch:

```ts
const settings = loadSettings(cwd);
applyAndEmitLoaded(settings, appliers);
if (settings.enabled === false) {
  return; // registered nothing; next pi session with enabled !== false restores
}
```

The setting is read at load time (like `toolDescriptionMode`); flipping it requires a restart. Global-then-project merge order stays as-is.

### Step 2 — read-only hardening of `Explore` and `Plan`

`vendor/pi-subagents/src/default-agents.ts`:

1. Line 9: `const READ_ONLY_TOOLS = ["read", "grep", "find", "ls"];` (drop `"bash"`). This now equals `createReadOnlyTools(".")` names exactly — the type is literally "built from pi's existing tool set".
2. In the `Explore` `systemPrompt` (lines 39-66): remove the two "Use Bash ONLY for read-only operations..." bullets and the "Running ANY commands" prohibition framing; state positively: "You have no shell access. Use the find tool for file patterns, grep for content search, read for file contents. Make independent tool calls in parallel." Keep the read-only prohibition preamble, absolute-path and breadth wording.
3. Same edit for `Plan`'s `systemPrompt` (lines 80-119).

`vendor/pi-subagents/src/agent-types.ts` needs no change (`BUILTIN_TOOL_NAMES` derives names from `createCodingTools`/`createReadOnlyTools`, so `bash` remains available to custom agents).

### Step 3 — fail-closed dispatch default

`vendor/pi-subagents/src/settings.ts`, in the settings-load path (where `fallbackSubagent` is applied to `setFallbackSubagent`, near line 533's appliers): when neither project nor global `subagents.json` defines `fallbackSubagent`, apply `NO_FALLBACK` ("none") instead of leaving it unset. `agent-types.ts` `resolveSpawnType` (lines 174-219) already implements the `"none"` semantics (`Unknown or disabled agent type: "{raw}". Available: ...`); only the unset default changes. Do not delete the upstream `#183` comment; add a note that the yupi bundle defaults to fail-closed and the setting restores the fallback. Explicit `fallbackSubagent: general-purpose` in `subagents.json` must behave exactly as before (covered by a test).

### Step 4 — inline result cap

1. `vendor/pi-subagents/src/settings.ts`: add `maxInlineResultChars?: number` to `SubagentsSettings` (default 100000; validate integer 0..2000000, `0` = unlimited) and apply it via a module getter/setter pair following the `defaultMaxTurns` pattern in `agent-runner.ts` (lines 313-322).
2. New small helper `vendor/pi-subagents/src/result-cap.ts`:

```ts
export interface CappedResult {
  text: string;
  truncated: boolean;
}

export function capResultText(
  text: string,
  limit: number,
  fullRetrievalHint: (agentId: string, outputFile?: string) => string,
  agentId: string,
  outputFile?: string,
): CappedResult {
  if (limit <= 0 || text.length <= limit) return { text, truncated: false };
  return {
    text: text.slice(0, limit) + "\n\n" + fullRetrievalHint(agentId, outputFile),
    truncated: true,
  };
}
```

3. Apply at three sites: foreground spawn return and foreground resume return in `vendor/pi-subagents/src/index.ts` (the `record.result?.trim() || "No output."` expressions at ~line 2034 and ~2269 — the record carries `id` and `outputFile`), and the success branch of `formatRecord` in `nested-tools.ts` (line 132; pass the child record's id/outputFile). The hint text: `use get_subagent_result with agent id {id} for the full output` (+ `, or read {path}` when an output transcript exists). `get_subagent_result`'s own return stays uncut.

### Step 5 — tests and changelog

Per the testing plan below; then append the CHANGELOG entries (drafted below) to the existing `## [Unreleased]` subsections in `packages/coding-agent/CHANGELOG.md` (read the section first; never duplicate subsections). Run `npm run check` after code changes (repo rule); run the new tests via `./scripts/test.sh` or targeted vitest from the package root.

## Testing plan

All agent-level tests use `packages/coding-agent/test/suite/harness.ts` (`createHarness`) with the faux provider and `fauxAssistantMessage`/`fauxToolCall` from `@earendil-works/pi-ai/compat`, following the pattern proven in `test/suite/bundled-subagents.test.ts` (DefaultResourceLoader + `YUPI_CODING_AGENT_DIR` stub + scripted responses shared across parent and child model calls). No real providers, keys, or paid tokens. To keep temp dirs clean, write a project `.yupi/subagents.json` with `{"rememberAgents": false, "outputTranscript": false}` (or set `persist_session: false` / `output_transcript: false` in the test agent files, as the existing suite test does). Run non-e2e tests with `./scripts/test.sh` from the repo root.

1. `packages/coding-agent/test/bundled-subagents.test.ts` (extend, loader-level):
   - Kill switch: create `<cwd>/.yupi/subagents.json` with `{"enabled": false}`; after `loader.reload()`, no extension exposes an `Agent` tool and no `agents` command is registered; `errors` stays empty. Contrast case (existing test already covers default-on).
2. `packages/coding-agent/test/suite/subagents-delegation-roundtrip.test.ts` (new):
   - Delegation round-trip: write a temp file; parent response calls `Agent` with `subagent_type: "general-purpose"`, `run_in_background: false`; child response calls `read` on the temp file, then a second child response returns "FOUND: <marker>"; final parent response is a plain summary. Assert: a `toolResult` message in the parent session contains both "Agent completed in" and "FOUND: <marker>"; the parent's last assistant message relays the finding; **context isolation** — the child's `read` tool result (file contents) does NOT appear anywhere in `harness.session.messages`; `harness.getPendingResponseCount() === 0`.
3. `packages/coding-agent/test/suite/subagents-explore-readonly.test.ts` (new):
   - Tool restriction on the explore type: parent spawns `Explore` foreground; scripted child response calls `write` (target inside `harness.tempDir`); assert that tool call resolves to an error result for the child (write is not in its tool set), the target file is never created on disk, and the parent's `Agent` tool result still completes with the child's follow-up final message. Repeat the unavailable-tool assertion for `bash`. Positive control: a child `grep` call succeeds.
4. `packages/coding-agent/test/suite/subagents-recursion-guard.test.ts` (new):
   - Recursion guard: project `subagents.json` with `{"maxSubagentDepth": 1}`; agent file `.yupi/agents/worker.md` with `allowed_subagents: all` and `tools: read`; parent spawns `worker`; scripted worker response calls the nested `Agent` tool. Assert the call fails (error tool result in the child's transcript: depth/registry rejection) and no grandchild model call is consumed (`getPendingResponseCount` unchanged). Second case: default depth (2) — a depth-1 worker may spawn a depth-2 child whose final message flows back through the nested result format.
5. `packages/coding-agent/test/suite/subagents-dispatch.test.ts` (new):
   - Fail-closed dispatch: parent calls `Agent` with `subagent_type: "explrer"` (typo). Assert error tool result matching `/Unknown or disabled agent type: "explrer"/` listing available types, and that no child model call ran. Escape hatch: same typo with project `subagents.json` `{"fallbackSubagent": "general-purpose"}` spawns general-purpose and the result includes the fallback note naming the requested type.
6. `packages/coding-agent/test/suite/subagents-result-cap.test.ts` (new):
   - Result cap: project `subagents.json` with `{"maxInlineResultChars": 1000}`; child's final message is 5000 chars. Foreground `Agent` result is truncated to 1000 chars plus the `get_subagent_result ... agent id {id}` hint; a follow-up scripted parent call to `get_subagent_result` with that id returns the full 5000-char text. Also assert `maxInlineResultChars: 0` disables truncation.
7. Keep green: `test/bundled-subagents.test.ts`, `test/suite/bundled-subagents.test.ts`, `test/resource-loader.test.ts`, `test/suite/regressions/*` touched by resource-loader changes (none expected beyond the added comment).

## Changelog

Draft entries for `packages/coding-agent/CHANGELOG.md`, appended to the existing `## [Unreleased]` subsections (entries 1-3 below assume the bundled-extension Added entry from the concurrent session is already present; entry 4 amends it only if that session has not landed — otherwise skip the amendment):

### Added

- Added an `enabled: false` master switch for the bundled subagents extension in `.yupi/subagents.json` (global `~/.yupi/agent/subagents.json` as default), disabling the `Agent` tool, its satellite tools, and the `/agents` command without `--no-extensions`.
- Added `maxInlineResultChars` subagents setting (default 100000, `0` = unlimited) that truncates oversized foreground subagent results and points at `get_subagent_result` for the full output.

### Changed

- Made the bundled `Explore` and `Plan` subagents strictly read-only: their tool set is now `read`, `grep`, `find`, `ls` (matching pi's read-only tools) with no shell access, instead of relying on prompt instructions to keep `bash` read-only. Add `bash` back via a custom agent in `.yupi/agents/` if needed.
- Made unknown or disabled `subagent_type` values fail with an error instead of falling back to the unrestricted `general-purpose` agent. Set `fallbackSubagent` in `.yupi/subagents.json` to restore the previous fallback behavior.

## Risks and open questions

- **Vendor divergence.** Steps 1-4 edit vendored upstream code; future upstream syncs get conflict-prone. Mitigation: keep edits small and commented (follow the file's existing comment style, which already documents local decisions and upstream issue numbers), and record each divergence in the vendor README's modifications section if one exists.
- **`bash` removal from `Explore`/`Plan` changes behavior** for prompts relying on `git log`/`git diff` answers. Accepted: enforcement beats prompt promises (Cursor's `readonly` bar); documented custom-agent escape hatch. If maintainers disagree, the alternative is a spawn-hook bash guard (`BashToolOptions.spawnHook` can throw on mutating commands), which is more code and weaker.
- **Fail-closed default** diverges from upstream's #183 decision. Escape hatch ships in the same change; risk is limited to model-visible error text instead of silent misdispatch.
- **Inline cap could hide payload** a caller legitimately wanted inline. Mitigated by `get_subagent_result`, the id in the notice, the `0` opt-out, and a generous default (100k chars ≈ 25k tokens).
- **Open: injection scanning.** Child agents read untrusted repo/web content; their final message enters the parent's context with elevated credibility. Claude Code scans for "instruction-shaped patterns"; yupi has nothing equivalent (`core/output-guard.ts` is stdout takeover). Decide as a separate feature.
- **Open: permission surface.** Nothing gates who may spawn which agent type (OpenCode `permission.task`). Depends on pi growing a permission system; not this spec.
- **Open: user docs.** The extension is documented only via the tool description, `/agents` UI, and CHANGELOG. Repo rules forbid proactively creating docs files; maintainers should decide whether a docs page is wanted.
- **Open: `Plan` default.** Dossier advises two defaults (general-purpose + explore); this spec keeps `Plan` because it is intentional upstream functionality and one extra description line is cheap. Revisit if the tool-description budget matters for small models (the `toolDescriptionMode: "compact"` mode already mitigates).

## Acceptance criteria

- [ ] `Agent` tool is registered by default with the exact parameter contract above; `test/bundled-subagents.test.ts` passes unchanged (default-on case).
- [ ] `.yupi/subagents.json` `{"enabled": false}` removes the `Agent`, `get_subagent_result`, `steer_subagent` tools and the `/agents` command on next start; covered by a loader-level test.
- [ ] Foreground delegation round-trip: parent receives headline + child final message only; child's intermediate tool results never appear in the parent transcript (tested).
- [ ] `Explore` and `Plan` children cannot invoke `write`, `edit`, or `bash` (registry-level; tested by scripted failed calls and no on-disk effect); `read`/`grep`/`find`/`ls` work.
- [ ] Unknown or disabled `subagent_type` produces an error result listing available types with no spawn; `fallbackSubagent` setting still overrides (both directions tested).
- [ ] Recursion: with `maxSubagentDepth: 1`, a child's nested `Agent` call fails without consuming a grandchild model call; default depth 2 permits one nested level.
- [ ] Foreground results longer than `maxInlineResultChars` are truncated with an id-bearing retrieval hint; `get_subagent_result` returns the full text; `0` disables.
- [ ] Multiple `Agent` calls in one assistant message run concurrently (existing parallel tool execution; exercised by the round-trip test with two children and asserted via response ordering).
- [ ] `npm run check` passes clean; all new tests pass under `./scripts/test.sh`; no real provider is used anywhere in the new tests.
- [ ] CHANGELOG `[Unreleased]` gains the drafted entries without duplicating existing subsections; no other package's changelog is touched.
