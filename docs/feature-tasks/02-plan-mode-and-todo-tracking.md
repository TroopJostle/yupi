# Feature 02: Plan Mode and Todo Tracking

This spec adds two orthogonal features to the pi coding-agent harness: (1) **plan mode**, a session-level read-only state that disables the mutating built-in tools (`edit`, `write`, `bash`, `powershell`) and can only be left through an `exit_plan_mode` tool whose call triggers a user-approval dialog in the TUI; and (2) **todo tracking**, a `todo_write` tool that stores a full-list-replacement task list per session and renders it as a persistent widget above the editor. Plan mode is enforced mechanically (toolset switch plus a hard block in the tool-call path), not by prompt text alone; todos are state storage plus rendering, with no approval semantics. The two features deliberately do not depend on each other, matching every surveyed harness (Codex explicitly documents `update_plan` as "the `update_plan` todo/checklist tool (not plan mode)").

## Metadata

- Priority: high
- Effort: large (two features; core session state, two new tools, TUI surfaces, persistence, tests)
- Risk: medium — touches `AgentSession` internals (tool registry, beforeToolCall hook, system-prompt rebuild) and the interactive submit path; misdesign here breaks every mode (interactive, print, RPC, SDK)
- Depends on: nothing (no other feature task)
- Research: feature-tasks/research/02-plan-mode-and-todo-tracking.md

## Problem

Two failure modes exist in pi today.

**Edits before understanding.** pi's default active toolset is `["read", "bash", "edit", "write"]` (see `defaultActiveToolNames` in `packages/coding-agent/src/core/sdk.ts` around line 257 and `_buildRuntime` in `packages/coding-agent/src/core/agent-session.ts` around line 2831). A user asking "how should we refactor the session persistence?" gets a model that can — and often does — start calling `edit` on `session-manager.ts` in its first turn, before it has read the surrounding code. Concrete trace: user types a broad design question, the model greps once, then emits `edit` with an `oldText` guess that misses (`Could not edit file ... Error code: ...` from `packages/coding-agent/src/core/tools/edit.ts`), then spends several turns repairing damage it should never have caused. There is no way for the user to say "research first, touch nothing until I approve an approach" other than hoping the prompt is respected.

**Invisible progress during long turns.** During a multi-hour task the agent emits long stretches of tool calls with no durable statement of what remains. The transcript shows *what happened* (tool calls) but not *what is left*. When the model loses track, it re-reads files it already processed or drops a step entirely, and the user cannot tell at a glance whether the task is 20% or 80% done. Today the only workaround is the model re-printing a checklist in prose, which it re-prints again (wrong) two turns later.

## Prior art

All quotes below are verbatim from the research dossier (which quotes the primary sources).

### Claude Code (Anthropic)

- Entry: `claude --permission-mode plan`, `Shift+Tab` until `plan mode on`, or `/plan` prefix. "Plan mode tells Claude to research and propose changes without making them." "edits stay blocked until you approve the plan". https://code.claude.com/docs/en/permission-modes
- Exit tool contract (v2.1.205 extracted prompt; the plan lives in a plan file, the tool signals readiness): "Use this tool when you are in plan mode and have finished writing your plan to the plan file and are ready for user approval." "This tool simply signals that you're done planning and ready for the user to review and approve." "Do NOT use ${ASK_USER_QUESTION_TOOL_NAME} to ask 'Is this plan okay?'" Guard: `validateInput` rejects ExitPlanMode when not in plan mode ("You are not in plan mode. This tool is only for exiting plan mode..."). Approval restores `prePlanMode ?? 'default'`. https://raw.githubusercontent.com/Piebald-AI/claude-code-system-prompts/main/system-prompts/tool-description-exitplanmode.md , https://raw.githubusercontent.com/Windy3f3f3f3f/how-claude-code-works/main/en/docs/10-plan-mode.md (secondary)
- TodoWrite implied schema: `{ "todos": [ { "content": "imperative description", "activeForm": "present continuous form", "status": "pending | in_progress | completed" } ] }`, `in_progress` "limited to one at a time". https://raw.githubusercontent.com/Piebald-AI/claude-code-system-prompts/main/system-prompts/tool-description-todowrite.md , https://code.claude.com/docs/en/agent-sdk/todo-tracking

### OpenAI Codex CLI — note the split

- `update_plan` is progress tracking, NOT plan mode. Rust doc comment: "Arguments for the `update_plan` todo/checklist tool (not plan mode)." Schema (reconstructed from `plan_spec.rs`):

