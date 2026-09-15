# Feature 06: Background Bash Execution

Add a `run_in_background` parameter to the `bash` tool that spawns the command detached from the agent turn, returns immediately with an opaque task ID and a per-task output-file path, and re-invokes the model with a task-notification message when the process exits. Backing it: a per-session `BackgroundTaskManager` registry (opaque IDs, never PIDs), a `task_stop` tool that kills the whole process tree, a `/tasks` slash command for the user, size caps on captured output, and process-tree kill on session exit reusing pi's existing `killProcessTree` / `trackDetachedChildPid` machinery. Output retrieval needs no new tool: the model uses the existing `read` tool on the output-file path (the converged Claude Code Gen 2 / ZCode design).

## Metadata

- Priority: medium
- Effort: large (new subsystem: registry + watcher + notification plumbing + 2 tool surfaces + TUI command + tests)
- Risk: medium (process lifecycle, re-invoke races, orphaned processes on crash)
- Depends on: nothing (builds on existing `AgentSession.sendCustomMessage`, `killProcessTree`, `OutputAccumulator`-style temp-file conventions)
- Research: feature-tasks/research/06-background-bash.md

## Problem

Today every `bash` tool call blocks the agent turn until the process exits. Trace: `createShellToolDefinition.execute` (`packages/coding-agent/src/core/tools/bash.ts`, line 239) awaits `ops.exec(...)` (line 341), which is `createLocalShellOperations.exec` (line 81) waiting on `waitForChildProcess(child)` (line 130). The agent loop's `executeToolCalls` (`packages/agent/src/agent-loop.ts`, line 409) awaits that result before the next LLM call, and the TUI shows the tool as running the whole time.

Concrete failures:

- The model runs `npm test` on a suite that takes 5 minutes. Either the model passes `timeout: 300` and the entire interactive session is blocked for 5 minutes (user can steer, but the turn cannot proceed), or it omits `timeout` (pi has no default timeout — `bashSchema` line 39 says "optional, no default timeout") and the session blocks indefinitely if the command hangs.
- Dev servers, watchers, and `npm run dev` are unusable: they never exit, so the tool call never returns. The only workaround today is `command &` shell tricks, which lose output and leak processes that pi never reaps (pi kills only PIDs it tracks; a `&`-backgrounded child re-parented away survives session exit).

What is needed: a way for the model to start a command, keep working, and be told when it finishes — with output preserved on disk.

## Prior art

(Verbatim prompt language and mechanisms from the research dossier; URLs at the end of the section.)

**Claude Code Gen 2 (current) — file + notification. The primary model for this spec.**
- Param: `run_in_background: boolean` — "Set to true to run this command in the background."
- Verbatim usage notes: "You can use the `run_in_background` parameter to run the command in the background. Only use this if you don't need the result immediately and are OK are being notified when the command completes later. You do not need to check the output right away - you'll be notified when it finishes. You do not need to use '&' at the end of the command when using this parameter." / "If your command is long running and you would like to be notified when it finishes — use `run_in_background`. No sleep needed." / "If waiting for a background task you started with `run_in_background`, you will be notified when it completes — do not poll."
- Retrieval: tool result returns an output-file path; the model uses the `Read` tool on it. TaskOutput (wait/poll, `block=true`, timeout 0–600000) exists only as a deprecated fallback: "DEPRECATED: Background tasks return their output file path in the tool result, and you receive a `<task-notification>` with the same path when the task completes. For bash tasks: prefer using the Read tool on that output file path — it contains stdout/stderr."
- Re-invoke: a `<task-notification>` arrives as a separate turn when the task exits; "when harness-tracked work finishes, you are re-invoked automatically, so polling is wasted". `TaskStop(task_id)` stops it; `/tasks` lists task IDs.
- Process cleanup: "Background tasks are automatically cleaned up when Claude Code exits", including processes that re-detached via `setsid`/`timeout`; "automatically terminated if output exceeds 5GB"; in headless mode "background commands end shortly after the run's final result".
- Sources: https://raw.githubusercontent.com/asgeirtj/system_prompts_leaks/main/Anthropic/claude-code/claude-code-sonnet-5.md ; https://code.claude.com/docs/en/interactive-mode ; https://code.claude.com/docs/en/tools-reference

**Claude Code Gen 1 — poll-based (rejected).** `BashOutput(bash_id)` diff-per-poll, no exit notification, `/bashes` command. Invited sleep loops; both Claude and ZCode later converged on "do not poll, you will be notified". Source: https://github.com/x1xhlol/system-prompts-and-models-of-ai-tools (`Anthropic/Claude Code/Tools.json`).

