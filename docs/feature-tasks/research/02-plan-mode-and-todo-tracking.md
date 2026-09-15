# Research dossier: Plan mode and todo/progress tracking in production coding-agent harnesses

## Summary

All five surveyed harnesses converge on the same architecture: plan mode is a harness-enforced permission state (read-only toolset + user approval gate implemented as an `ExitPlanMode`-style tool) while todo tracking is a separate, orthogonal tool that stores a full-list snapshot (`todos[]` with statuses) that the TUI renders. The sharpest distinction to preserve: OpenAI Codex's `update_plan` is explicitly "the `update_plan` todo/checklist tool (not plan mode)" — and Codex separately ships a conversational Plan Mode that forbids `update_plan` while active. Enforcement points vary: OpenCode gates via per-agent permission merge (with a known escape: global `"permission": "allow"` overrides plan-mode read-only), Claude Code combines tool filtering with a classifier/prompt on shell commands, and Gemini CLI restricts writes to `.md` files in a dedicated plans directory.

## Findings by harness

### Claude Code (Anthropic)

#### Plan mode

Entry points and UX (official docs):

- Enter at startup with `claude --permission-mode plan`, mid-session with `Shift+Tab` until the status bar shows `⏸ plan mode on`, or by prefixing a prompt with `/plan`. Project default via `"defaultMode": "plan"` in `.claude/settings.json`. Source: https://code.claude.com/docs/en/common-workflows , https://code.claude.com/docs/en/permission-modes
- "Plan mode tells Claude to research and propose changes without making them." Claude can read files, run shell commands to explore, and write a plan, but "edits stay blocked until you approve the plan". "Press `Shift+Tab` again to leave plan mode without approving a plan." Source: https://code.claude.com/docs/en/permission-modes
- Shell handling during planning: when auto mode is available and `useAutoModeDuringPlan` is on (default), "the classifier reviews shell commands during planning instead of prompting you. Approved commands run, and rejected ones are blocked." Otherwise any non-read-only command prompts. Historical note: in v2.1.212–v2.1.217 non-bypass sessions prompted for every non-read-only command. Source: https://code.claude.com/docs/en/permission-modes
- Approval options presented when the plan is ready: "Yes, and use auto mode" (or "Yes, auto-accept edits", or a bypass-permissions variant), "Yes, manually approve edits", "No, keep planning". "Press `Ctrl+G` to open the proposed plan in your default text editor and edit it directly before Claude proceeds." Optional `showClearContextOnPlanAccept` setting adds an approve-and-clear-planning-context first option. "Approving a plan exits plan mode and switches the session to the permission mode each approve option describes." Accepting a plan also auto-generates a session title from it. Source: https://code.claude.com/docs/en/permission-modes

`ExitPlanMode` tool contract (v2.1.205, extracted prompt — no plan parameter; the plan is written to a plan file first, the tool signals readiness):

> "Use this tool when you are in plan mode and have finished writing your plan to the plan file and are ready for user approval."

> "This tool simply signals that you're done planning and ready for the user to review and approve."

> "Only use this tool when the task requires planning the implementation steps of a task that requires writing code." (Research-only tasks must not trigger it.)

> "Do NOT use ${ASK_USER_QUESTION_TOOL_NAME} to ask 'Is this plan okay?'" — clarifying questions (e.g. OAuth vs. JWT) must be resolved via AskUserQuestion in earlier phases.

Source: https://raw.githubusercontent.com/Piebald-AI/claude-code-system-prompts/main/system-prompts/tool-description-exitplanmode.md

Read-only "Plan" subagent prompt (v2.1.235) — tool-level enforcement plus prompt-level bash discipline:

- Blocks tools "Edit, Write, Agent, and NotebookEdit"; the agent is "STRICTLY PROHIBITED" from creating/editing/deleting/moving/copying files, "writing temp files, using redirects or heredocs, or running any state-changing shell commands"; allowed exploration is Glob/Grep/Read plus read-only git (`status`, `log`, `diff`); explicitly forbids `mkdir`, `rm`, `git commit`, package installs. Output must end with a "Critical Files for Implementation" section listing 3–5 file paths. Source: https://raw.githubusercontent.com/Piebald-AI/claude-code-system-prompts/main/system-prompts/agent-prompt-plan-mode-enhanced.md