```json
{
  "type": "object",
  "properties": {
    "explanation": { "type": "string", "description": "Optional explanation for this plan update." },
    "plan": {
      "type": "array",
      "description": "The list of steps",
      "items": {
        "type": "object",
        "properties": {
          "step": { "type": "string", "description": "Task step text." },
          "status": { "type": "string", "enum": ["pending", "in_progress", "completed"], "description": "Step status." }
        },
        "required": ["step", "status"],
        "additionalProperties": false
      }
    }
  },
  "required": ["plan"],
  "additionalProperties": false
}
```

  Prompt contract: "You have access to an update_plan tool which tracks steps and progress and renders them to the user." "At most one step can be in_progress at a time." "Do not repeat the full contents of the plan after an update_plan call — the harness already displays it." Sources: https://raw.githubusercontent.com/openai/codex/main/codex-rs/core/src/tools/handlers/plan_spec.rs , https://raw.githubusercontent.com/openai/codex/main/codex-rs/protocol/src/plan_tool.rs , https://github.com/openai/codex/blob/main/codex-rs/protocol/src/prompts/base_instructions/default.md
- Codex's separate conversational Plan Mode forbids the checklist tool while active: "`update_plan` is a separate checklist tool and must not be used during Plan Mode". https://raw.githubusercontent.com/openai/codex/main/codex-rs/collaboration-mode-templates/templates/plan.md

### Gemini CLI (Google)

- Plan mode: "a read-only mode that restricts Gemini CLI to a subset of its tools"; entry `/plan [goal]`, `Shift+Tab`, `--approval-mode=plan`. `exit_plan_mode` schema `{ plan_filename: string }`; description: "Finalizes the planning phase and transitions to implementation by presenting the plan for formal user approval." "You MUST reach an informal agreement with the user in the chat regarding the proposed strategy BEFORE calling this tool." Rejection with feedback returns "Revise the plan based on the feedback." https://raw.githubusercontent.com/google-gemini/gemini-cli/main/docs/cli/plan-mode.md , https://raw.githubusercontent.com/google-gemini/gemini-cli/main/packages/core/src/tools/exit-plan-mode.ts
- `write_todos` schema: `{ todos: [ { description: string, status: "pending" | "in_progress" | "completed" | "cancelled" | "blocked" } ] }`; "The full list of todos. This will overwrite any existing list." Validation enforces "Only one task can be 'in_progress' at a time." "You must update the todo list as soon as you start, stop or cancel a subtask. Don't batch or wait to update the todo list." https://raw.githubusercontent.com/google-gemini/gemini-cli/main/packages/core/src/tools/write-todos.ts

### OpenCode (anomalyco/opencode)

