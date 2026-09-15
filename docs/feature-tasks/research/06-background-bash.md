# Research dossier: background command execution in coding-agent harnesses

Topic: how harnesses run shell commands detached from the agent turn (dev servers, long test runs, watchers), retrieve output later, and notify the model when the process exits. Consumed by the spec writer for pi's background-bash feature.

## Summary

Two designs dominate. Claude Code (current) and ZCode use a detached-task model: `run_in_background: true` on the Bash tool, output streamed to a per-task file whose path is returned in the tool result, the model is re-invoked with a task-notification when the process exits, plus TaskStop and a `/tasks` listing command. Gemini CLI uses a PID-keyed registry with companion read/list tools and configurable inject-on-exit; Codex uses a yield-then-session model (no exit notification); Amp and current OpenCode deliberately have no model-facing background shell at all.

## Findings by harness

### Claude Code

Two generations, both verified from leaked tool-schema captures and official docs.

**Generation 1 (v1.x era) — poll-based.**
- Parameter surface: `Bash(command, timeout_ms (default 120000, max 600000), description, run_in_background: boolean)`. Verbatim param description: "Set to true to run this command in the background. Use BashOutput to read the output later."
- Verbatim prompt language: "You can use the `run_in_background` parameter to run the command in the background, which allows you to continue working while the command runs. You can monitor the output using the Bash tool as it becomes available. Never use `run_in_background` to run 'sleep' as it will return immediately. You do not need to use '&' at the end of the command when using this parameter."
- Retrieval: `BashOutput(bash_id, filter?)` — "Always returns only new output since the last check" / "Returns stdout and stderr output along with shell status". Incremental diff-per-poll, not a file. `KillBash(shell_id)` to terminate. "Shell IDs can be found using the /bashes command."
- Notification: none; the model polls BashOutput. (Source: capture at https://github.com/x1xhlol/system-prompts-and-models-of-ai-tools `Anthropic/Claude Code/Tools.json` and `Anthropic/Claude Code 2.0.txt`.)

**Generation 2 (current) — file + notification.**
- Parameter surface: `Bash(command, timeout, description, run_in_background: boolean, dangerouslyDisableSandbox)`. Param: "Set to true to run this command in the background."
- Verbatim prompt language (usage notes): "You can use the `run_in_background` parameter to run the command in the background. Only use this if you don't need the result immediately and are OK being notified when the command completes later. You do not need to check the output right away - you'll be notified when it finishes. You do not need to use '&' at the end of the command when using this parameter." And: "If your command is long running and you would like to be notified when it finishes — use `run_in_background`. No sleep needed." And: "If waiting for a background task you started with `run_in_background`, you will be notified when it completes — do not poll."
- Output retrieval: tool result returns an output-file path; TaskOutput is marked deprecated: "DEPRECATED: Background tasks return their output file path in the tool result, and you receive a `<task-notification>` with the same path when the task completes. For bash tasks: prefer using the Read tool on that output file path — it contains stdout/stderr." TaskOutput(task_id, block=true, timeout 0–600000 default 30000) still exists as wait/poll fallback; "Task IDs can be found using the /tasks command".
- Notification/re-invoke: `<task-notification>` arrives as a separate turn when the task exits; "when harness-tracked work finishes, you are re-invoked automatically, so polling is wasted". Background agents use the same pattern ("you will be automatically notified when it completes — do NOT sleep, poll, or proactively check on its progress"). `TaskStop(task_id)` stops; a deprecated `shell_id` alias remains (visible migration from Gen 1 naming).
- A separate `Monitor` tool covers streaming events: "Start a background monitor that streams events from a long-running script. Each stdout line is an event" — distinct from run_in_background's single exit notification; guidance: "For 'tell me when X is ready,' use Bash `run_in_background` with an `until` loop instead (one notification, ends in seconds)." "Only stdout is the event stream. Stderr goes to the output file (readable via Read) but does not trigger notifications."
- Process cleanup / limits (official docs): "Background tasks are automatically terminated if output exceeds 5GB"; on OS memory pressure tasks are reaped only if the session is idle 30+ minutes (`CLAUDE_CODE_DISABLE_BG_SHELL_PRESSURE_REAP=1` to disable); "Background tasks are automatically cleaned up when Claude Code exits", including processes that detached via `setsid`/`timeout`; when a task is stopped. `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1` kills the whole feature.
- Timeout auto-move: "When a command reaches its timeout without finishing, Claude Code moves it to the background instead of stopping it" (unless it starts with `sleep`); result text: "Command did not complete within its 120s timeout and was moved to the background" followed by task ID and output-file path. cwd caveat: "A `cd`, `pushd`, `popd`, or `chdir` inside a command that is moved to the background never carries over" — the result says so explicitly so the model doesn't act on a directory change that didn't happen.
- Ownership/lifetime: "A command that a foreground subagent started stops when that subagent gives its final response" but "A command that the main conversation or a background subagent started keeps running after a final response"; in headless mode "background commands end shortly after the run's final result". User-side: Ctrl+B backgrounds a running Bash invocation; "runs the command asynchronously and immediately returns a background task ID".
- Sources: https://raw.githubusercontent.com/asgeirtj/system_prompts_leaks/main/Anthropic/claude-code/claude-code-sonnet-5.md (system prompt + tool schemas capture); https://code.claude.com/docs/en/interactive-mode; https://code.claude.com/docs/en/tools-reference.

### Amp

No model-facing background shell execution; the design forbids it.
- Verbatim shell-tool rule: "Do NOT use the single `&` operator to run background processes" (leaked thread YAML). An earlier leak adds the rationale: "NEVER use background processes with the `&` operator in shell commands. Background processes will not continue running and may confuse users."
- The shell tool (`{ cmd, cwd }`) is synchronous; output handling: "Only the last 50000 characters of the output will be returned to you along with how many lines got truncated".
- Long-running/async work is delegated to Amp's thread/orb machinery (remote agents, scheduled agents), not to detached local processes. The docs' tools page and changelog contain nothing about process lifecycle, kill-on-exit, or background output. Whether Amp kills spawned processes when a thread ends is not documented (unverified).
- Sources: https://raw.githubusercontent.com/x1xhlol/system-prompts-and-models-of-ai-tools/main/Amp/gpt-5.yaml; https://raw.githubusercontent.com/asgeirtj/system_prompts_leaks/main/Misc/amp-code.md; https://ampcode.com/docs/tools; https://ampcode.com/chronicle.

### OpenCode

Current tree (V2 core, `dev`): the bash tool has NO background parameter, and background launch was explicitly removed pending durability work. Input schema: `command`, `workdir`, `timeout` (ms, default 120000, max 600000). Verbatim TODOs in source:
- "TODO: Persist background job status and define restart recovery before exposing remote observation."
- "TODO: Re-add model-facing background launch only with owner-bound get/wait/cancel tools and completion delivery."
- "TODO: Revisit process-group cleanup and platform coverage with shell-specific tests if current AppProcess semantics do not fully cover it."
Implementation details worth copying: `detached: process.platform !== "win32"` + `forceKillAfter: 3s` (SIGTERM→SIGKILL escalation) on the child process; `MAX_CAPTURE_BYTES = 1MB` in-memory cap with notice "[output capture truncated at the in-memory safety limit]". I could not find a model-facing background param in the bash/shell tool at any point in reachable history (May 2025 through the V2 rewrite); an earlier `Proc` background-process registry with a `/proc` TUI command existed in 2025-era OpenCode (unverified; history before 2026 is not reachable via the current repo).
- Sources: https://github.com/sst/opencode/blob/dev/packages/core/src/tool/bash.ts (fetched via raw.githubusercontent.com at `dev`); https://opencode.ai/docs/tools/.

### Gemini CLI

Full background support, PID-keyed, poll-read + inject-on-exit.
- Parameter surface: `run_shell_command(command, dir_path, is_background?: boolean, delay_ms?)`. Docs: "`is_background` (boolean, optional): Whether to move the process to the background immediately after starting." For plain `&` commands the tool also reports "Background PIDs" captured by wrapping the command in a subshell with an EXIT trap that records descendant PIDs to a temp file (`wrapCommandForBackgroundPIDs`).
- Launch semantics: `BACKGROUND_DELAY_MS = 200` grace period — "If the model requested to run in the background, do so after a short delay"; if the command finishes within the delay it returns normally, else the result is: "Command is running in background. PID: ${pid}. Initial output:\n${cumulativeOutput}". This avoids backgrounding commands that would have completed in <200ms (the "sleep returns immediately" problem Claude solves with prompt text).
- Output retrieval: every background process tees ANSI-stripped output to a per-PID log file `<globalTmp>/background-processes/background-<pid>.log` via a WriteStream. Companion tool `read_background_output(pid, lines=100, delay_ms?)` tail-reads it: reads at most the last 64KB of the file, drops the first line if starting mid-file (partial-line guard), header "Showing last N of M lines:". Hardening: opens with `O_NOFOLLOW` (symlink attack guard) and verifies "process belongs to this session to prevent reading logs of processes from other sessions/users" — error: "Access denied. Background process ID ... not found in this session's history."
- Listing: `list_background_processes()` returns "- [PID 123] RUNNING: `cmd`" / EXITED with exit code and signal; per-session history capped at 100 records.
- Notification/re-invoke: `ExecutionLifecycleService.attachExecution(pid, {...})` with `completionBehavior: 'inject' | 'notify' | 'silent'` (user-configurable): `'inject'` — full output (truncated to 5000 chars) injected: "[Background command completed successfully. Output saved to ${logPath}]\n\n${truncated}"; `'notify'` — pointer message only ("output saved to /tmp/..."); `'silent'` — nothing. Injections flow through an `InjectionService` with source `'background_completion'` that reinjects them into the model conversation (same channel as user-steering messages). Kill path: `killProcessGroup({ pid })`.
- Sources: https://github.com/google-gemini/gemini-cli/blob/main/packages/core/src/tools/shell.ts, .../tools/shellBackgroundTools.ts, .../services/shellExecutionService.ts, .../services/executionLifecycleService.ts, .../config/injectionService.ts, https://github.com/google-gemini/gemini-cli/blob/main/docs/tools/shell.md (all fetched via raw.githubusercontent.com at `main`).

### OpenAI Codex CLI

No detached background execution with exit notification; a yield-then-session model instead. Two variants from `codex-rs/core`:
- Plain `shell` tool: synchronous with `timeout_ms` ("Maximum command runtime. Defaults to 10000 ms."); description is rewritten to: "Runs a command to completion and returns its output. The process is terminated on timeout or cancellation and cannot be resumed." (The `tty` and `yield_time_ms` params are removed in this variant.)
- `unified_exec` (`exec_command` + `write_stdin`): PTY-capable (`tty: boolean` — "True allocates a PTY for the command; false or omitted uses plain pipes") with `yield_time_ms`: "Maximum time to wait before returning a session ID for a still-running command. Commands that finish sooner return immediately... Defaults to 10000 ms; effective range is 250-30000 ms." If the command is still running at yield, the tool returns a `session_id` (i32) and the model drives/polls it later via `write_stdin(session_id, ...)`. Base description: "Runs a command in a PTY, returning output or a session ID for ongoing interaction." The process manager persists live sessions so that "interrupting the turn cannot drop the last Arc and terminate the background process"; output is bounded by a head+tail buffer (`head_tail_buffer.rs`). There is no automatic re-invoke when the process exits — the model must come back with `write_stdin`. (The TUI's "background tasks"/command center concern cloud tasks and backgrounded model turns, not local shell processes.)
- Sources: https://github.com/openai/codex/blob/main/codex-rs/core/src/tools/handlers/shell_spec.rs, .../unified_exec/exec_command.rs, .../unified_exec/write_stdin.rs, .../unified_exec/process_manager.rs, https://github.com/openai/codex/blob/main/codex-rs/core/src/exec.rs (fetched via raw.githubusercontent.com at `main`).

### ZCode (firsthand)

Authoritative firsthand notes (no public docs): Bash tool accepts `run_in_background: true` — the command runs detached, keeps running across turns, and the harness re-invokes the model when it exits. The tool result includes an output-file path (stdout/stderr) that the Read tool can read. Foreground Bash has `timeout_ms` (default 120000, max 600000). Companion tools: `TaskOutput(task_id, block, timeout)` — waits or polls output/status of background tasks; `TaskStop(task_id)` — terminates a running background task; a `/tasks` command lists task IDs. Background agents follow the same notification pattern. (Functionally identical to Claude Code generation 2, including the deprecated-in-favor-of-Read+notification guidance in the current Claude Code capture.)

## Gaps and pitfalls

- Zombie/orphan processes: foreground abort must kill the whole process tree, not the shell PID (children re-parented to init survive). Claude Code additionally kills processes that re-detached via `setsid`/`timeout`; pi already has `killProcessTree` (process-group SIGKILL via `-pid`, `taskkill /F /T` on Windows) and `trackDetachedChildPid` — background tasks must stay tracked until exit or explicit stop, and session exit must sweep them.
- Auto-backgrounding on foreground timeout (Claude Code) changes semantics silently: the tool "succeeds" with a task ID instead of failing; the result text must state the move ("was moved to the background"), include task ID + output path, and warn that `cd` inside the backgrounded command did not take effect.
- TUI redraw while processes stream: background output should not stream into the live transcript (context + flicker); write to the log file and show only a status line (running count / task list). Gemini strips ANSI before persisting; pi's foreground path already sanitizes (stripAnsi + sanitizeBinaryOutput) — background must do the same on the file.
- Interleaving foreground + background: background commands must run in their own shell instance; a persistent-session cwd must never be mutated by a backgrounded command (Claude documents this exact failure). Two concurrent `cd`s is the concrete failure case.
- Output file size/rotation: unbounded tee can fill a disk (a chatty dev server). Claude auto-kills at 5GB; Gemini caps reads at 64KB/100 lines; OpenCode caps capture at 1MB. pi's `bash-executor.ts` already has a rolling in-memory window + temp file past `DEFAULT_MAX_BYTES`; background needs a hard cap (kill or truncate-with-notice) and tail-oriented reads.
- PTY vs pipes: background capture should use pipes (deterministic, strip-able); Codex's `tty` option exists because it drives interactive processes, but PTY output carries ANSI/control codes — Gemini's strip-before-persist is the mitigation if PTY is ever needed.
- Timeouts for background tasks: harnesses mostly apply none (Claude: subagent-owned commands have "no time limit"; reaping only under memory pressure after 30 min idle). Decide: no wall-clock timeout, but output cap + kill on session end; headless mode should end tasks shortly after the final result (Claude does exactly this) so `pi --mode rpc`/headless runs don't leak servers.
- Session crash/restart: OpenCode removed the feature rather than ship it without "durable status, restart recovery, and authorization" — the registry is in-memory (Gemini's static maps die with the process) but the output files survive on disk. Design the registry so a restarted session can at least (a) not resurrect stale task IDs as "running" and (b) let the model Read still-existing output files.
- Model confusion: generation-1 style polling invites sleep loops and lost turns; both Claude and ZCode converged on "do not poll, you will be notified" prompt language plus a real notification mechanism. Prompt text alone (Amp's `&` ban) just pushes the model to nohup/setsid hacks.

## Design takeaways for pi

- Yes: `run_in_background` is a Bash-tool param (add to `bashSchema` in `src/core/tools/bash.ts` next to `timeout`), backed by a task registry and a notification event — that is the converged Claude Code/ZCode shape. Cover it in `bashToolSystemPromptContribution` with the anti-patterns: no `&`, no sleep/poll, "you will be notified when it exits", and "prefer Read on the output file".
- Registry: a `BackgroundTaskRegistry` keyed by opaque `task_id` (not PID — PIDs are guessable and enable cross-session reads; Gemini needed an explicit ownership check to fix this). Record: id, command, pid, output-file path, status, exit code, startedAt. Expose a `/tasks` TUI command (mirrors pi's existing slash-command surface; Claude retired `/bashes` for `/tasks`).
- Output: reuse `bash-executor.ts`'s pattern (temp file `pi-bash-<id>.log`, ANSI-stripped, size-capped with truncate notice). Return the path in the tool result; retrieval via the existing Read tool — no new read tool needed (Claude deprecated BashOutput and TaskOutput in favor of exactly this). A `TaskOutput(task_id, block, timeout)` companion is only needed if blocking-wait is desired; a `TaskStop(task_id)` tool is required either way.
- Notification: the process-exit watcher emits on the existing `event-bus` (e.g. `background-task-exit` with `{taskId, exitCode, outputPath}`); AgentSession subscribes and injects a synthetic turn (task-notification message) to re-invoke the model. This is the main new plumbing: pi's loop today only takes turns from user input, so it needs a queue for harness-originated turn entries (idle-wake or mid-turn deferral must both be handled).
- Process management: spawn is already `detached: true` on POSIX in `createLocalShellOperations`; keep `trackDetachedChildPid`/`killProcessTree` for TaskStop and session-exit sweep; SIGTERM then SIGKILL escalation (OpenCode uses 3s force-kill). Decide ownership lifetime: main-session tasks live until session exit; tasks started by a foreground subagent/agent die when that agent finishes (Claude's rule).
- Foreground timeout interplay: keep pi's current behavior (kill on timeout) initially; auto-move-to-background (Claude's "moved to the background" result) is a worthwhile follow-up and must include the task ID, output path, and cwd-did-not-carry warning text.
- Session exit: kill all tracked background tasks on normal shutdown (TUI quit, SIGINT/SIGTERM); in headless/RPC mode end them shortly after the final result; leave output files on disk for post-mortem Read.
- Scope guard: single notification on exit only (Claude's streaming Monitor is a separate, later feature — its prompt guidance explicitly splits "one notification" vs "one per occurrence").

## Sources

- https://github.com/x1xhlol/system-prompts-and-models-of-ai-tools (Anthropic/Claude Code/Tools.json; Anthropic/Claude Code 2.0.txt; Amp/gpt-5.yaml)
- https://github.com/asgeirtj/system_prompts_leaks/blob/main/Anthropic/claude-code/claude-code-sonnet-5.md
- https://github.com/asgeirtj/system_prompts_leaks/blob/main/Misc/amp-code.md
- https://code.claude.com/docs/en/interactive-mode
- https://code.claude.com/docs/en/tools-reference
- https://ampcode.com/docs, https://ampcode.com/docs/tools, https://ampcode.com/chronicle
- https://github.com/sst/opencode/blob/dev/packages/core/src/tool/bash.ts
- https://opencode.ai/docs/tools/
- https://github.com/google-gemini/gemini-cli/blob/main/packages/core/src/tools/shell.ts
- https://github.com/google-gemini/gemini-cli/blob/main/packages/core/src/tools/shellBackgroundTools.ts
- https://github.com/google-gemini/gemini-cli/blob/main/packages/core/src/services/shellExecutionService.ts
- https://github.com/google-gemini/gemini-cli/blob/main/packages/core/src/services/executionLifecycleService.ts
- https://github.com/google-gemini/gemini-cli/blob/main/packages/core/src/config/injectionService.ts
- https://github.com/google-gemini/gemini-cli/blob/main/docs/tools/shell.md
- https://github.com/openai/codex/blob/main/codex-rs/core/src/tools/handlers/shell_spec.rs
- https://github.com/openai/codex/blob/main/codex-rs/core/src/tools/handlers/unified_exec/exec_command.rs
- https://github.com/openai/codex/blob/main/codex-rs/core/src/tools/handlers/unified_exec/write_stdin.rs
- https://github.com/openai/codex/blob/main/codex-rs/core/src/unified_exec/process_manager.rs
- https://github.com/openai/codex/blob/main/codex-rs/core/src/exec.rs