Enforcement internals (secondary source — reverse-engineering writeup of Claude Code, not official):

- Plan mode = "permission downgrade (disabling all write operations)"; injected system attachments tell the model "you can only read, not write"; `EnterPlanMode` throws "EnterPlanMode tool cannot be used in agent contexts" (subagents cannot reach the approval UI).
- `prepareContextForPlanMode()` saves `prePlanMode` so the prior mode (default/auto/bypassPermissions) is restored on exit; `ExitPlanModeV2Tool.call()` reads `restoreMode = prePlanMode ?? 'default'` and clears it.
- `validateInput` rejects ExitPlanMode when not in plan mode: "You are not in plan mode. This tool is only for exiting plan mode..." (guards against compaction/stale tool listings).
- Plan files live in `~/.claude/plans/` as word-slug files (e.g. `bold-eagle.md`); resume uses a 5-layer recovery ladder (disk read → transcript snapshot → `plan` field in ExitPlanMode tool_use blocks → `planContent` on user messages → `plan_file_reference`); forked sessions get a new slug.
- Approval result echoes the full plan text back into the tool result ("Approved Plan (edited by user)" if the user edited it), so the model need not reread the file; a one-time exit attachment is injected next turn: "You've exited plan mode, proceed with implementation".
- Plan-mode instruction injection is throttled: full instructions on turn 1, sparse reminders every ~5 turns, full refresh every 25th turn.
- Source: https://raw.githubusercontent.com/Windy3f3f3f3f/how-claude-code-works/main/en/docs/10-plan-mode.md

#### Todo tracking

Current state (official docs, v2.1.268+): Claude Code now provides four Task tools — `TaskCreate`, `TaskGet`, `TaskUpdate`, `TaskList` — "or `TodoWrite` instead when you set `CLAUDE_CODE_ENABLE_TASKS=0`". Task lifecycle: created `pending` → `in_progress` → `completed`; deleted via `status: "deleted"` in `TaskUpdate`. Example shapes: `TaskCreate { subject: string, activeForm?: string }`, `TaskUpdate { taskId?, status?, activeForm? }` (the harness repairs `id`/`task_id`/`active_form` key variants). Todos are created for tasks with "three or more distinct actions", user-provided lists, longer operations, or explicit requests; "Newer models track multi-step work without a written list" — the tools are opt-out/opt-in by model. Source: https://code.claude.com/docs/en/agent-sdk/todo-tracking

`TodoWrite` contract (v2.1.x extracted prompt):

- Implied schema: `{ "todos": [ { "content": "imperative description", "activeForm": "present continuous form shown during execution", "status": "pending | in_progress | completed" } ] }` (no JSON schema block in the extracted file; statuses: `pending`, `in_progress` "limited to one at a time", `completed`).
- Discipline: use for multi-step tasks requiring 3+ distinct steps; mark `in_progress` before beginning and `completed` immediately after finishing (one at a time); each task needs imperative `content` ("Run tests") and present-continuous `activeForm` ("Running tests"); "never mark tasks completed with failing tests, partial implementation, or unresolved errors"; skip for single/trivial/conversational tasks. Source: https://raw.githubusercontent.com/Piebald-AI/claude-code-system-prompts/main/system-prompts/tool-description-todowrite.md

### OpenAI Codex CLI

#### Todo tracking (`update_plan`) — progress tracking, NOT an approval gate

Verbatim tool spec (Rust source, schema reconstructed from the constructors):

- Tool name: `update_plan`. Description (three lines, `\n`-separated):
  1. "Updates the task plan."
  2. "Provide an optional explanation and a list of plan items, each with a step and status."
  3. "At most one step can be in_progress at a time."
- Schema:

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

- Sources: https://raw.githubusercontent.com/openai/codex/main/codex-rs/core/src/tools/handlers/plan_spec.rs , https://raw.githubusercontent.com/openai/codex/main/codex-rs/protocol/src/plan_tool.rs (doc comment: "Arguments for the `update_plan` todo/checklist tool (not plan mode).")

Prompt contract (base instructions, verbatim excerpts):

