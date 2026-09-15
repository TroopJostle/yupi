# Research dossier: subagent delegation in production coding-agent harnesses

## Summary

Subagent delegation is a harness tool (universally named `Task` or `Agent`, except Gemini CLI which exposes each subagent as its own tool) that spawns a child agent loop with a fresh context window, a per-type system prompt, and a restricted toolset. The parent's prompt must be self-contained; the child's final message is returned to the parent as the tool result and is invisible to the user; multiple calls in one assistant message run concurrently. All major harnesses converged on markdown files with YAML frontmatter as the agent-definition surface, and all ship a read-only "explore/research" default agent. Note: pi already ships a full vendored implementation (`packages/coding-agent/vendor/pi-subagents`, ~12.4k lines) — see "Design takeaways".

## Findings by harness

### Claude Code

Tool: `Task`, renamed to `Agent` in v2.1.63 ("In version 2.1.63, the Task tool was renamed to Agent"). Source: https://code.claude.com/docs/en/sub-agents

Parameter schema (verbatim, from a leaked/reconstructed tools dump of the Claude Code 2.0 era — https://raw.githubusercontent.com/x1xhlol/system-prompts-and-models-of-ai-tools/main/Anthropic/Claude%20Code/Tools.json):

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

Verbatim prompt-contract language (same leaked dump; the original 2.0-era description):

- "Launch a new agent to handle complex, multi-step tasks autonomously."
- "When NOT to use the Agent tool: If you want to read a specific file path, use the Read or Glob tool instead... If you are searching for a specific class definition like \"class Foo\", use the Glob tool instead... If you are searching for code within a specific file or set of 2-3 files, use the Read tool instead..."
- "1. Launch multiple agents concurrently whenever possible, to maximize performance; to do that, use a single message with multiple tool uses"
- "2. When the agent is done, it will return a single message back to you. The result returned by the agent is not visible to the user. To show the user the result, you should send a text message back to the user with a concise summary of the result."
- "3. Each agent invocation is stateless. You will not be able to send additional messages to the agent, nor will the agent be able to communicate with you outside of its final report. Therefore, your prompt should contain a highly detailed task description for the agent to perform autonomously and you should specify exactly what information the agent should return back to you in its final and only message to you."
- "4. The agent's outputs should generally be trusted"
- "5. Clearly tell the agent whether you expect it to write code or just to do research (search, file reads, web fetches, etc.), since it is not aware of the user's intent"
- "6. If the agent description mentions that it should be used proactively, then you should try your best to use it without waiting for the user having to ask for it first. Use your judgement."

Definition surface: Markdown + YAML frontmatter; body = system prompt. Locations (highest priority first): managed `.claude/agents/` (org), `--agents` CLI flag (session JSON), `.claude/agents/` (project, scanned recursively and up to repo root), `~/.claude/agents/` (user), plugin `agents/` dirs (scoped IDs like `my-plugin:review:security`). Frontmatter: required `name`, `description`; optional `tools`, `disallowedTools`, `model`, `permissionMode`, `maxTurns`, `skills`, `mcpServers`, `hooks`, `memory`, `background`, `effort`, `isolation` (`worktree`), `color`, `initialPrompt`. Verbatim doc example:

```yaml
name: code-reviewer
description: Reviews code for quality and best practices
tools: Read, Glob, Grep
model: sonnet
```

Semantics (official docs):
- "Each subagent runs in its own context window with a custom system prompt, specific tool access, and independent permissions."
- Fresh (non-fork) subagents receive: own system prompt + environment details, a task message written by the parent, CLAUDE.md files, a git status snapshot, preloaded skills, and a sibling-agent roster. Main-session output styles / auto memory do not carry over. Forks (via `/subtask`) inherit the full conversation.
- "Claude uses each subagent's description to decide when to delegate tasks"; combined descriptions beyond 15,000 tokens trigger a startup warning.
- Nesting: default depth 3 below the main conversation (`CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH`; `1` disables); at the limit the `Agent` tool is withheld from children. Concurrency cap default 20 (`CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS`), error "Concurrent subagent limit reached".
- Always-removed tools for subagents: `AskUserQuestion`, `EnterPlanMode`, `ScheduleWakeup`, `TaskOutput`, `Workflow`, `EndConversation`, `ExitPlanMode` (unless plan mode). Spawning allowlist syntax exists: `tools: Agent(worker, researcher), Read, Bash`.
- If a `tools` list resolves to zero tools, spawn fails with an error naming unresolved entries.
- Model resolution order: invocation param → frontmatter `model` (`sonnet`/`opus`/`haiku`/`fable`/full ID/`inherit`) → `CLAUDE_CODE_SUBAGENT_MODEL` env → main model.
- Results: child "returns only a summary"; completed agents return an agent ID enabling later resume via `SendMessage`. Built-in Explore/Plan agents are one-shot (no ID).
- Output hygiene: subagent output is scanned for "instruction-shaped pattern(s)" before the parent reads it; backslashes are inserted into imitations of system tags.
- Invocation modes: automatic delegation, forced `@agent-<name>` mention, or `claude --agent <name>` (replaces the session's system prompt entirely). Ctrl+B backgrounds a running foreground task.
- Per-agent control: `permissions.deny` entries like `Agent(Explore)`; hooks scoped per agent (`SubagentStart`/`SubagentStop` events); per-agent persistent `memory` directory with auto-injected MEMORY.md (first 200 lines / 25KB).
- Transcripts: `~/.claude/projects/{project}/{sessionId}/subagents/agent-{agentId}.jsonl`.

Source: https://code.claude.com/docs/en/sub-agents and the leaked dump above.

### OpenCode

Tool: `task`. Current schema and description verbatim from source (dev branch): https://raw.githubusercontent.com/sst/opencode/dev/packages/opencode/src/tool/task.ts and .../task.txt

Parameters (verbatim field descriptions from `task.ts`):

- `description`: "A short (3-5 words) description of the task"
- `prompt`: "The task for the agent to perform"
- `subagent_type`: "The type of specialized agent to use for this task"
- `task_id` (optional): "This should only be set if you mean to resume a previous task (you can pass a prior task_id and the task will continue the same subagent session as before instead of creating a fresh one)"
- `background` (optional): "Run the agent in the background. You will be notified when it completes. DO NOT sleep, poll, or proactively check on its progress" — gated behind `OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=true`.

Verbatim prompt-contract language from `task.txt`:

- "When using the Task tool, you must specify a subagent_type parameter to select which agent type to use."
- "1. Launch multiple agents concurrently whenever possible, to maximize performance; to do that, use a single message with multiple tool uses"
- "2. Once you have delegated work to an agent, do not duplicate that work yourself. Continue with non-overlapping tasks, or wait for the result. For background tasks, you will be notified automatically when the result is ready."
- "3. When the agent is done, it will return a single message back to you. The result returned by the agent is not visible to the user. ... The output includes a task_id you can reuse later to continue the same subagent session."
- "4. Each agent invocation starts with a fresh context unless you provide task_id to resume the same subagent session ... your prompt should contain a highly detailed task description ... and you should specify exactly what information the agent should return back to you in its final and only message to you."
- "6. Clearly tell the agent whether you expect it to write code or just to do research ... Tell it how to verify its work if possible (e.g., relevant test commands)."

Implementation details visible in `task.ts` (all verbatim-behavior claims from the source):

- Result envelope: output is wrapped as `<task id="{sessionID}" state="running|completed|error"><summary>...</summary><task_result|task_error>{text}</...></task>`.
- The result text is the child's last text part: `result.parts.findLast((item) => item.type === "text")?.text ?? ""`. If the child's final message errored, or any child tool call ends in status `error`, the parent's tool call fails with `Subagent failed (task_id: ...): {error}`.
- Recursion guard (two layers): (a) depth computed by walking `session.parentID` to the root; `if (depth >= (cfg.subagent_depth ?? 1))` fails with `Subagent depth limit reached (N). Increase "subagent_depth" to allow nested subagents.` — default is 1, i.e. no grandchild agents. (b) Child sessions get automatic tool-denial rules: `todowrite` and `task` are denied (`action: "deny"`, pattern `"*"`) unless the agent's own permission config explicitly allows them — enforcement lives in the tool registry, not the prompt.
- Permission: the spawn itself triggers a permission check `ctx.ask({ permission: "task", patterns: [params.subagent_type], ... })`. Per docs: `permission.task` uses glob patterns, and "When set to deny, the subagent is removed from the Task tool description entirely"; "Users can always invoke any subagent directly via the @ autocomplete menu". `hidden: true` hides a subagent from `@` autocomplete but it "can still be invoked by the model via the Task tool if permissions allow."
- Child sessions are real sessions: `sessions.create({ parentID: ctx.sessionID, title: params.description + " (@{name} subagent)", agent: next.name, permission: [...] })` — parent/child linkage via `parentID`, child permission derived from parent session permission + agent config (`deriveSubagentSessionPermission`). The TUI has keybinds to navigate child sessions (`session_child_first`, `session_parent`, etc.).
- Model: `next.model ?? parent message's model` (subagents inherit the invoking primary's model unless configured).
- Background mode: returns immediately with `state: "running"` plus the text "The task is working in the background. You will be notified automatically when it finishes. DO NOT sleep, poll for progress, ask the task for status, or duplicate this task's work — avoid working with the same files or topics it is using." On completion a synthetic text message containing the wrapped result is injected into the parent session.

Definition surface (docs: https://opencode.ai/docs/agents/): Markdown files, filename = agent name, in `.opencode/agents/` (project) or `~/.config/opencode/agents/` (global). Frontmatter: `description` (required), `mode` (`primary` | `subagent` | `all`, default `all`), `model` (`provider/model-id`; subagents inherit the primary's model when unset), `temperature`, `top_p`, `prompt`, `steps` (caps agentic iterations; legacy `maxSteps` deprecated), `disable`, `hidden`, `color`, `permission` (per-tool `ask`/`allow`/`deny`, with glob keys e.g. `"mcp_*": "deny"`, bash sub-patterns), `tools` (deprecated in favor of `permission`). Body = system prompt. Built-in agents: `build` (primary, default), `plan` (primary, edit/bash ask), `general` (subagent, full tool access except todo — "Use this to run multiple units of work in parallel"), `explore` (subagent, read-only), `scout` (subagent, clones dependency repos into a cache). Hidden system agents run automatically: `compaction`, `title`, `summary`. `opencode agent create` scaffolds a file interactively.

### Gemini CLI

Different model: agent-as-tool. "Subagents are exposed to the main agent as a tool of the same name. When the main agent calls the tool, it delegates the task to the subagent. Once the subagent completes its task, it reports back to the main agent with its findings." There is no generic Task tool with a `subagent_type` param; each agent becomes its own callable tool. Users can force one with `@codebase_investigator ...`; the CLI then "injects a system note that nudges the primary model to use that specific subagent tool immediately". Source (verbatim doc, fetched from repo): https://raw.githubusercontent.com/google-gemini/gemini-cli/main/docs/core/subagents.md

Built-in subagents: `codebase_investigator` (analyze/reverse-engineer code), `cli_help` (Gemini CLI self-knowledge), `generalist` ("A general, all-purpose subagent that uses the inherited tool access and configurations from the main agent ... optimizing your main agent's context by returning only the final result of that given task" — for multi-file modifications, high-volume command output, action-oriented research), `browser_agent` (accessibility-tree browser automation via bundled `chrome-devtools-mcp`), plus a visual agent behind `visualModel`. Overrides in `settings.json` via `agents.overrides` (`enabled`, `runConfig.maxTurns`, `runConfig.maxTimeMinutes`).

Custom agents: Markdown + YAML frontmatter; body = system prompt; in `.gemini/agents/*.md` (project) or `~/.gemini/agents/*.md` (user). Frontmatter fields (verbatim table from doc):

| field | type | required | semantics |
|---|---|---|---|
| `name` | string | yes | identifier |
| `description` | string | yes | drives delegation |
| `kind` | string | no | `local` (default) or `remote` (A2A protocol) |
| `tools` | array | no | tool allowlist; wildcards `*`, `mcp_*`, `mcp_server_*`; "If omitted, it inherits all tools from the parent session" |
| `mcpServers` | object | no | inline MCP servers isolated to this agent |
| `model` | string | no | "Defaults to `inherit` (uses the main session model)" |
| `temperature` | number | no | 0.0–2.0, default 1 |
| `max_turns` | number | no | "Maximum number of conversation turns allowed for this agent before it must return. Defaults to `30`." |
| `timeout_mins` | number | no | "Defaults to `10`." |

Isolation and guards (verbatim): "Each subagent runs in its own isolated context loop"; "Independent history: the subagent's conversation history does not bloat the main agent's context"; "Recursion protection: To prevent infinite loops and excessive token usage, subagents cannot call other subagents. If a subagent is granted the `*` tool wildcard, it will still be unable to see or invoke other agents." The Policy Engine treats subagents as virtual tool names (TOML `[[rule]] toolName = "codebase_investigator" decision = "deny"`), and policy rules can be scoped per-subagent via a `subagent` property. Subagents are enabled by default; disable with `"experimental": { "enableAgents": false }`. Extensions can bundle subagents. Remote subagents via Agent2Agent protocol.

### OpenAI Codex CLI

No subagent delegation feature. Verified two ways: (a) the `docs/` directory of github.com/openai/codex (15 files: config, exec, sandbox, skills, slash_commands, agents_md.md, etc.) contains no multi-agent/subagent/orchestration/"collab" documentation — `agents_md.md` covers the AGENTS.md instruction-file convention; (b) `docs/config.md` contains no config keys for agent spawning, delegation, or subagents. Sources: https://github.com/openai/codex/tree/main/docs and https://raw.githubusercontent.com/openai/codex/main/docs/config.md. The only delegation path is user-level: running separate `codex exec` processes orchestrated by scripts/CI (not a harness feature).

### Amp

Built-in specialist subagents named in docs: **Search** ("retrieves relevant code quickly"), **Oracle** ("handles difficult reasoning and planning questions"), **Librarian** ("researches external codebases and large bodies of source material"), **Read Thread** ("reads and summarizes other Amp threads"). Source: https://ampcode.com/docs/models-and-subagents

Delegation semantics (verbatim): "Amp chooses subagents automatically for suitable tasks, mostly in medium mode but occasionally in other modes"; users can request a specific subagent or "split independent work across several subagents". Context isolation (verbatim): "Each subagent has its own context window and access to tools like file editing and terminal commands"; subagents "work in isolation, so they can't communicate with each other, you can't guide them mid-task"; they "start with the instructions and context the main agent gives them rather than the full conversation". Result return (verbatim): "The main agent only receives their final summary rather than monitoring their step-by-step work." Custom subagents are defined via the plugin system: a custom subagent "can be exposed as a tool that the main agent calls for a specific kind of work" (custom modes also appear in the mode picker). Note: the older `ampcode.com/agents` / `/agents-guide` pages are now auth-gated and not in the Wayback Machine; the `/docs/models-and-subagents` page above is the current public source.

### Cursor

Definition surface: one Markdown file per subagent in `.cursor/agents/` (project) or `~/.cursor/agents/` (user); also reads `.claude/agents/` and `.codex/agents/` for compatibility, with "`.cursor/` takes precedence over `.claude/` or `.codex/`". Source: https://cursor.com/docs/subagents

Frontmatter (all optional): `name` (defaults to filename), `description` (drives automatic delegation; docs advise phrases like "use proactively" or "always use for"), `model` (`inherit` default, a model ID, or ID with bracket params like `claude-opus-5[effort=high,context=300k]`), `readonly` (default false; "Blocks file edits and state-changing shell commands"), `is_background` (default false; runs without blocking the parent). Verbatim example:

```markdown
---
name: security-auditor
description: Security specialist. Use when implementing auth, payments, or handling sensitive data.
model: inherit
readonly: true
---
```

Semantics: each subagent "runs in its own context window starting clean"; the parent must "include relevant information in the prompt since subagents don't have access to prior conversation history". Foreground blocks the parent until done; background returns immediately, writes state to `~/.cursor/subagents/` as it runs, persists output, and can be resumed by agent ID ("Resume agent abc123 and analyze the remaining test failures"). Parallelism: the parent "sends multiple Task tool calls in a single message, so subagents run simultaneously." Nesting limit: a subagent launched by another subagent cannot spawn further subagents (since Cursor 2.5). Optional isolation gives each subagent its own git worktree or cloud VM/branch, merged by the parent. Cost warning in docs: "five parallel subagents ≈ 5× a single agent's usage". Explicit invocation via slash syntax (`/verifier confirm the auth flow is complete`).

### ZCode (firsthand — exact semantics, not fetched)

The orchestrator of this research runs inside ZCode, so these are authoritative observations:

- Agent tool params: `{ subagent_type, prompt, description (3-5 words), run_in_background }`.
- Shipped types: `general-purpose` (all tools), `Explore` (read-only: Read, Bash, WebFetch, WebSearch, TodoWrite; "reads excerpts rather than whole files, so it locates code; it doesn't review or audit"; caller specifies breadth `medium` / `very thorough`), `judge` (read-only visual acceptance).
- Contract stated in the tool description: prompt must be self-contained ("child starts fresh, no conversation carryover"); the child's final message returns to the parent as the tool result and is NOT shown to the user — the parent must relay what matters; multiple agents for independent work go in a single message with multiple tool uses to run concurrently; "once you've delegated a search, don't also run it yourself — wait for the result"; `run_in_background: true` runs async and notifies on completion; agents can be resumed by agentId.

### pi today (local repo — important context for the spec)

pi already ships a complete subagent implementation as a vendored extension: `packages/coding-agent/vendor/pi-subagents/` (vendored from TroopJostle/pi-subagents, a fork of tintinweb/pi-subagents, upstream rev e955e29c, 0.19.0; ~12.4k lines of TS). It is loaded unconditionally by the resource loader (`packages/coding-agent/src/core/resource-loader.ts` lines ~455 and ~562 hardwire `vendor/pi-subagents/src/index.ts` into the extension path list unless `--no-extensions`).

What it already implements (observed in source):

- An `Agent` tool (`vendor/pi-subagents/src/index.ts` ~line 1585) with parameters: `prompt`, `description`, `name` (memorable alias for `@mention`/steer), `subagent_type`, `model` (provider/modelId or fuzzy; "Unavailable models fail without substitution"), `thinking`, `max_turns`, `run_in_background` (defaults true; `false` blocks and returns full output inline), `resume` (agent ID), `isolated` (no extension/MCP tools), `inherit_context` (fork parent conversation), plus optional worktree isolation and scheduling params.
- Tool description text closely tracking the Claude Code/ZCode contract: parallel calls in one message; result not visible to the user; "Trust but verify"; "Never fabricate or predict a pending agent's results"; background-by-default with completion notification; "resume continues a previous agent by ID; steer_subagent messages a running one"; a "Writing the prompt" section ("Brief the agent like a smart colleague who just walked into the room"; "Terse command-style prompts produce shallow, generic work"; "**Never delegate understanding.**"). Tool description has compact/full/custom modes (custom via `.yupi/agent-tool-description.md` with `{{typeList}}`-style placeholders).
- Default agents (`vendor/pi-subagents/src/default-agents.ts`): general-purpose, a read-only search agent ("Fast read-only search agent for locating code ... specify search breadth: quick / medium / very thorough ... it reads excerpts rather than whole files and will miss content past its read window"), and a planner agent. User agents: `.yupi/agents/*.md` and `.agents/agents/*.md` + global dir; same-name overrides; `fallbackSubagent` dispatch setting (`none` = fail closed).
- Also present: nested-tools handling, cross-extension RPC spawn surface, scheduler, worktree isolation, agent memory, output-file for large results, status notes for the TUI, usage accounting.

## Gaps and pitfalls

- **Token cost.** Every child burns a full context window; Cursor's docs state the cost model plainly: five parallel subagents ≈ 5× a single agent's usage. Also, all agent `description` frontmatter fields are injected into the parent's tool description; Claude Code warns when combined descriptions exceed 15,000 tokens. A big agent zoo taxes every parent turn even when unused.
- **Prompt self-containment failures.** The single largest behavioral failure mode. All harnesses dedicate description text to it (Claude Code "highly detailed task description ... specify exactly what information the agent should return"; pi vendored "Brief the agent like a smart colleague who just walked into the room"; Cursor "subagents don't have access to prior conversation history"). Terse prompts produce shallow work; "based on your findings, fix the bug" anti-pattern pushes synthesis onto the child.
- **Parent duplicating delegated work.** Racing the child wastes tokens and can conflict on the same files. OpenCode's usage note 2 and ZCode's "don't also run it yourself" line address this directly; OpenCode's background-mode result text repeats "DO NOT ... duplicate this task's work — avoid working with the same files or topics it is using."
- **Result relay and trust.** The child's final message is invisible to the user; the parent must summarize. Trust stances differ: Claude Code 2.0-era text said "outputs should generally be trusted"; pi's vendored version inverts this ("Trust but verify ... check the actual changes before reporting the work as done"). Verification matters most when the child edits code.
- **Result size.** Only the final message returns, but it is unbounded. OpenCode wraps it in an XML envelope with the child session id and state; pi's vendored code has an `output-file.ts` (large outputs spooled to a file) and `max_turns`. Unbounded final messages can still blow the parent's context; no fetched harness documents a hard truncation of the child's final message.
- **Tool restriction enforcement.** Allowlists (`tools:`) vs denylists (`disallowedTools:`, permission deny globs). Claude Code fails the spawn if a `tools` list resolves to zero tools, naming unresolved entries; Gemini hides agent-tools even under the `*` wildcard (recursion protection); OpenCode denies `task` + `todowrite` in children at the permission layer unless explicitly re-enabled.
- **Recursion guards.** Three strategies observed: flat prohibition (Gemini, Cursor), configurable depth limit (Claude Code default 3; OpenCode default 1), and tool-registry denial of the spawn tool in child sessions (OpenCode, belt-and-braces with the depth check).
- **Prompt injection from child output.** Claude Code scans subagent output for "instruction-shaped pattern(s)" before the parent reads it and defangs imitations of system tags. Child agents reading untrusted repo/web content can otherwise smuggle instructions into the parent's context with elevated credibility ("the agent's outputs should generally be trusted" makes this worse).
- **Permission surface.** Who approves child tool calls? Claude Code background agents surface their permission prompts in the main session; OpenCode treats the spawn itself as a permissioned action (`permission.task` with glob patterns; deny removes the agent from the tool description); Gemini routes through its policy engine with per-subagent rules. OpenCode derives child session permissions from the parent session plus agent config (`deriveSubagentSessionPermission`).
- **Statelessness vs resume.** The original Claude Code contract was strictly stateless ("You will not be able to send additional messages to the agent"); every current harness adds resume (Claude Code `SendMessage` by agent ID, OpenCode `task_id`, Cursor agent ID, pi `resume` + `steer_subagent`). Resume-by-ID is now table stakes.

## Design takeaways for pi

- **The feature already exists in-repo.** Any spec must first decide the relationship to `vendor/pi-subagents`: keep it as a vendored always-on extension, promote parts to core (`packages/agent` harness), or slim it down. Note it is currently *not* removable — `resource-loader.ts` injects it into every extension set — which sits awkwardly with pi's minimalism and extension-first values. At minimum the spec should make that injection explicit/configurable.
- **Copy the converged contract verbatim into the tool description; it is load-bearing.** Specifically: self-contained prompt requirement, "single message with multiple tool uses" for parallelism, result-not-visible-to-user + summarize-for-the-user, write-code-vs-research disambiguation, and don't-duplicate-delegated-work. These lines exist nearly word-for-word across Claude Code, OpenCode, ZCode, and the vendored pi code — they are the distilled fix for the pitfalls above.
- **Keep one generic tool (`Agent`/`task`) with `subagent_type`, not Gemini's agent-as-tool.** A generic tool keeps the parent's tool list constant (no description-budget growth as agents are added), matches every other harness, and makes permission/depth guards one code path. Gemini's per-agent tools are the outlier.
- **Enforce the recursion guard in the registry, not the prompt.** OpenCode's approach — deny the spawn tool (and todo) in child sessions by default, plus a configurable depth cap (default 1) — is cheap, testable, and matches pi minimalism. Pi's vendored code already has `nested-tools.ts`; the spec should keep whatever it does.
- **Ship only two default agents: general-purpose and read-only Explore.** This is the cross-harness converged set (Claude Code Explore/Plan, OpenCode explore/general, Gemini codebase_investigator/generalist, pi's existing search agent). Pi's existing read-only default with the breadth parameter ("quick"/"medium"/"very thorough") and the "locates code, doesn't audit it" caveat matches best practice. Skip Claude Code's long tail (per-agent memory dirs, per-agent hooks, mcpServers, worktrees, isolation) — extension material if ever needed.
- **Markdown + frontmatter is the definition surface; keep pi's `.yupi/agents/*.md` + global dir and same-name override.** Required fields: `name` (or filename), `description`, optional `tools`/`permission`, `model` (default inherit). OpenCode's `mode: primary|subagent|all` is a nice unification if pi ever wants primary-side agent switching; not required for delegation alone.
- **Open questions for the spec:** (1) Should `run_in_background` default true (vendored pi) or false (Claude Code/ZCode)? Pi's current default-true plus "don't race / never fabricate results" text is defensible but nonstandard. (2) Result handling: OpenCode-style XML envelope with child session id vs raw final message; and whether large results spool to a file (vendored `output-file.ts`) — decide the default. (3) Where child sessions live: OpenCode stores them as real sessions with `parentID` (navigable in TUI); pi has session storage already (`packages/agent/src/harness/session/`) — reuse it. (4) Permission inheritance from the parent session (OpenCode's derivation) vs independent per-agent permissions (Claude Code). (5) Whether to port Claude-Code-style injection scanning of child output — pi has `core/output-guard.ts` that may already cover this.

## Sources

- Claude Code sub-agents (official docs): https://code.claude.com/docs/en/sub-agents
- Claude Code tools dump incl. verbatim Task tool schema/description (leaked/reconstructed, 2.0 era): https://raw.githubusercontent.com/x1xhlol/system-prompts-and-models-of-ai-tools/main/Anthropic/Claude%20Code/Tools.json (repo: https://github.com/x1xhlol/system-prompts-and-models-of-ai-tools)
- OpenCode agents docs: https://opencode.ai/docs/agents/
- OpenCode task tool source: https://raw.githubusercontent.com/sst/opencode/dev/packages/opencode/src/tool/task.ts and https://raw.githubusercontent.com/sst/opencode/dev/packages/opencode/src/tool/task.txt
- Gemini CLI subagents doc (verbatim from repo): https://raw.githubusercontent.com/google-gemini/gemini-cli/main/docs/core/subagents.md
- Codex CLI docs (feature absent): https://github.com/openai/codex/tree/main/docs and https://raw.githubusercontent.com/openai/codex/main/docs/config.md
- Amp subagents: https://ampcode.com/docs/models-and-subagents
- Cursor subagents: https://cursor.com/docs/subagents
- ZCode Agent tool semantics: firsthand notes supplied by the research orchestrator (labeled "firsthand" above)
- pi local repo (read-only inspection): packages/coding-agent/vendor/pi-subagents/ (esp. src/index.ts, src/default-agents.ts, src/agent-types.ts), packages/coding-agent/src/core/resource-loader.ts