- Plan agent: "Plan mode. Disallows all edit tools."; `plan_exit` takes no parameters, asks Yes/No, and on approval writes a synthetic user message "you can now edit files. Execute the plan". Known escape: global `"permission": "allow"` overrides plan-mode read-only (issue #28130, closed not planned). https://raw.githubusercontent.com/anomalyco/opencode/dev/packages/opencode/src/agent/agent.ts , https://raw.githubusercontent.com/anomalyco/opencode/dev/packages/opencode/src/tool/plan.ts , https://github.com/anomalyco/opencode/issues/28130
- `todowrite`: `todos: Array<Todo.Info>` with `content` / `status` ("pending, in_progress, completed, cancelled") / `priority`; update semantics are a transaction that "deletes all rows for the session then re-inserts the full list with `position` = array index (snapshot replacement)". https://raw.githubusercontent.com/anomalyco/opencode/dev/packages/opencode/src/tool/todo.ts

### Key pitfalls from the dossier

- Bash is the universal plan-mode escape hatch (`bash -c "echo ... > file"`, `sed -i`, `git commit`). Deny `bash`/`powershell` outright in plan mode; do not ship a command allowlist in v1.
- Enforcement must live in the tool layer against a session-level flag, not in the prompt (Claude's `validateInput` guard exists because stale tool listings and compaction make the model call exit tools out of turn).
- Post-approval toolset restoration must be explicit (Claude's `prePlanMode` save/restore) or you over- or under-permission after approval.
- Only the single-`in_progress` invariant is machine-enforceable; everything else about todo freshness is prompt discipline made visible by rendering.

## Proposed design

### Plan mode

**Entry mechanism — user-initiated only (decision).** pi gets a `/plan [goal]` built-in command and an `app.plan.toggle` keybinding with empty default keys. No model-initiated `EnterPlanMode` tool in v1. Rationale: pi's closest precedent, thinking-level cycling (`app.thinking.cycle` on `shift+tab` in `packages/coding-agent/src/core/keybindings.ts`), is user-initiated, and pi already has the exact dispatch plumbing for user commands (the inline command ladder in `setupEditorSubmitHandler()` in `packages/coding-agent/src/modes/interactive/interactive-mode.ts`, starting around line 2983, handles `/settings`, `/model`, etc.). A model-initiated entry tool needs a consent dialog and subagent/UX guards (Claude throws "EnterPlanMode tool cannot be used in agent contexts"); that is avoidable complexity for v1. `/plan` with no argument just toggles the mode; `/plan refactor the parser` enters the mode and submits the goal text wrapped in a planning instruction (literal below).

**State.** Add to `AgentSession`:

- `private _planModeActive = false` and `private _prePlanModeToolNames: string[] | undefined`
- `get planModeActive(): boolean`
- `enterPlanMode(): void` — no-op if already active. Saves `this.getActiveToolNames()` into `_prePlanModeToolNames`, then computes the plan toolset: currently-active tools filtered to the read-only built-ins `["read", "grep", "find", "ls"]` (same set as `createReadOnlyToolDefinitions` in `packages/coding-agent/src/core/tools/index.ts`, line 173), plus `"todo_write"` if it was active, plus `"exit_plan_mode"`, plus all active extension/custom tools (they are user-installed trusted code — the same trust level as pi extensions generally; the mode gates the model's built-in mutators, not the extension trust boundary). Calls `this.setActiveToolsByName(planToolNames)`, then `this._emit({ type: "plan_mode_changed", active: true })`.
- `exitPlanMode(): void` — restores `setActiveToolsByName(this._prePlanModeToolNames ?? defaultActive)`, clears both fields, emits `{ type: "plan_mode_changed", active: false }`. Per the OpenCode #28130 lesson, plan mode is a **hard cap while active**: the beforeToolCall block below fires regardless of any extension re-enabling tools mid-run.

`setActiveToolsByName` (line 966 of `agent-session.ts`) already rebuilds the system prompt for the new tool set, so `edit`/`write`/`bash` disappear from "Available tools" and their guidelines disappear automatically (guidelines are collected per active tool name in `_rebuildSystemPrompt`, line 1061).

**Enforcement point (two layers).**

1. *Toolset switch* (above): with the mutators removed from `agent.state.tools`, the agent loop's `prepareToolCall` returns "Tool `edit` not found" for any stale call (see `packages/agent/src/agent-loop.ts` line 614-620). The per-turn refresh installed by `_installAgentNextTurnRefresh` (line 557) picks up `agent.state.tools` on the next turn.
2. *Live block for in-flight calls*: entering plan mode mid-run does not change the tool snapshot of the current turn (turn-local `currentContext.tools`), so a tool call that already streamed could still execute. Fix in `_installAgentToolHooks()` (line 482): prepend a guard to the existing `this.agent.beforeToolCall` assignment, before the extension-runner emission:

```ts
const PLAN_MODE_BLOCKED_TOOLS = new Set(["edit", "write", "bash", "powershell"]);

this.agent.beforeToolCall = async ({ toolCall }) => {
	if (this._planModeActive && PLAN_MODE_BLOCKED_TOOLS.has(toolCall.name)) {
		return {
		 block: true,
		 reason:
			`Plan mode is active; "${toolCall.name}" is disabled. Finish researching with the read-only tools, then call exit_plan_mode to present the plan for approval.`,
		};
	}
	// ... existing runner.emitToolCall(...) body unchanged
};
```

The `block`/`reason` shape is already honored by `prepareToolCall` in the agent loop (lines 643-653: blocked calls become error tool results carrying the reason), so the model receives an actionable message instead of a mutation.

**The `exit_plan_mode` tool.** New file `packages/coding-agent/src/core/tools/plan.ts` exporting `createExitPlanModeToolDefinition(deps)` where `deps` is `{ isPlanMode: () => boolean; approve: (plan: string, hasUI: boolean, ui: ExtensionUIContext) => Promise<PlanApprovalOutcome> }`, wired in `AgentSession._buildRuntime` to read `this._planModeActive` and call session methods. Schema (TypeBox, matching the style of `editSchema` in `tools/edit.ts`):

```ts
const exitPlanModeSchema = Type.Object({
	plan: Type.String({
		minLength: 1,
		maxLength: 20000,
		description:
			"The complete plan text. Must include: goal, ordered implementation steps referencing concrete file paths, risks, and how the change will be verified.",
	}),
});
```

`execute` behavior:

- If `!deps.isPlanMode()` → return an error result (throw `new Error("Not in plan mode. exit_plan_mode is only available while plan mode is active.")`). This is Claude's stale-tool-listing guard.
- Otherwise call `deps.approve(plan, ctx.hasUI, ctx.ui)`. `ctx` here is the `ExtensionContext` that `wrapRegisteredTool` in `packages/coding-agent/src/core/extensions/wrapper.ts` injects into every registered tool's `execute` (the wrapper builds it from `runner.createContext()`), so the tool gets the real `ctx.ui` and `ctx.hasUI` of the current mode with zero new plumbing.
- Outcomes (an `PlanApprovalOutcome` is `{ kind: "approved"; plan: string } | { kind: "rejected"; feedback?: string } | { kind: "keepPlanning" }`):
  - `approved` → `exitPlanMode()` runs (toolset restored; the wrapper's before/after `getActiveTools()` diff propagates `addedToolNames` to providers that need it), and the tool result echoes the final (possibly user-edited) plan text followed by `Plan approved by the user. Proceed with implementation following the plan.` — echoing the plan into the result means the model never has to re-read anything (Claude does exactly this).
  - `rejected` → error result: `Plan not approved. User feedback: ${feedback ?? "(none provided)"}. Revise the plan and call exit_plan_mode again.` Plan mode stays active.
  - `keepPlanning` → non-error result: `The user chose to keep planning. Continue researching or refining the plan; call exit_plan_mode when it is decision-complete.`

**Approval prompt in the TUI.** `deps.approve` with `hasUI === true` runs, using only existing `ExtensionUIContext` primitives (`packages/coding-agent/src/core/extensions/types.ts`, line 133; interactive implementations at `showExtensionSelector` line 2499, `showExtensionInput` line 2575, `showExtensionEditor` behind `ui.editor`):

1. `await ui.select("Approve plan and start implementation?", ["Approve", "Edit plan first", "Reject with feedback", "Keep planning"])` — the plan itself is already visible in the transcript because `renderCall` for `exit_plan_mode` renders the plan markdown above the dialog (tool renderers receive the call args; see `renderCall` on `ToolDefinition`, types.ts line 491).
2. "Edit plan first" → `const edited = await ui.editor("Edit plan", plan)`; `undefined` (Esc) returns to step 1; a saved string is treated as approved with the edited text.
3. "Reject with feedback" → `const feedback = await ui.input("What should change?")`; result is `rejected` with that feedback. This is Gemini's rejection-with-feedback loop, verbatim semantics.
4. "Keep planning", or Esc at step 1 (`select` resolves `undefined`) → `keepPlanning`.

With `hasUI === false` (print mode, unbound SDK sessions — `ExtensionRunner` uses `noOpUIContext` and `hasUI()` returns false, runner.ts lines 236 and 492): auto-approve, and the result text notes `Plan auto-approved (no interactive UI available).` This mirrors Gemini's non-interactive behavior.

**System-prompt contract (literal).** Extend `BuildSystemPromptOptions` in `packages/coding-agent/src/core/system-prompt.ts` with `planMode?: boolean`. When true, `buildSystemPrompt` appends this block on both return paths (the `customPrompt` early-return path at line 48 and the default path at line 127), inserted before `appendSection`:

```
<plan_mode>
You are in plan mode. This session is read-only: the edit, write, bash, and powershell tools are disabled and calls to them will fail.

Explore the codebase with the read-only tools. Ask clarifying questions as normal chat messages when requirements are ambiguous. When you have a decision-complete approach, call exit_plan_mode with the full plan text.

The plan must contain: the goal, ordered implementation steps that name concrete file paths, notable risks, and how the change will be verified. Do not call exit_plan_mode for research-only tasks that need no code changes. Do not ask "should I proceed?" — calling exit_plan_mode is how the plan is presented for approval.
</plan_mode>
```

`AgentSession._rebuildSystemPrompt` passes `planMode: this._planModeActive` inside `_baseSystemPromptOptions`, so entering/exiting via `setActiveToolsByName` (which calls `_rebuildSystemPrompt`) keeps the block in sync; entering plan mode must call `_rebuildSystemPrompt` again (or set the flag before the toolset switch so the single rebuild inside `setActiveToolsByName` picks it up).

**Exit semantics summary.** Plan mode ends only via (a) `exit_plan_mode` approval (auto or user), or (b) the user toggling it off with `/plan` or the keybinding (Claude's "press Shift+Tab again to leave plan mode without approving"). The plan is inline in the tool call (1-20000 chars, ZCode's minimal variant); it lives in the transcript. Plan-file durability is out of scope (below).

### Todo tracking

**Tool.** New file `packages/coding-agent/src/core/tools/todo.ts` exporting `createTodoWriteToolDefinition(deps: { getTodos: () => TodoItem[]; setTodos: (todos: TodoItem[]) => void })`. Exact schema:

```ts
const todoStatusSchema = Type.Union([
	Type.Literal("pending"),
	Type.Literal("in_progress"),
	Type.Literal("completed"),
]);

const todoItemSchema = Type.Object({
	content: Type.String({ description: "Task description in imperative form, e.g. 'Run the edit tool tests'." }),
	status: todoStatusSchema({ description: "pending = not started, in_progress = currently working (at most one at a time), completed = done and verified." }),
});

const todoWriteSchema = Type.Object({
	todos: Type.Array(todoItemSchema, {
		description:
			"The full todo list. Replaces the previous list entirely; send every item, not a delta. At most one item may be in_progress.",
	}),
});
```

`TodoItem` is `{ content: string; status: "pending" | "in_progress" | "completed" }` (exported from the todo module; plain object type — no enum, per repo erasable-syntax rules). Execute:

1. Validate: if `input.todos.filter((t) => t.status === "in_progress").length > 1`, throw `new Error("Invalid todo list: at most one item can be in_progress. Exactly one item should be in_progress while you work; the rest are pending or completed.")`. This is the one machine-enforced invariant (Gemini rejects it; Codex and Claude state it in the contract).
2. `deps.setTodos(input.todos)`.
3. Return the full current list in the result text — numbered `[status] content` lines — so the result doubles as the read-back (Gemini's approach; no separate `TodoRead`; matches pi minimalism better than Claude's four Task tools).

The tool sets `promptSnippet` and `promptGuidelines` on its `ToolDefinition`, which flow into the system prompt automatically when the tool is active (`_rebuildSystemPrompt` collects them, `agent-session.ts` lines 1061-1095). Guidelines (literal):

- "Use todo_write for tasks with three or more distinct steps; skip it for simple or conversational tasks"
- "todo_write replaces the whole list each call; always send the complete updated list"
- "Mark an item in_progress immediately before starting it and completed immediately after finishing it; at most one item may be in_progress"
- "Never mark an item completed based on intent; only after the step is verified"
- "Do not restate the todo list in your response text; the interface renders it for the user"

**State storage, per session.** `AgentSession` owns `private _todos: TodoItem[] = []`, `getTodos(): readonly TodoItem[]`, and the `setTodos` dep writes through to:

- `this._todos = todos`
- `this.sessionManager.appendCustomEntry("pi.todos", todos)` — custom entries are the session-persistence mechanism that does not enter LLM context (see `appendCustomEntry`, `session-manager.ts` line 1136, and the `CustomEntry` type at line 104; the extension API exposes the same thing as "Append a custom entry to the session for state persistence").
- `this._emit({ type: "todos_update", todos })` — new `AgentSessionEvent` variant added to the union in `agent-session.ts` (line 144).
- Restore on construction/fork: scan `this.sessionManager.getBranch()` (already in the `ReadonlySessionManager` pick list) backwards for the last entry with `type === "custom" && customType === "pi.todos"` and hydrate `_todos` from its `data`. Because the list lives in the entry tree rather than messages, forking and tree navigation inherit the correct snapshot for free.

**TUI rendering.** `interactive-mode.ts` subscribes to the new `todos_update` and `plan_mode_changed` session events (it already consumes `AgentSessionEvent`s via `session.subscribe`). Rendering uses the existing widget machinery — the exact placement/plumbing extensions get:

- Todo widget: on `todos_update`, call the internal path behind `setExtensionWidget("pi.todos", lines, { placement: "aboveEditor" })` (`setExtensionWidget` is at line 2188; string-array content is wrapped into a `Container` of `Text` rows and hard-capped at `MAX_WIDGET_LINES = 10` with a "... (widget truncated)" tail, lines 2210-2223). When the list is empty, pass `undefined` to remove the widget. Line format: `☐ 2. Add exit_plan_mode tool` for pending, `● 1. Add plan state to AgentSession` (in_progress, theme bold/accent) and `✓ 3. Wire /plan command` (completed, theme muted color). Show at most the current `in_progress` item, the pending items, and — only if room remains under the 10-line cap — the most recently completed items.
- Plan-mode status: on `plan_mode_changed`, call the internal path behind `setExtensionStatus("planMode", active ? "plan mode" : undefined)` (`setExtensionStatus`, line 2090, writes to the footer data provider) so the footer shows the mode, matching how extension `setStatus` surfaces today.

**Compaction interaction.** Custom entries are not messages, so compaction never destroys todo state — only the model's *view* of it (the last `todo_write` tool result may be summarized away). Fix: in `AgentSession.compact()` and `_runAutoCompaction()`, after `this.agent.state.messages = sessionContext.messages` (the two sites that rebuild state from the compaction entry), if `this._todos.length > 0`, append one context-only `CustomMessage` via the existing private `_appendCustomMessage` (line 1537) with `customType: "pi.todos.snapshot"` and a text body listing the current items. This re-injects the list using the same message mechanism extensions use for context injection, without touching the entry tree.

**Interaction with plan mode.** `todo_write` stays available in plan mode (it mutates no files). This diverges from Codex, which forbids `update_plan` during Plan Mode to keep the conversational plan and the checklist from blurring; in pi the surfaces are distinct enough (widget vs approval dialog) that forbidding it would block the useful "seed the checklist from the approved plan" flow: the `exit_plan_mode` approved result already ends with `Proceed with implementation following the plan.` and the guidelines tell the model to establish a todo list first, which naturally seeds it.

**Slash/command surface.** No todo commands in v1: the widget is the surface, auto-shown when non-empty. (A `/todos` viewer is trivially addable later via the same command ladder; listed under out-of-scope.)

### Config surface

- Keybinding: add `"app.plan.toggle"` to the `AppKeybindings` interface and `KEYBINDINGS` map in `packages/coding-agent/src/core/keybindings.ts` with `defaultKeys: []` (the `app.session.new` pattern, line 146 — avoids colliding with the heavily-used `shift+tab`/`ctrl+t`/`ctrl+o`), description `"Toggle plan mode"`. Users bind it in `~/.pi/keybindings.json` (`KeybindingsManager.create` reads that file). Per repo rules, the toggle must be dispatched via the keybinding system (`defaultEditor.onAction("app.plan.toggle", ...)`, next to the `app.session.new` registration at line 2919 of `interactive-mode.ts`), never a hardcoded key comparison.
- Settings: no new keys required. `defaultTools` already controls initial built-in tool selection; `todo_write` is added to the default active set (see implementation plan) and can be removed with the existing `excludedToolNames` / `--exclude-tools` plumbing, which `_refreshToolRegistry` already honors (line 2694).
- CLI: optional `--plan` flag to start in plan mode, implemented exactly where `sdk.ts` computes `initialActiveToolNames` (line ~257): when set, the session is constructed and `enterPlanMode()` is called before the first prompt. Keep this flag in the final implementation only if it does not grow extra machinery; it is acceptable to defer it (note in open questions).

### Out of scope

- Model-initiated plan-mode entry tool (`EnterPlanMode`) and consent dialog for it.
- Plan files on disk (`.pi/plans/`), plan slugs, 30-day retention, external-editor recovery ladders. The plan is inline in the transcript.
- A bash command allowlist/classifier for plan mode (bash is flat-denied; Claude's classifier approach is not replicated).
- Separate `TodoRead`/`TaskCreate`/`TaskGet`/`TaskUpdate`/`TaskList` tools; `cancelled`/`blocked`/`priority` todo statuses; per-agent todo stores; RPC notifications for todo/plan events.
- Auto-accept / permission-mode choices on approval (pi has no permission-mode matrix; approval restores the pre-plan toolset, full stop).
- `/todos` command and a `app.todos.toggle` keybinding.

## Implementation plan

Ordered; steps 1-4 are plan mode, 5-7 todo tracking, 8-9 TUI, 10-11 cleanup. All new code uses erasable TypeScript only (no enums, namespaces, parameter properties, `import =`).

1. **`packages/coding-agent/src/core/tools/plan.ts` (new)** — `exitPlanModeSchema`, `PLAN_MODE_BLOCKED_TOOLS` export, `PlanApprovalOutcome` type, `createExitPlanModeToolDefinition(deps)` as designed above, with `promptSnippet: "Present the plan for user approval and exit plan mode"` and a `renderCall` that renders the plan text as markdown (follow the renderer pattern of an existing simple renderer, e.g. `tools/renderers/write.ts`, using `renderShell: "self"` like `edit.ts` line 157).
2. **`packages/coding-agent/src/core/tools/todo.ts` (new)** — schemas, `TodoItem`, `createTodoWriteToolDefinition(deps)`, plus a compact `renderCall`/`renderResult` (one summary line: `todos: 3 items (1 in_progress)`; result shows the numbered list, collapsed by default).
3. **`packages/coding-agent/src/core/system-prompt.ts`** — add `planMode?: boolean` to `BuildSystemPromptOptions`; append the literal `<plan_mode>` block on both return paths, before `appendSection`.
4. **`packages/coding-agent/src/core/agent-session.ts`** —
   - Add `_planModeActive`, `_prePlanModeToolNames`, `_todos` fields; `planModeActive` getter; `enterPlanMode()`, `exitPlanMode()`, `getTodos()`, `private _setTodos()`.
   - Extend the `AgentSessionEvent` union (line 144) with `{ type: "plan_mode_changed"; active: boolean }` and `{ type: "todos_update"; todos: TodoItem[] }`.
   - In `_installAgentToolHooks` (line 482), prepend the `PLAN_MODE_BLOCKED_TOOLS` guard shown above to `agent.beforeToolCall`.
   - In `_rebuildSystemPrompt` (line 1061), pass `planMode: this._planModeActive` into `_baseSystemPromptOptions`.
   - In `_buildRuntime` (line 2787), after `createAllToolDefinitions`, register the two new definitions in `_baseToolDefinitions` with deps bound to `this` (closures reading live state, so extension reloads that re-run `_buildRuntime` rebind correctly), and add `"todo_write"` to `defaultActiveToolNames` (line 2833: `["read", "bash", "edit", "write", "todo_write"]`).
   - Hydrate `_todos` from the last `"pi.todos"` custom entry on `getBranch()` — do it lazily in the constructor right after `_buildRuntime` (the `sessionManager` is fully constructed by then).
   - Re-inject the todo snapshot after compaction in `compact()` (after line 2056) and `_runAutoCompaction()` (after line 2382) via `_appendCustomMessage`.
5. **`packages/coding-agent/src/core/tools/index.ts`** — re-export the new types/factories (`createExitPlanModeToolDefinition`, `createTodoWriteToolDefinition`, `TodoItem`, `PlanApprovalOutcome`, `PLAN_MODE_BLOCKED_TOOLS`) for SDK consumers, following the existing export block style. Do not extend the `ToolName` union — the new tools are session-scoped, not filesystem tools, and are registered separately in step 4.
6. **`packages/coding-agent/src/core/sdk.ts`** — add `"todo_write"` to `defaultActiveToolNames` (line ~257) so SDK-created sessions match; optionally thread a `startInPlanMode` option through to `enterPlanMode()`.
7. **`packages/coding-agent/src/core/keybindings.ts`** — add `app.plan.toggle` to `AppKeybindings` (line 14 area) and `KEYBINDINGS` (line 75 area) with `defaultKeys: []`.
8. **`packages/coding-agent/src/modes/interactive/interactive-mode.ts`** —
   - In `setupEditorSubmitHandler()` (line 2983): handle `"/plan"` and `"/plan <goal>"` — toggle via `this.session.enterPlanMode()/exitPlanMode()`; when a goal is given, enter plan mode and submit `Planning task. Research the codebase first, then present the plan via exit_plan_mode:\n\n<goal>` through the normal prompt path.
   - Next to the `app.session.new` registration (line 2919): `this.defaultEditor.onAction("app.plan.toggle", () => this.handlePlanToggle())`.
   - In the session-event subscription handling, react to `plan_mode_changed` (set/clear the `planMode` footer status via the `setExtensionStatus` path, line 2090) and `todos_update` (update the `pi.todos` widget via the `setExtensionWidget` path, line 2188).
9. **Approval flow** lives inside the `deps.approve` implementation added in step 4 (it receives `ctx.hasUI`/`ctx.ui` from the wrapper on each call, so no mode-specific code is needed outside it).
10. **`packages/coding-agent/CHANGELOG.md`** — entries below.
11. **Docs** — add the new tool names to any enumerated tool lists if `docs/` maintains one (check `docs/tools.md` / `docs/keybindings.md` for the keybinding table; there is a documentation test, `packages/coding-agent/test/documentation.test.ts`, that may validate doc links).

## Testing plan

Run non-e2e tests with `./scripts/test.sh` from the repo root, or targeted: `node "$(git rev-parse --show-toplevel)/node_modules/vitest/dist/cli.js" --run test/suite/plan-mode.test.ts` from `packages/coding-agent`. Agent-level tests use `test/suite/harness.ts` + the faux provider (`fauxAssistantMessage`, `fauxToolCall` from `@earendil-works/pi-ai`, as in `test/suite/agent-session-prompt.test.ts`).

**`packages/coding-agent/test/suite/plan-mode.test.ts`** (new):

- *Toolset switch*: `createHarness({ tools: [echoTool] })`-style with default built-ins; `session.enterPlanMode()`; assert `session.getActiveToolNames()` contains `read`/`grep`/`find`/`ls`/`exit_plan_mode` and none of `edit`/`write`/`bash`/`powershell`; assert `session.systemPrompt` contains `You are in plan mode` and not the edit tool snippet. `session.exitPlanMode()` restores the original names.
- *Plan mode blocks mutating tools even when present*: enter plan mode, then re-enable `edit` via `session.setActiveToolsByName(["read", "edit"])` (simulating an extension overriding the toolset); set a faux response that issues an `edit` tool call (`fauxToolCall("edit", { path, edits: [...] })`); `await session.prompt("change the file")`; assert the tool result `isError` and its text contains `Plan mode is active`.
- *Approval flow (auto, no UI)*: enter plan mode; faux response calls `exit_plan_mode` with `{ plan: "1. Do the thing" }`; harness binds no UI, so `hasUI` is false; assert the tool result text contains `auto-approved`, `session.planModeActive === false`, active tools restored, and the result echoes the plan text.
- *Approval flow (interactive)*: same, but first call `await harness.session.bindExtensions({ uiContext: fakeUi })` with a stub whose `select` resolves `"Approve"` (tests already cast partial stubs, e.g. `extensions-runner.test.ts` line 574 uses `{} as ExtensionUIContext`; implement `select`/`editor`/`input` only and cast). Assert approval path. Variants: `select` → `"Reject with feedback"` + `input` → `"narrow the scope"` asserts error result containing the feedback and `planModeActive === true`; `select` → `undefined` asserts keep-planning result and mode still active; `select` → `"Edit plan first"` + `editor` → edited text asserts the tool result echoes the edited plan.
- *Stale-call guard*: without entering plan mode, drive a faux `exit_plan_mode` call; assert error result `Not in plan mode`.
- *Event emission*: assert `eventsOfType("plan_mode_changed")` transitions.

**`packages/coding-agent/test/suite/todo-tracking.test.ts`** (new):

- *Replacement semantics*: faux response calls `todo_write` with 3 items; assert `session.getTodos()` deep-equals them and a `"pi.todos"` custom entry was appended (`sessionManager.getBranch()` last entry). Second call with 2 items replaces, not merges.
- *One-in_progress rule*: call with two `in_progress` items; assert error result naming the invariant and that stored todos are unchanged.
- *Result echo*: non-error result text contains each `[pending]`/`[in_progress]` item.
- *System prompt guidelines*: with `todo_write` active, `session.systemPrompt` contains `replaces the whole list`; after `session.setActiveToolsByName(["read"])`, it does not.
- *Persistence*: drive a `todo_write`, dispose, rebuild a harness over the same session file (or assert directly on a new `SessionManager` + `AgentSession` constructed from the saved file per the harness's session-file utilities), assert `getTodos()` is restored from the `"pi.todos"` entry.
- *Event emission*: `eventsOfType("todos_update")`.

**`packages/coding-agent/test/plan-mode-system-prompt.test.ts`** (new, direct unit test): call `buildSystemPrompt` with `planMode: true` and `customPrompt` variants; assert the `<plan_mode>` block appears before appended sections and disappears when `planMode` is omitted.

**Widget rendering**: extend `packages/coding-agent/test/interactive-mode-status.test.ts` (it already drives `createExtensionUIContext`/`setExtensionStatus` with a fake `this`) or add a sibling test asserting that a `todos_update` event produces the expected widget lines and that an empty list clears the widget. TUI rendering tests in this repo use `node --test` in `packages/tui`; no new pi-tui package code is required, so no tests there.

## Changelog

Draft entries for `packages/coding-agent/CHANGELOG.md` under `## [Unreleased]` (append to the existing subsections; format matches current entries):

### Added

- Added plan mode: `/plan [goal]` (or a user-configured `app.plan.toggle` keybinding) restricts the session to read-only tools; the model presents its plan through the new `exit_plan_mode` tool and edits stay blocked until the user approves, edits, or rejects the plan with feedback.
- Added a `todo_write` tool that maintains a per-session task list (full-list replacement, at most one `in_progress` item) and renders it as a persistent widget above the editor; the list survives compaction and session resume.

## Risks and open questions

- **Extension tools remain active in plan mode.** A user-installed tool that mutates state (e.g. an SSH exec tool) is not blocked; plan mode gates built-in mutators only, consistent with pi's model that extensions are trusted in-process code. If this is unacceptable, `enterPlanMode` must drop all non-builtin tools (one-line change to the filter) — decide before merge. Open question for the maintainer.
- **Mid-run entry is eventually-consistent for the toolset but immediately-consistent for the block.** The beforeToolCall guard closes the in-flight hole; the system-prompt block, however, only refreshes on the next turn's `prepareNextTurnWithContext`. A model mid-turn may keep planning against a prompt that still lists `edit` until the turn boundary. Acceptable (the block catches the call), but worth a release note.
- **Reload during plan mode.** `reload()` (line 2841) rebuilds the runtime from `this.getActiveToolNames()` — the plan-filtered set — so `_prePlanModeToolNames` stays valid and exit still restores correctly, but a reload that re-registers extension tools mid-plan will not add them back to the plan set. Minor; document.
- **Session resume does not restore plan-mode state** (only todos). Claude persists the mode; pi v1 does not. Open question: persist a `"pi.planMode"` custom entry the same way, or accept that a resumed session exits plan mode?
- **`--plan` CLI flag** is optional in this spec; skipping it keeps the diff smaller.
- **Widget space.** The 10-line widget cap shared with `MAX_WIDGET_LINES` means long todo lists truncate; the drop order (oldest completed first) must be the one implemented, or users lose sight of pending work.
- **Todo drift is expected.** Every harness reports the model forgetting to update the list; the rendering exists to make that visible. Do not add machinery (auto-complete detection etc.) in v1.

## Acceptance criteria

- [ ] `session.enterPlanMode()` removes `edit`/`write`/`bash`/`powershell` from `getActiveToolNames()`, adds `exit_plan_mode`, keeps `read`/`grep`/`find`/`ls` and extension tools, and the rebuilt system prompt contains the literal `<plan_mode>` block.
- [ ] While plan mode is active, an `edit`/`write`/`bash`/`powershell` call fails with an error result whose text names plan mode — including when the tool was re-enabled after entry.
- [ ] `exit_plan_mode` called outside plan mode returns the "Not in plan mode" error.
- [ ] In the TUI, approving the plan dialog restores the pre-plan toolset and the approved (possibly edited) plan text appears in the tool result; rejecting feeds the user's feedback text back to the model and plan mode stays active; Esc/keep-planning continues planning.
- [ ] With no UI bound (print/SDK), `exit_plan_mode` auto-approves and the result says so.
- [ ] `/plan` toggles the mode; `/plan <goal>` enters the mode and submits the wrapped goal; `app.plan.toggle` exists in `KEYBINDINGS` with empty defaults and is dispatched via `onAction`, not a hardcoded key check.
- [ ] The footer shows a plan-mode status while active; it clears on exit.
- [ ] `todo_write` replaces the entire stored list each call; a call with two `in_progress` items errors and leaves stored state unchanged; the success result echoes the full list.
- [ ] The todo widget appears above the editor when the list is non-empty, shows at most 10 lines, and is removed when the list empties.
- [ ] Todos survive compaction (snapshot custom message re-injected) and session resume (restored from the `"pi.todos"` session entry).
- [ ] `todo_write` prompt guidelines appear in the system prompt only while the tool is active, and `--exclude-tools todo_write` removes the tool entirely.
- [ ] `npm run check` passes clean; new tests pass via `./scripts/test.sh`; no new `any`, no non-erasable TypeScript syntax, no inline imports.