> "You have access to an update_plan tool which tracks steps and progress and renders them to the user."

> "Using the tool helps demonstrate that you've understood the task and convey how you're approaching it."

> "Do not use plans for simple or single-step queries that you can just do or answer immediately."

> "Do not repeat the full contents of the plan after an update_plan call — the harness already displays it."

> "Before running a command, consider whether or not you have completed the previous step," ... "make sure to mark it as completed before moving on to the next step".

> "Sometimes, you may need to change plans in the middle of a task: call update_plan with the updated plan" ... "and make sure to provide an explanation of the rationale when doing so."

Use-a-plan-when bullets include: "The task is non-trivial and will require multiple actions over a long time horizon", sequencing dependencies, ambiguity. Source: https://github.com/openai/codex/blob/main/codex-rs/protocol/src/prompts/base_instructions/default.md

Notably, `codex-rs/core/src/context/update_plan_instructions.rs` is a filter (`without_update_plan_instructions`) that strips plan-tool guidance sections ("## Planning", "## `update_plan`", "## Plan tool", "## Plan Mode vs update_plan tool") from Codex-owned prompts when the tool is disabled — custom user instructions are never touched. Source: https://raw.githubusercontent.com/openai/codex/main/codex-rs/core/src/context/update_plan_instructions.rs

#### Plan mode (conversational, shipped separately from `update_plan`)