**Gemini CLI — PID-keyed registry (mechanism reference, keying rejected).** `is_background` param with `BACKGROUND_DELAY_MS = 200` grace ("If the model requested to run in the background, do so after a short delay" — commands finishing within the grace return normally); per-PID log files `<tmp>/background-processes/background-<pid>.log`, ANSI-stripped; `read_background_output(pid, lines)` tail reads capped at 64KB; `list_background_processes()`; exit injection configurable (`inject` full output / `notify` pointer / `silent`) via an InjectionService that reinjects into the conversation; `killProcessGroup({ pid })`. Pitfall: PID-keyed logs required an explicit ownership check ("Access denied. Background process ID ... not found in this session's history") because PIDs are guessable and cross-session reads are otherwise possible. Sources: https://github.com/google-gemini/gemini-cli/blob/main/packages/core/src/tools/shell.ts , .../tools/shellBackgroundTools.ts , .../services/shellExecutionService.ts , .../services/executionLifecycleService.ts , .../config/injectionService.ts , https://github.com/google-gemini/gemini-cli/blob/main/docs/tools/shell.md

**OpenAI Codex CLI — yield-then-session (rejected).** `unified_exec` returns a `session_id` at `yield_time_ms` (250–30000ms) and the model must come back with `write_stdin(session_id, ...)`; no automatic re-invoke. Sources: https://github.com/openai/codex/blob/main/codex-rs/core/src/tools/handlers/unified_exec/exec_command.rs , .../unified_exec/write_stdin.rs , .../unified_exec/process_manager.rs

**Amp / OpenCode — no background shell (context).** Amp bans `&` outright ("Do NOT use the single `&` operator to run background processes"); OpenCode removed background launch pending durability, leaving TODOs: "Re-add model-facing background launch only with owner-bound get/wait/cancel tools and completion delivery." OpenCode's keepers: `detached: process.platform !== "win32"`, SIGTERM→SIGKILL escalation with 3s force-kill, 1MB in-memory capture cap with notice. Prompt-only bans just push models to `nohup`/`setsid` hacks. Sources: https://raw.githubusercontent.com/x1xhlol/system-prompts-and-models-of-ai-tools/main/Amp/gpt-5.yaml ; https://github.com/sst/opencode/blob/dev/packages/core/src/tool/bash.ts

**ZCode (firsthand).** Functionally identical to Claude Code Gen 2: `run_in_background`, output-file path in result, exit re-invoke, `TaskOutput`/`TaskStop`, `/tasks`.

## Proposed design

### `run_in_background` parameter semantics

- Added to `bashSchema` in `packages/coding-agent/src/core/tools/bash.ts` as `Type.Optional(Type.Boolean({ description: "Set to true to run this command in the background. Returns immediately with a task ID and an output file path; you will be notified when the command exits. Do not append '&' to the command." }))`.
- When true, `execute` resolves `spawnContext` exactly as the foreground path does (command prefix, spawn hook, env, `ctx?.cwd || cwd`), then delegates to the session's `BackgroundTaskManager` instead of `ops.exec`. It does not pass the abort `signal` and ignores `timeout` (documented in the schema description: background tasks run until exit, stop, or session end). The turn's abort must not kill a background task — main-session commands keep running across turns (Claude's rule).
- Grace period (from Gemini): `BACKGROUND_START_GRACE_MS = 200`. If the process exits within the grace window, the call returns a normal foreground-shaped result (exit code + output text) and no task is registered and no notification fires. This avoids degenerate "background a 50ms echo" results without prompt-text-only mitigation.
- Normal background result text:

  ```
  Background task started (task ID: task-<id>).
  Command: <command>
  Output file: <tmpdir>/pi-task-task-<id>.log

  The task keeps running across turns. Read the output file to inspect progress.
  You will be notified when the command exits; do not poll or sleep while waiting.
  ```

  `details` gains `backgroundTask: { id, outputPath }` (extends `BashToolDetails`).
- Custom `BashOperations` (remote SSH/container overrides via `BashToolOptions.operations`) cannot support background execution because `BashOperations.exec` is await-until-exit by contract. If `run_in_background` is set while custom operations are in effect, the tool returns an error result: "run_in_background is only supported with the local shell."
- Kill switch: `PI_DISABLE_BACKGROUND_TASKS=1` makes the bash tool reject `run_in_background` with an explanatory error (mirrors `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1`).
- Note on cwd: pi spawns a fresh shell per command with an explicit cwd, so Claude's "cd never carries over into a backgrounded command" pitfall does not apply — each background command runs in the session cwd captured at start time. No special warning text is needed.

### Task registry — opaque IDs, not PIDs

New module `packages/coding-agent/src/core/background-tasks.ts` exporting `BackgroundTaskManager`. One instance per `AgentSession`, created in the session constructor, passed to the bash tool via `BashToolOptions`.

Keyed by opaque IDs `task-<16 hex>` (`randomBytes(8).toString("hex")`, matching the `pi-bash-<hex>` temp-file convention in `bash-executor.ts`), never by PID. Justification from the dossier pitfalls: PIDs are guessable and reused across process lifetimes, which forced Gemini to add an explicit per-session ownership check on its PID-keyed log reads; an opaque random ID is unguessable and scoped to the in-memory registry of one session, so cross-session reads cannot be requested by guessing. `pid` is stored on the record (needed for `killProcessTree`) but is never the lookup key or the model-facing identifier.

Record shape:

```ts
export type BackgroundTaskStatus = "running" | "exited" | "stopped";

export interface BackgroundTaskRecord {
	id: string;
	command: string;
	cwd: string;
	pid: number | undefined;
	outputPath: string;
	status: BackgroundTaskStatus;
	exitCode: number | undefined;
	startedAt: number;
	endedAt: number | undefined;
	/** Why a record has status "stopped": model-requested stop, session disposal, or output cap. */
	stopReason: "task_stop" | "session-disposed" | "output-limit" | undefined;
}
```

The registry is in-memory only and dies with the process. It is never persisted, so a restarted or resumed session never presents stale task IDs as "running" (OpenCode's durability TODO is explicitly out of scope). Output files survive on disk, and the notification text (persisted in session history as a custom message, see below) still names the path, so a resumed session's model can `read` the file post-mortem.

### Output files, caps, sanitization

- Path: `join(tmpdir(), "pi-task-<id>.log")`, created eagerly at task start (the path is returned before any output exists, so the file must exist from the start; the `read` tool treats an empty file fine).
- Content: stdout and stderr interleaved, sanitized exactly like the foreground executor (`bash-executor.ts` line 82): `sanitizeBinaryOutput(stripAnsi(decoder.decode(data, { stream: true }))).replace(/\r/g, "")`. Pipes, never a PTY (dossier: deterministic, strippable).
- Hard cap `BACKGROUND_TASK_MAX_OUTPUT_BYTES = 256 * 1024 * 1024` (256MB). Claude kills at 5GB, which is disk-hostile for a chatty dev server; 256MB is far beyond any useful log tail while bounded. On breach: kill the process tree, append `\n[Task stopped: output exceeded 256MB limit]` to the file, set status `stopped` / `stopReason: "output-limit"`, and still fire the exit notification so the model learns the task was capped.
- Files are left on disk after task end and session exit (post-mortem reads). They live in the OS tmpdir like pi's existing `pi-bash-*.log` spill files; no cleanup job is added.

### Exit notification mapped onto pi's event flow

The integration point is `AgentSession.sendCustomMessage` (`packages/coding-agent/src/core/agent-session.ts`, line 1503). Verified behavior:

- Idle + `triggerTurn: true` → `_runAgentPrompt(appMessage)` (line 1101) → `agent.prompt(...)` — a synthetic turn that re-invokes the model.
- Streaming + `deliverAs: "followUp"` → `agent.followUp(appMessage)` — the agent loop drains follow-ups before emitting `agent_end` (`packages/agent/src/agent-loop.ts`, lines 260–266), and `_handlePostAgentRun` (line 1116) continues the run while `agent.hasQueuedMessages()`.
- `CustomMessage` with `customType: "taskNotification"` is persisted via `appendCustomMessageEntry` (so it survives resume) and converted to a `user`-role message for the LLM by `convertToLlm` (`core/messages.ts`, line 162) — exactly the "injection" channel Gemini built a service for, already present in pi.

Flow:

1. `BackgroundTaskManager` spawns the process and watches it with `waitForChildProcess` (`utils/child-process.ts`, line 49). On exit it finalizes the record and invokes the constructor-injected `onTaskExit(record)` callback. Callback invocations are serialized through a chained promise (`notifyQueue`) so concurrent exits cannot race two `agent.prompt` calls into "Agent is already processing".
2. `AgentSession._handleBackgroundTaskExit(record)`:
   - Emits a new `AgentSessionEvent` variant `{ type: "background_task_exit"; task: BackgroundTaskRecord }` (added next to `bash_execution_update` at line 185) for UI listeners.
   - Builds the notification text:
     ```
     <task-notification>
     Background task task-<id> exited with code <exitCode> after <duration>s.
     Command: <command>
     Output file: <outputPath>
     Read the output file for full stdout/stderr.
     </task-notification>
     ```
   - If `this.isStreaming`: `await this.sendCustomMessage({ customType: "taskNotification", content, display: true }, { deliverAs: "followUp" })`, then `await this.waitForIdle()`; if the run ended between queueing and the loop's final drain check (`this.isIdle && this.agent.hasQueuedMessages()`), drain by mirroring `_runAgentPrompt`'s lifecycle around `this.agent.continue()` (which drains the follow-up queue when the last message is assistant — `packages/agent/src/agent.ts`, lines 371–383).
   - Else if `this.model` is set: `await this.sendCustomMessage(..., { triggerTurn: true })`.
   - Else (no model yet): append without a turn (`sendCustomMessage` with no options).
   - Guard the `triggerTurn` branch in try/catch: if `agent.prompt` throws "already processing" (a run started between the `isStreaming` check and the call), fall back to `agent.followUp`.
3. Stopped tasks (`TaskStop`, `stopAll`, output cap excepted) do not re-invoke the model when the stop was model-requested or session-initiated; only `output-limit` and natural exits notify.

### TaskStop tool

New file `packages/coding-agent/src/core/tools/task-stop.ts`:

```ts
const taskStopSchema = Type.Object({
	task_id: Type.String({ description: "ID of the background task to stop. Task IDs come from bash run_in_background results or the /tasks command." }),
});
```

- `execute` calls `manager.stop(task_id)`; success returns `Stopped background task task-<id> (command: <command>). Partial output is in <outputPath>.`; unknown/finished IDs return an error result `No running background task with ID <task_id>. Use /tasks output or prior results to check IDs.` (error, not throw-with-stack noise — same text-shape as other tool errors).
- `stop(id)` semantics: SIGTERM to the process group (`process.kill(-pid, "SIGTERM")`), then after `STOP_FORCE_KILL_MS = 3000` (OpenCode's escalation window) `killProcessTree(pid)` (`utils/shell.ts`, line 216 — process-group SIGKILL via `-pid`; `taskkill /F /T` on Windows). On Windows there is no graceful group-SIGTERM; call `killProcessTree` directly. The record moves to `status: "stopped"` immediately; the watcher's eventual exit resolution must not overwrite a `stopped` record back to `exited`.
- Registered as tool name `task_stop`, always in the default active set (see implementation plan for the wiring point). Not added to the `ToolName` union in `core/tools/index.ts` — the session-level registry map is `Map<string, ToolDefinition>` and accepts it directly; adding to the union would force `allToolNames`/`createToolDefinition` switch coverage for a tool that only makes sense with a session-owned manager.

### `/tasks` command

- Add `{ name: "tasks", description: "List background bash tasks" }` to `BUILTIN_SLASH_COMMANDS` (`core/slash-commands.ts`).
- Handler in `setupEditorSubmitHandler` (`modes/interactive/interactive-mode.ts`, line 2983, alongside `/session`), implemented like `handleSessionCommand` (line 6236): build a text block from `this.session.getBackgroundTasks()` — one line per task: `task-<id>  running|exited(0)|stopped  <startedAt age>  <command>` plus the output path — and append it to `this.chatContainer` with `this.ui.requestRender()`. Empty state: "No background tasks."

### TUI behavior while tasks run

Background output never streams into the transcript: the background branch of `execute` returns immediately and never calls `onUpdate`, so there is no flicker or context pollution (dossier pitfall). Surfacing is limited to: a `showStatus` line when `background_task_exit` arrives (the interactive mode's session subscription), the custom `taskNotification` message rendered in the transcript like other display custom messages, and `/tasks` on demand.

### Process-tree kill on session exit

Reuse of existing machinery, verified:

- The background spawn calls `trackDetachedChildPid(child.pid)` (`utils/shell.ts`, line 198) and only untracks on exit or stop. Because the background `exec`-equivalent never resolves early, the PID stays tracked for the task's whole life.
- `killTrackedDetachedChildren()` (line 206) is already invoked from every exit path: interactive SIGTERM/SIGHUP and crash handlers (`interactive-mode.ts`, lines 4016, 4042, 4074), print mode (`modes/print-mode.ts`, line 58 — kills background tasks right after the final result, which reproduces Claude's headless semantics for `pi -p`), and RPC mode (`modes/rpc/rpc-mode.ts`, line 374). No changes needed in those modes.
- Belt and braces: `AgentSession.dispose()` (line 877) calls `this._backgroundTasks.stopAll("session-disposed")` before `cleanupSessionResources(this.sessionId)` (line 893), so SDK-embedded sessions that never hit a mode's signal handlers also sweep. `stopAll` also closes output write streams.

### Interaction with the file-mutation queue

None. `withFileMutationQueue` (`core/tools/file-mutation-queue.ts`) serializes `edit`/`write` operations on the same file; the bash tool does not use it (neither foreground nor background), and background output files are task-private paths no other tool writes. Called out here only to record that it was considered.

### Out of scope

- Claude's streaming `Monitor` tool (per-line events); this spec delivers exactly one notification per task on exit.
- Auto-move-to-background on foreground timeout (Claude's "was moved to the background" result). pi keeps kill-on-timeout; follow-up feature.
- `TaskOutput` blocking-wait tool. `read` on the output file covers retrieval; Claude deprecated its own equivalent in favor of this.
- Registry persistence / restart recovery / re-attaching to surviving processes after a pi crash (OpenCode removed the feature rather than ship without this; pi ships the in-memory version with durable output files instead).
- Remote `BashOperations` (SSH/containers) background support.
- `run_in_background` for user `!` bash commands (`AgentSession.executeBash`) and any Ctrl+B-style user keybinding to foreground-background a running call.
- PowerShell tool parity.
- Per-task wall-clock timeouts (no timeout by design; cap + session-exit kill bound the damage).

## Implementation plan

Ordered; all paths under `packages/coding-agent/` unless noted. Snippets are erasable-TypeScript (Node strip-only): no enums, namespaces, parameter properties, or `import =`.

1. **`src/utils/shell.ts` — extract a shared spawn helper.** Export `spawnShellProcess(command: string, cwd: string, env: NodeJS.ProcessEnv, customShellPath?: string): ChildProcess` that encapsulates what `createLocalShellOperations.exec` does at `core/tools/bash.ts` lines 93–105: `getShellConfig(customShellPath)`, the `commandTransport === "stdin"` legacy-WSL handling (`child.stdin?.end(command)` plus the stdin error swallow), `detached: process.platform !== "win32"`, `stdio: [stdin|"ignore", "pipe", "pipe"]`, `windowsHide: true`, and `trackDetachedChildPid` when `child.pid` is set. Refactor `createLocalShellOperations.exec` to call it (behavior unchanged; its `fsAccess` cwd precheck and timeout/abort handling stay in `exec`). This keeps one spawn path for foreground and background.

2. **`src/core/background-tasks.ts` — new module.** Constants, record/manager types as designed above, plus:

   ```ts
   export type BackgroundTaskStartResult =
   	| { kind: "completed"; exitCode: number | null; output: string; outputPath: string }
   	| { kind: "running"; task: BackgroundTaskRecord };

   export interface BackgroundTaskManagerOptions {
   	onTaskExit?: (task: BackgroundTaskRecord) => void | Promise<void>;
   	graceMs?: number;
   	maxOutputBytes?: number;
   	forceKillMs?: number;
   }

   export class BackgroundTaskManager {
   	private readonly tasks = new Map<string, BackgroundTaskRecord>();
   	private readonly onTaskExit: ((task: BackgroundTaskRecord) => void | Promise<void>) | undefined;
   	private readonly graceMs: number;
   	private readonly maxOutputBytes: number;
   	private readonly forceKillMs: number;
   	private notifyQueue: Promise<void> = Promise.resolve();

   	constructor(options: BackgroundTaskManagerOptions) {
   		this.onTaskExit = options.onTaskExit;
   		this.graceMs = options.graceMs ?? BACKGROUND_START_GRACE_MS;
   		this.maxOutputBytes = options.maxOutputBytes ?? BACKGROUND_TASK_MAX_OUTPUT_BYTES;
   		this.forceKillMs = options.forceKillMs ?? STOP_FORCE_KILL_MS;
   	}
   	// start(), stop(), stopAll(), get(), list()
   }
   ```

   - `start({ command, cwd, env })`: create `id` and `outputPath`, `createWriteStream(outputPath)`, spawn via `spawnShellProcess`, attach `stdout`/`stderr` `data` handlers that sanitize (as designed above) and write to the stream while counting bytes (kill + cap path on breach), record `pid`, then race `waitForChildProcess(child)` against a `graceMs` timer:
     - exited within grace → `end()` the stream, build `output` from the buffered sanitized text capped with `truncateTail` (`core/tools/truncate.ts`), return `{ kind: "completed", ... }`.
     - grace elapsed and still running → register the record, return `{ kind: "running", task }`. The watcher promise (registered at spawn) continues: on exit it finalizes the record (unless already `stopped`), appends the exit line, ends the stream, `untrackDetachedChildPid`, and runs `onTaskExit` through `notifyQueue` chaining.
   - `stop(id)`: as designed (SIGTERM group → `forceKillMs` → `killProcessTree`; direct `killProcessTree` on Windows). Returns `false` for unknown/non-running IDs.
   - `stopAll(reason)`: `stop` every `running` record with the given reason; also `end()` any open streams.
   - Buffer during grace: cap the in-memory buffer at `DEFAULT_MAX_BYTES * 2` with the same rolling-drop used in `bash-executor.ts` lines 93–99 so a firehose command cannot balloon memory in 200ms.

3. **`src/core/tools/bash.ts` — parameter and branch.**
   - Extend `bashSchema` (line 37) with `run_in_background` and update the tool `description` (line 234) to mention it.
   - Extend `BashToolDetails` (line 49) with `backgroundTask?: { id: string; outputPath: string }`.
   - Extend `BashToolOptions` (line 193) with `backgroundTasks?: BackgroundTaskManager` (top-level import from `../background-tasks.ts`).
   - In `createShellToolDefinition`, capture `backgroundTasks` from `options` next to `spawnHook` (line 230), and in `execute` (line 239) destructure `run_in_background`; after `spawnContext` is resolved (line 253), branch:
     - `PI_DISABLE_BACKGROUND_TASKS=1` → error result.
     - `options?.operations` present → error result (custom ops unsupported).
     - missing manager → error result.
     - `kind: "completed"` → return a foreground-shaped success/error result using the grace output and exit code (reuse `appendStatus` semantics: non-zero exit is an error result with `Command exited with code N`).
     - `kind: "running"` → return the background result text and `details.backgroundTask`.
   - Extend `bashToolSystemPromptContribution.guidelines` (line 44) with: "Use the bash tool's run_in_background parameter for long-running commands (dev servers, test suites, watchers). It returns a task ID and an output file path immediately; read that file with the read tool to inspect output. You will be notified when the task exits — do not sleep, poll, or append '&' to the command. Use the task_stop tool with a task ID to stop a background task." (These flow into the system prompt via `bashToolConfig.promptGuidelines` → line 236.)

4. **`src/core/tools/task-stop.ts` — new tool.** Schema and `createTaskStopToolDefinition(manager: BackgroundTaskManager): ToolDefinition<...>` per the design section. Give it `promptSnippet: "Stop background tasks"` and one `promptGuidelines` entry. Keep it in the `createShellToolDefinition` style but with no renderers and `constrainedSampling: { type: "json_schema", strict: "prefer" }`.

5. **`src/core/tools/index.ts` — exports.** Re-export the new public symbols (`BackgroundTaskManager`, record/result types, `createTaskStopToolDefinition`). Do not touch `ToolName`/`allToolNames`.

6. **`src/core/agent-session.ts` — wiring and notification.**
   - Import `BackgroundTaskManager`, `BackgroundTaskRecord` from `./background-tasks.ts` and `createTaskStopToolDefinition` from `./tools/task-stop.ts`.
   - Add the `AgentSessionEvent` variant (near line 185): `| { type: "background_task_exit"; task: BackgroundTaskRecord }`.
   - Field `private readonly _backgroundTasks: BackgroundTaskManager;` assigned in the constructor **before** the `this._buildRuntime(...)` call at line 402 (the manager must survive `_buildRuntime` re-runs from `reload()`, line 2841 — tasks keep running across `/reload`):
     ```ts
     this._backgroundTasks = new BackgroundTaskManager({
     	onTaskExit: (task) => this._handleBackgroundTaskExit(task),
     });
     ```
   - In `_buildRuntime` (line 2787): pass the manager into the bash options (line 2804): `bash: { commandPrefix: shellCommandPrefix, shellPath, backgroundTasks: this._backgroundTasks }`. When `_baseToolsOverride` is absent, widen the local `baseToolDefinitions` to `Record<string, ToolDefinition>` and add `baseToolDefinitions.task_stop = createTaskStopToolDefinition(this._backgroundTasks)`; append `"task_stop"` to `defaultActiveToolNames` (line 2831). With `_baseToolsOverride` (SDK custom tools), neither background bash nor task_stop exists — documented behavior.
   - Implement `_handleBackgroundTaskExit` and the idle-drain guard exactly as in the design section, reusing `sendCustomMessage` (line 1503), `waitForIdle` (line 1648), and mirroring `_runAgentPrompt`'s (line 1101) `_isAgentRunActive`/`_emitAgentSettled` bookkeeping for the post-idle `agent.continue()` drain.
   - Add public accessors: `getBackgroundTasks(): readonly BackgroundTaskRecord[] { return this._backgroundTasks.list(); }` and expose the manager read-only if the TUI needs stop support later.
   - In `dispose()` (line 877): add `this._backgroundTasks.stopAll("session-disposed");` first inside the existing `try`.

7. **`src/core/slash-commands.ts`** — add the `tasks` entry to `BUILTIN_SLASH_COMMANDS` (after `session`).

8. **`src/modes/interactive/interactive-mode.ts`** —
   - In `setupEditorSubmitHandler` (line 2983): add the `/tasks` dispatch before the fallthrough, following the `/session` block at line 3036.
   - Add `private handleTasksCommand(): void` modeled on `handleSessionCommand` (line 6236): render the task list into `chatContainer` and `requestRender()`.
   - In the session event subscription the mode already maintains, handle `background_task_exit` with a single `this.showStatus(...)` line (e.g. `Background task exited (code 0)`); no transcript insertion (the custom message already renders).

9. **`packages/coding-agent/CHANGELOG.md`** — add entries under `## [Unreleased]` (draft in the Changelog section below).

10. **Verify** — `npm run check` from the repo root (per root `AGENTS.md`; fix all errors/warnings/infos). Run the new tests via `./scripts/test.sh` from the repo root, or per-file from the package root: `node "$(git rev-parse --show-toplevel)/node_modules/vitest/dist/cli.js" --run test/background-tasks.test.ts`.

## Testing plan

No network, no real provider keys; faux provider and real short-lived local processes (`echo`, `sleep`, `sh`) only. New test files live in `packages/coding-agent/test/`.

**Unit — `test/background-tasks.test.ts` (vitest, real processes):**

1. Quick exit within grace: `start({ command: "echo hi", ... })` resolves `{ kind: "completed", exitCode: 0 }`, output contains `hi`, `list()` is empty, `onTaskExit` never fires.
2. Slow command: `start({ command: "sleep 5", ... })` resolves `{ kind: "running" }`; record has `id` matching `/^task-[0-9a-f]{16}$/` (opacity check: ID is not the PID), `outputPath` exists on disk immediately.
3. Output-file growth: `start({ command: "sh -c 'echo one; sleep 1; echo two'", ... })`; after completion the file contains `one` and `two`, in order, and equals what the exit notification's `outputPath` names.
4. Exit notification fires: `start({ command: "sleep 0.3", ... })` with an `onTaskExit` spy awaited via a deferred; assert record `status: "exited"`, `exitCode: 0`, `endedAt >= startedAt`; non-zero exit: `sh -c 'exit 3'` (outside grace via a leading `sleep 0.3`) reports `exitCode: 3`.
5. `stop` kills a process tree: `start({ command: "sh -c 'sleep 60 & wait'", ... })`, wait until the file/record is running, `stop(id)`; poll `process.kill(pid, 0)` until it throws (reaped), assert `status: "stopped"`, `stopReason: "task_stop"`, and no `onTaskExit` notification. Use a tiny injected `forceKillMs` so the test does not wait 3s.
6. Output cap: construct the manager with `maxOutputBytes: 4096`; run `sh -c 'while true; do echo abcdefgh; done'`-equivalent (portable: `yes abcdefgh` piped is fine on POSIX; guard the test with `process.platform !== "win32"` where needed); assert the task ends `stopped` with `stopReason: "output-limit`, file ends with the cap notice, and the notification fires (cap exits do notify).
7. `stopAll` marks everything stopped and ends streams.

**Tool-level — `test/bash-background-tool.test.ts` (vitest):**

8. `createBashToolDefinition(cwd, { backgroundTasks: manager })` + `run_in_background: true` with `sleep 1`: result text contains the task ID and output path; `details.backgroundTask` matches; `getActiveToolNames` untouched.
9. Same definition with `run_in_background: true` and `operations` supplied → error result mentioning local shell.
10. `PI_DISABLE_BACKGROUND_TASKS=1` (set/restore around the test) → error result.
11. `createTaskStopToolDefinition(manager)`: stops a running task; unknown ID → error result text.
12. Grace path through the tool: `run_in_background: true` + `echo hi` returns a completed (non-background) result with `hi` and no registered task.

**Agent-level — `test/suite/background-tasks.test.ts` (vitest, `createHarness` from `test/suite/harness.ts` + faux provider, pattern of `test/suite/agent-session-bash-persistence.test.ts`):**

13. End-to-end re-invoke while idle: real bash tool wired via `tools: [createBashTool(cwd)]`-style override is not needed — instead pass `initialActiveToolNames: ["read", "bash", "edit", "write"]` with default built-ins (harness `cwd` is a temp dir) and set faux responses: assistant calls `bash` with `{ command: "sleep 0.4; echo done", run_in_background: true }` (stopReason `toolUse`), then append (after observing the tool result) a final response. Await `harness.session.waitForIdle()`, then await the notification: assert `harness.session.messages` contains a `custom` message with `customType: "taskNotification"` whose content includes the task ID and output path, that `convertToLlm(harness.session.messages)` includes the notification text as a user message, and that the faux provider consumed the post-notification response (model was re-invoked).
14. Exit while streaming: start the background task, then while the agent is streaming a second turn (a slow faux response released via a promise), let the task exit; assert the notification was queued as follow-up and appears in messages after the run settles, with no "Agent is already processing" error in events.
15. `dispose()` kills: start `sleep 30` in background, call `harness.cleanup()` (which disposes the session), assert the child PID is reaped.
16. Serialization: two near-simultaneous exits (two `sleep 0.3` tasks) produce two notifications and exactly two model re-invocations, no errors.

**TUI command — extend `test/tools-manager.test.ts`-style coverage or a small new test:** `BUILTIN_SLASH_COMMANDS` contains `tasks`; `/tasks` dispatch is exercised by the existing interactive-mode command tests pattern if present, otherwise covered by the slash-commands list assertion (the handler is thin rendering over `getBackgroundTasks()`).

## Changelog

Draft entries for `packages/coding-agent/CHANGELOG.md`, appended to the existing `## [Unreleased]` subsections (do not duplicate section headers):

```markdown
### Added

- Added `run_in_background` to the `bash` tool: the command runs detached from the turn, the result returns immediately with a task ID and a per-task output file path, and the model is re-invoked with a task notification when the command exits. Output retrieval uses the existing `read` tool on the output file; background tasks have no timeout and are killed on session exit. Disable with `PI_DISABLE_BACKGROUND_TASKS=1`.
- Added the `task_stop` tool to terminate running background tasks (SIGTERM with SIGKILL escalation, full process tree).
- Added a `/tasks` command listing background task IDs, status, commands, and output file paths.
```

## Risks and open questions

- **Zombie/orphan processes.** `killProcessTree` uses process-group SIGKILL, and `killTrackedDetachedChildren` sweeps on all mode exit paths; but a task whose process escapes its process group via its own `setsid` survives (Claude handles re-detached descendants; pi does not track them). Accepted gap — same exposure as foreground bash today.
- **Re-invoke races.** Notification delivery while a run starts/ends concurrently is mitigated by the serialized `notifyQueue`, the `waitForIdle` + `hasQueuedMessages` drain, and the try/catch fallback to `agent.followUp`. Residual risk: a notification arriving during the tiny window inside `_emitAgentSettled` still lands via the next prompt because follow-up-queued messages flush before the next user prompt (`prompt()` line 1235 region). Tests 14/16 target this.
- **TUI redraw.** No streaming of background output by construction; only status lines and the final custom message render. If the default custom-message rendering proves noisy, register a compact renderer via `registerMessageRenderer("taskNotification", ...)` — polish, not required for acceptance.
- **Concurrent sessions in one process** (RPC/SDK hosting multiple `AgentSession`s): each session owns its manager and task IDs; IDs are unguessable so a model in session A cannot name session B's tasks. Output files share the tmpdir namespace but embed the opaque ID, so collisions are cryptographically implausible. Cross-session `/tmp` read access by the model is unchanged from today's `read` tool trust model.
- **Crash recovery.** A hard crash (SIGKILL, power loss) leaks running tasks — nothing can sweep then; output files remain for post-mortem. After restart, no task IDs exist in the registry; the persisted notification/result texts still name output paths so the model can read them. Full durable status (OpenCode's bar) is explicitly out of scope.
- **Model confusion.** Gen-1-style polling is the failure mode; mitigated by prompt guidelines ("you will be notified — do not poll or sleep"), the 200ms grace, and the real notification. Watch telemetry/anecdotes for sleep-loop regressions.
- **Open questions:** (1) Should interactive users get a keybinding to background a *foreground* bash call (Claude's Ctrl+B)? Deferred. (2) Should tasks started inside a foreground subagent's child session die when that subagent finishes? With per-session managers this happens automatically if the bundled subagents extension builds its tools through a disposing `AgentSession`; verify during implementation and document the observed behavior rather than forcing it. (3) Is 256MB the right cap, or should it be a setting? Constant first, setting if requested.

## Acceptance criteria

- [ ] `bash` tool schema includes optional boolean `run_in_background`; the tool description and system-prompt guidelines cover it.
- [ ] With `run_in_background: true`, the tool call returns while the process is still running, with result text containing an opaque task ID (`task-<hex>`) and an absolute output-file path; `details.backgroundTask` carries both.
- [ ] The output file exists from the moment the result returns, is ANSI-stripped/sanitized, and accumulates stdout+stderr; the existing `read` tool can read it mid-run and after exit.
- [ ] A command finishing within 200ms of spawn returns a normal completed result with no registered task and no notification.
- [ ] When a registered task exits, the model is re-invoked with a `taskNotification` custom message (visible in session history, converted to a user message for the LLM) containing task ID, exit code, duration, command, and output path — both when the session is idle and while it is streaming.
- [ ] `task_stop` tool kills the task's process tree (children included) and reports success; unknown IDs produce an error result.
- [ ] Background output exceeding 256MB kills the task, appends a cap notice to the file, and notifies with `stopReason: output-limit`.
- [ ] `/tasks` lists every task with ID, status, exit code, command, and output path; empty state is handled.
- [ ] Session exit paths kill all tracked background tasks (interactive quit/signals, print mode after final result, RPC shutdown, `AgentSession.dispose()`), leaving output files on disk.
- [ ] `run_in_background` is rejected (clear error result) with custom `BashOperations` and with `PI_DISABLE_BACKGROUND_TASKS=1`.
- [ ] Foreground bash behavior is byte-for-byte unchanged (existing bash/tool tests pass unmodified).
- [ ] All new tests pass via `./scripts/test.sh` (or per-file vitest invocation), and `npm run check` is clean.