- TUI: `/plan` slash command — "Switch to plan mode and optionally send a prompt"; guidance: "Ask Codex to propose an execution plan before implementation work starts." Source: https://learn.chatgpt.com/docs/developer-commands?surface=cli (redirect target of developers.openai.com/codex/cli/slash-commands)
- Prompt template (`codex-rs/collaboration-mode-templates/templates/plan.md`, embedded via `pub const PLAN: &str = include_str!("../templates/plan.md")` in the crate's lib.rs): a three-phase conversational workflow — (1) ground in the environment (non-mutating exploration before asking questions), (2) intent chat (goal, success criteria, scope, constraints), (3) implementation chat (approach, interfaces, edge cases, testing). Rules:
  - "Plan Mode persists until a developer message explicitly ends it"; user requests for execution are treated as requests to plan that execution.
  - "`update_plan` is a separate checklist tool and must not be used during Plan Mode".
  - Prefer the `request_user_input` tool with meaningful multiple-choice options; distinguish discoverable facts (explore first) from preferences/tradeoffs (ask early, 2–4 options with recommended default).
  - Output only when the plan is "decision complete", wrapped in `<proposed_plan>` / `</proposed_plan>` tags; plan contains title, summary, public API changes, test cases, assumptions (3–5 sections); at most one proposed-plan block per turn; no "should I proceed?" questions.
  - Sources: https://raw.githubusercontent.com/openai/codex/main/codex-rs/collaboration-mode-templates/templates/plan.md , https://raw.githubusercontent.com/openai/codex/main/codex-rs/collaboration-mode-templates/src/lib.rs
- State machinery (`codex-rs/core/src/context/world_state/collaboration_mode.rs`): `ModeKind::Default | ModeKind::Plan`; mode instructions are emitted as a developer-role fragment wrapped in `COLLABORATION_MODE_OPEN_TAG`/`CLOSE_TAG`, re-emitted only on change (`render_diff`); when in Plan mode the update_plan guidance sections are stripped from the instructions. No tool gating or approval logic lives in this file. Source: https://raw.githubusercontent.com/openai/codex/main/codex-rs/core/src/context/world_state/collaboration_mode.rs
- Thin spot: I could not verify (rate-limited code search) how the TUI detects the `</proposed_plan>` block and what the user approval dialog looks like; the "developer message explicitly ends it" wording implies a harness-sent developer message on user approval. (unverified)

### Gemini CLI (Google)

#### Plan mode

Docs (repo `docs/cli/plan-mode.md` + official announcement):

- "Plan mode is a read-only mode that restricts Gemini CLI to a subset of its tools" — read/list/glob, grep, web search, research subagents, read-only MCP tools; "it cannot modify any files except for its own internal plans" (writes limited to `.md` plan files in a plans directory). Enabled by default. Entry: `/plan [goal]`, `Shift+Tab` cycling, `gemini --approval-mode=plan`, natural language ("start a plan for..."), or default approval mode in `/settings`. Disabling "unregister the enter_plan_mode and exit_plan_mode tools" and removes plan mode from the Shift+Tab rotation. Sources: https://developers.googleblog.com/en/plan-mode-now-available-in-gemini-cli/ , https://raw.githubusercontent.com/google-gemini/gemini-cli/main/docs/cli/plan-mode.md
- Workflow: agent researches, "will ask you questions to clarify your goals" (via `ask_user`), drafts a Markdown plan file; user can view it, edit with `Ctrl+X` in an external editor, then approve, iterate, or cancel with `Esc`. Custom policy rules (e.g. allowing `git status`/`git diff`) live in `~/.gemini/policies/`. Model routing: high-reasoning Pro model for planning, Flash for implementation. Non-interactive mode "auto-approves mode transitions and switches to YOLO mode for execution". Plans retained 30 days by default. Source: https://raw.githubusercontent.com/google-gemini/gemini-cli/main/docs/cli/plan-mode.md

`enter_plan_mode` tool (source: https://raw.githubusercontent.com/google-gemini/gemini-cli/main/packages/core/src/tools/enter-plan-mode.ts and `.../definitions/model-family-sets/default-legacy.ts`):

- Description: "Switch to Plan Mode to safely research, design, and plan complex changes using read-only tools." Params: `{ reason?: string }` ("Short reason explaining why you are entering plan mode.").
- Confirmation text shown to user: "This will restrict the agent to read-only tools to allow for safe planning." `shouldConfirmExecute` consults the policy message bus (allow → no dialog, deny → "...denied by policy.", otherwise ask); on cancel returns "User cancelled entering Plan Mode."; executes `config.setApprovalMode(ApprovalMode.PLAN)` and bootstraps the plans directory.

`exit_plan_mode` tool (source: https://raw.githubusercontent.com/google-gemini/gemini-cli/main/packages/core/src/tools/exit-plan-mode.ts and `.../definitions/dynamic-declaration-helpers.ts`):

- Description: "Finalizes the planning phase and transitions to implementation by presenting the plan for formal user approval." ... "You MUST reach an informal agreement with the user in the chat regarding the proposed strategy BEFORE calling this tool." ... "This tool MUST be used to exit Plan Mode before any source code edits can be performed."
- Schema: `{ plan_filename: string }` — "The filename of the finalized plan (e.g., \"feature-x.md\"). Do not provide an absolute path." (required)
- Logic: validates path (against plans dir + project root) then content; policy bus allow → auto-approve; ask → dialog of type `exit_plan_mode` titled "Plan Approval" showing the resolved plan path. Approved → `setApprovalMode(payload.approvalMode ?? DEFAULT)` (YOLO when non-interactive), `setApprovedPlanPath(planPath)`, returns "Read and follow the plan strictly during implementation." Rejected with feedback → returns feedback + "Revise the plan based on the feedback." Rejected without → "Ask the user for specific feedback on how to improve the plan." Cancelled → "User cancelled the plan approval dialog. The plan was not approved and you are still in Plan Mode."

#### Todo tracking

`write_todos` tool (source: https://raw.githubusercontent.com/google-gemini/gemini-cli/main/packages/core/src/tools/write-todos.ts , declaration text from `.../definitions/model-family-sets/default-legacy.ts`, name literal `'write_todos'` from `.../definitions/base-declarations.ts`):

- Schema: `{ todos: [ { description: string, status: "pending" | "in_progress" | "completed" | "cancelled" | "blocked" } ] }`; "The full list of todos. This will overwrite any existing list." Validation enforces "Only one task can be 'in_progress' at a time."
- Description (verbatim excerpts): "This tool can help you list out the current subtasks that are required to be completed for a given user request. The list of subtasks helps you keep track of the current task, organize complex queries and help ensure that you don't miss any steps. With this list, the user can also see the current progress you are making in executing a given task." State definitions: `in_progress` "Marked just prior to beginning work on a given subtask. You should only have one subtask as in_progress at a time."; `cancelled` for tasks no longer required; `blocked` when it "cannot be completed at this time". Methodology includes: "You must update the todo list as soon as you start, stop or cancel a subtask. Don't batch or wait to update the todo list." "DO NOT use this tool for simple tasks that can be completed in less than 2 steps."
- Result behavior: non-empty list → "Successfully updated the todo list. The current list is now:" followed by numbered `[status] description` lines (result echo substitutes for a read tool); empty list clears it. `returnDisplay: { todos }` drives the progress indicator above the CLI input prompt; full list toggled with `Ctrl+T`; session-scoped. Source: https://geminicli.com/docs/tools/todos/

### OpenCode (anomalyco/opencode, formerly sst/opencode; default branch `dev`)

#### Plan mode

- Plan agent = a primary agent named `plan`, description "Plan mode. Disallows all edit tools." (source: https://raw.githubusercontent.com/anomalyco/opencode/dev/packages/opencode/src/agent/agent.ts). Permissions are a three-way merge: agent defaults → plan-specific config → user config. Agent defaults deny `plan_enter`, `plan_exit`, `question` for everyone; the `build` agent overrides `plan_enter: "allow"` and the `plan` agent overrides `plan_exit: "allow"` and `question: "allow"`, denies `task: { general: "deny" }`, and denies all edits except markdown plans under `.opencode/plans/` and the global plans directory. Docs describe the plan agent as "a restricted agent designed for planning and analysis" toggled with Tab; the docs page shows a config example setting `"permission": { "edit": "deny", "bash": "deny" }` and states defaults "file edits: All writes, patches, and edits" and "bash: All bash commands" are set to `ask`. Sources: https://opencode.ai/docs/agents/ , https://raw.githubusercontent.com/anomalyco/opencode/dev/packages/opencode/src/agent/agent.ts
- `plan_enter` (used by the build agent): description loaded from `plan-enter.txt` — suggests switching to the plan agent when a request "would benefit from planning before implementation"; if the user explicitly mentions wanting a plan, "ALWAYS call this tool first"; don't call for simple tasks. Source: https://raw.githubusercontent.com/anomalyco/opencode/dev/packages/opencode/src/tool/plan-enter.txt
- `plan_exit` (`packages/opencode/src/tool/plan.ts`): no parameters (`Schema.Struct({})`). Logic: resolves the plan file path via `Session.plan(info, instance)` (relative to worktree); asks the user a Yes/No question under header "Build Agent" (declining throws `Question.RejectedError`); on approval it reuses the model from the last user message and writes a synthetic user message routed to `agent: "build"` with a `synthetic: true` text part: "you can now edit files. Execute the plan". Mode switch is done purely by the synthetic agent-switch message, not by mutating permissions in this file. Prompt (`plan-exit.txt`): call it "After you have written a complete plan to the plan file", after clarifying questions, when confident; never "Before you have created or finalized the plan". Sources: https://raw.githubusercontent.com/anomalyco/opencode/dev/packages/opencode/src/tool/plan.ts , https://raw.githubusercontent.com/anomalyco/opencode/dev/packages/opencode/src/tool/plan-exit.txt
- Known enforcement escape: issue #28130 — with `"permission": "allow"` in config, "Plan mode still allows writing"; expected plan-mode read-only to win over the explicit permission. Closed as "not planned" (the explicit permission intentionally takes precedence). Source: https://github.com/anomalyco/opencode/issues/28130

#### Todo tracking

- Tool `todowrite` (`packages/opencode/src/tool/todo.ts`): parameters `todos: Array<Todo.Info>` described "The updated todo list"; permission-gated via `ctx.ask({ permission: "todowrite", patterns: ["*"] })`; executes `todo.update({sessionID, todos})`; returns a title counting non-completed todos, the JSON list as output, and `metadata.todos` for the UI. `Todo.Info` (`@opencode-ai/schema/session-todo`): `content` ("Brief description of the task"), `status` ("pending, in_progress, completed, cancelled"), `priority` ("high, medium, low") — enums conveyed as schema descriptions on plain strings. Update semantics: a transaction that deletes all rows for the session then re-inserts the full list with `position` = array index (snapshot replacement), then publishes an event. Sources: https://raw.githubusercontent.com/anomalyco/opencode/dev/packages/opencode/src/tool/todo.ts , https://raw.githubusercontent.com/anomalyco/opencode/dev/packages/schema/src/session-todo.ts , https://raw.githubusercontent.com/anomalyco/opencode/dev/packages/opencode/src/session/todo.ts
- Prompt (`todowrite.txt`): use proactively for "3+ distinct steps or actions"; four statuses `pending`, `in_progress`, `completed`, `cancelled` with "exactly one item in progress at a time"; update statuses "in real time rather than batching"; mark completion only after verification, "Never based on intent"; if blocked, keep `in_progress` and add a follow-up todo describing the blocker; ends with "When in doubt, use it." Source: https://raw.githubusercontent.com/anomalyco/opencode/dev/packages/opencode/src/tool/todowrite.txt
- Docs note: "This tool is disabled for subagents by default, but you can enable it manually." Source: https://opencode.ai/docs/tools/

### ZCode (firsthand notes — authoritative for ZCode, no public docs)

- `EnterPlanMode`: asks the user for consent to enter plan mode; the model then explores read-only and uses a separate `AskUserQuestion` tool to clarify requirements BEFORE finalizing the plan (explicitly forbidden: using it to ask "Is my plan ready?").
- `ExitPlanMode`: `{ plan: string (1–20000 chars, the complete plan text), allowedPrompts: Bash permission categories needed for implementation }`; user reviews the plan content and approves; implementation begins only after approval.
- `TodoWrite`: `{ todos: [{ content, status: pending|in_progress|completed, priority: high|medium|low }] }` — full list replaces previous state each call; at most one `in_progress`; rendered to the user as the visible working plan. `TodoRead` returns the list.

## Gaps and pitfalls

- Bash is the universal plan-mode escape hatch. Gating edit/write tools does not stop `bash -c "echo ... > file"`, `sed -i`, `git commit`, or `npm install` side effects. Approaches observed: Claude Code runs a classifier over shell commands during planning (auto mode) or prompts for anything outside a built-in read-only set; the Claude plan subagent prompt additionally forbids "redirects or heredocs" and state-changing commands at prompt level (belt and suspenders — the prompt alone is not enforcement); Gemini restricts the toolset and allows extra commands only via user policy files; OpenCode's docs show plan-agent bash defaulting to `ask` (config can hard-deny). A harness that only swaps out edit/write tools while leaving bash unfiltered has a hole.
- Enforcement point conflicts. OpenCode issue #28130 shows the failure mode: a global `"permission": "allow"` beat the plan agent's read-only restriction, and the maintainers closed it as not planned — i.e., their permission merge (defaults → mode → user config, user wins) does not treat plan mode as an absolute cap. Decide explicitly whether plan mode is a hard cap that overrides user permission grants or just another layer in the merge.
- Stale/absent approval state. Claude guards `ExitPlanMode` with `validateInput` ("You are not in plan mode...") because compaction, stale tool listings, or throttled mode reminders can make the model call it out of turn; subagents are blocked from `EnterPlanMode` entirely because they cannot reach an approval UI. Any pi implementation needs a session-level mode flag checked in the tool layer, not just in the prompt.
- Todo staleness is prompt-discipline, not machinery. Every harness repeats the same contract language (update "as soon as you start, stop or cancel", "in real time rather than batching", mark completed "before moving on", never mark completed with failing tests / "Never based on intent"). Only the single-`in_progress` invariant is machine-enforced (Gemini validation rejects it; Codex puts "At most one step can be in_progress at a time" in the tool description; Claude says "limited to one at a time"). Expect the model to drift; the TUI rendering is what makes drift visible to the user.
- Don't let the model re-narrate state the harness already renders. Codex: "Do not repeat the full contents of the plan after an update_plan call — the harness already displays it." Gemini returns the current list in the tool result as the read-back mechanism (no separate read tool). Claude echoes the approved plan text into the ExitPlanMode result so the model doesn't reread the plan file.
- Approval UX in a TUI ranges from minimal to rich: OpenCode is a plain Yes/No ("Build Agent" switch); Gemini is a Plan Approval dialog with external-editor editing (`Ctrl+X`), `Esc` cancel, and rejection-with-freeform-feedback that is fed back to the model ("Revise the plan based on the feedback"); Claude offers 3–4 permission-mode choices plus `Ctrl+G` editor editing and an optional clear-context-on-approve. The rejection-with-feedback loop and the "which permission mode do we land in after approval" decision are the two load-bearing UX pieces; the choice set is not.
- Plan durability differs: Claude writes plans to `~/.claude/plans/<word-slug>.md` with transcript-snapshot recovery; Gemini writes to a plans directory (30-day retention) and `exit_plan_mode` takes only a `plan_filename`; OpenCode's plan agent writes to `.opencode/plans/`. ZCode passes the plan inline (1–20000 chars) in the tool call — simplest, but the plan then lives only in the transcript unless the harness persists it; Claude's older ExitPlanMode also took inline `plan` text before moving to the plan-file design (unverified for the exact transition point).
- Post-approval permission transition must be explicit: Claude saves/restores `prePlanMode` (default/auto/bypass) with a circuit-breaker fallback; Gemini's approved payload carries the target approval mode (DEFAULT, or YOLO when non-interactive); OpenCode re-routes to the build agent via a synthetic user message. Ambiguity here means either over-permissioning after a trivial plan or re-prompting for every edit after a full plan.

## Design takeaways for pi

- Keep the two features orthogonal, matching all five harnesses: plan mode = a permission mode + approval gate; todos = one stateless tool + TUI rendering. Codex's own naming ("the `update_plan` todo/checklist tool (not plan mode)") and its rule that `update_plan` "must not be used during Plan Mode" show these are deliberately separate even where both exist.
- Plan mode as a toolset toggle plus two tools fits pi's minimalism: a session-level mode (enter via user keybinding/slash command or an `EnterPlanMode`-style tool that asks consent) that swaps the enabled toolset to read-only (read/grep/find/ls) and adds an `ExitPlanMode`-style tool whose result requires user approval. pi's extension lifecycle + custom tools are sufficient machinery; no core-loop change strictly required, but a hard deny on edit/write/bash in the tool layer is the enforcement point (prompt text alone is not).
- Handle bash explicitly: either deny `bash` in plan mode (OpenCode-style, simplest) or ship a plan-mode command allowlist (read-only git, ls, cat, grep...) with everything else routed to the existing permission prompt. Do not rely on the model's good behavior; Claude's plan-subagent prompt proves vendors still add prompt-level "no redirects/heredocs/state-changing commands" rules on top of mechanical gating.
- Approval gate: render the plan, offer approve / reject-with-feedback / keep-planning (an "edit in `$EDITOR`" affordance is cheap to add since pi has a TUI). Feed rejection text back into the next model turn (Gemini's exact loop) and decide the post-approval permission mode up front — restoring the pre-plan mode (Claude's `prePlanMode`) is the least surprising default.
- Prefer a plan file over an inline plan parameter if durability matters: write the approved plan under e.g. `.pi/plans/`, have the post-approval instruction say "read and follow the plan" (Gemini's "Read and follow the plan strictly during implementation"), and echo the approved plan text into the tool result. ZCode's inline 1–20000-char `plan` plus `allowedPrompts` (pre-requested bash categories) is a viable minimal variant; `allowedPrompts` maps naturally onto pi's existing permission model.
- If a clarifying-question tool ships, gate it to the planning phase and keep Claude's verbatim anti-pattern rule ("Do NOT use AskUserQuestion to ask 'Is this plan okay?'") — every harness with plan mode has a dedicated ask tool (AskUserQuestion / ask_user / request_user_input / ZCode AskUserQuestion / OpenCode `question` allowed for the plan agent) and the same misuse risk.
- Todo tool: single `TodoWrite{todos: [{content, status, priority?}]}` with full-list replacement semantics (Gemini/OpenCode/ZCode/Claude all replace the whole list each call), validation enforcing at most one `in_progress`, and statuses `pending|in_progress|completed` (+`cancelled` if cheap — it prevents list clutter; `blocked` is Gemini-only). Store the list on the session (OpenCode persists per-session with position) so it survives compaction and renders on resume; returning the current list in the tool result substitutes for a separate TodoRead/TodoList (Gemini's approach; matches pi's minimalism better than Claude's four Task tools).
- TUI rendering is the point of the feature: a persistent status line/panel (Gemini's indicator above the input with `Ctrl+T` to expand; ZCode renders "the visible working plan"). Include the anti-redundancy prompt line (Codex: the harness already displays it) so the model stops re-printing the list in prose.

## Sources

- https://code.claude.com/docs/en/common-workflows
- https://code.claude.com/docs/en/permission-modes
- https://code.claude.com/docs/en/agent-sdk/todo-tracking
- https://raw.githubusercontent.com/Piebald-AI/claude-code-system-prompts/main/system-prompts/tool-description-exitplanmode.md
- https://raw.githubusercontent.com/Piebald-AI/claude-code-system-prompts/main/system-prompts/tool-description-todowrite.md
- https://raw.githubusercontent.com/Piebald-AI/claude-code-system-prompts/main/system-prompts/agent-prompt-plan-mode-enhanced.md
- https://raw.githubusercontent.com/Windy3f3f3f3f/how-claude-code-works/main/en/docs/10-plan-mode.md (secondary, reverse-engineering)
- https://raw.githubusercontent.com/openai/codex/main/codex-rs/core/src/tools/handlers/plan_spec.rs
- https://raw.githubusercontent.com/openai/codex/main/codex-rs/protocol/src/plan_tool.rs
- https://raw.githubusercontent.com/openai/codex/main/codex-rs/protocol/src/prompts/base_instructions/default.md
- https://raw.githubusercontent.com/openai/codex/main/codex-rs/core/src/context/update_plan_instructions.rs
- https://raw.githubusercontent.com/openai/codex/main/codex-rs/collaboration-mode-templates/templates/plan.md
- https://raw.githubusercontent.com/openai/codex/main/codex-rs/collaboration-mode-templates/src/lib.rs
- https://raw.githubusercontent.com/openai/codex/main/codex-rs/core/src/context/world_state/collaboration_mode.rs
- https://learn.chatgpt.com/docs/developer-commands?surface=cli (Codex slash commands; redirect target of developers.openai.com/codex/cli/slash-commands)
- https://developers.googleblog.com/en/plan-mode-now-available-in-gemini-cli/
- https://raw.githubusercontent.com/google-gemini/gemini-cli/main/docs/cli/plan-mode.md
- https://raw.githubusercontent.com/google-gemini/gemini-cli/main/packages/core/src/tools/enter-plan-mode.ts
- https://raw.githubusercontent.com/google-gemini/gemini-cli/main/packages/core/src/tools/exit-plan-mode.ts
- https://raw.githubusercontent.com/google-gemini/gemini-cli/main/packages/core/src/tools/write-todos.ts
- https://raw.githubusercontent.com/google-gemini/gemini-cli/main/packages/core/src/tools/definitions/base-declarations.ts
- https://raw.githubusercontent.com/google-gemini/gemini-cli/main/packages/core/src/tools/definitions/model-family-sets/default-legacy.ts
- https://raw.githubusercontent.com/google-gemini/gemini-cli/main/packages/core/src/tools/definitions/dynamic-declaration-helpers.ts
- https://geminicli.com/docs/tools/todos/
- https://opencode.ai/docs/agents/
- https://opencode.ai/docs/tools/
- https://raw.githubusercontent.com/anomalyco/opencode/dev/packages/opencode/src/agent/agent.ts
- https://raw.githubusercontent.com/anomalyco/opencode/dev/packages/opencode/src/tool/plan.ts
- https://raw.githubusercontent.com/anomalyco/opencode/dev/packages/opencode/src/tool/plan-enter.txt
- https://raw.githubusercontent.com/anomalyco/opencode/dev/packages/opencode/src/tool/plan-exit.txt
- https://raw.githubusercontent.com/anomalyco/opencode/dev/packages/opencode/src/tool/todo.ts
- https://raw.githubusercontent.com/anomalyco/opencode/dev/packages/opencode/src/tool/todowrite.txt
- https://raw.githubusercontent.com/anomalyco/opencode/dev/packages/opencode/src/session/todo.ts
- https://raw.githubusercontent.com/anomalyco/opencode/dev/packages/schema/src/session-todo.ts
- https://github.com/anomalyco/opencode/issues/28130
