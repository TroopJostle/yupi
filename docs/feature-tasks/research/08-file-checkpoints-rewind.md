# Research: File checkpoints / rewind in coding-agent harnesses

Date: 2026-09-14. Scope: how harnesses snapshot agent file edits (and conversation state) so a user can revert a bad agent turn without polluting the user's git history. Primary sources preferred; memory-only claims are marked (unverified).

## Summary

Three viable mechanisms dominate: (1) per-edit file copies stored outside the repo (Claude Code current, VS Code Copilot), (2) a shadow git object database owned by the tool (OpenCode, Gemini CLI, Cline, and reportedly Claude Code v2.0 — unverified), and (3) real commits in the user's repo (Aider, plus Replit Agent which layers whole-filesystem copy-on-write snapshots under git). Mature implementations pair file restore with conversation restore as separate, user-selectable actions, and every one of them deliberately scopes capture to the agent's own tool edits — bash-made changes, gitignored files, and out-of-scope paths are the recurring exclusion and the recurring bug report.

## Findings by harness

### Claude Code (Anthropic)

- Mechanism: per-file pre-edit copies stored outside the user's repo. Official docs: only edits from Claude's file-editing tools are tracked; a community teardown states it plainly: "A checkpoint is not a git commit and it is not a snapshot of your whole repository... Claude Code writes a copy of a file before its editing tools change it." (https://www.buildthisnow.com/blog/guide/mechanics/claude-code-checkpoints-rewind; https://code.claude.com/docs/en/checkpointing)
  - History note: the v2.0 rewind implementation was widely reported to use a hidden "shadow git" repository; the shipped docs and teardowns above describe only the current file-copy store. Treat the shadow-git origin as (unverified).
- What is captured and when: "captures the state of your code before each prompt you send that starts a turn" — one checkpoint per user prompt that starts a turn; queued messages that join a running turn get no checkpoint. Snapshot = the file as it was before each edit-tool modification. SDK docs: "creates backups of files before modifying them through the Write, Edit, or NotebookEdit tools." (https://code.claude.com/docs/en/checkpointing; https://code.claude.com/docs/en/agent-sdk/file-checkpointing)
- Restore semantics: `/rewind` menu offers Restore code and conversation / Restore conversation / Restore code / Summarize from here / Summarize up to here — code and conversation are independently restorable. Code-restore options only appear "when the selected checkpoint has tracked file changes to revert." (https://code.claude.com/docs/en/checkpointing)
  - SDK restore is files-only: rewinding "does not rewind the conversation itself"; on rewind Claude Code "deletes the files it created and restores the files it modified to their content at that point." (https://code.claude.com/docs/en/agent-sdk/file-checkpointing)
- UX: `/rewind` or double-Esc with empty input (double-Esc with text just clears input). Works after quit/`/resume` because snapshots are saved with the conversation. (https://code.claude.com/docs/en/checkpointing)
- Storage + retention: per session under `~/.claude/file-history/<session>/` (community teardown; official docs confirm "file snapshots for the 100 most recent checkpoints in a session" and that snapshots are saved with the conversation). Discarding an older checkpoint deletes snapshot files no remaining checkpoint references, "except each file's first snapshot" (kept as the VS Code extension's session-diff baseline). A retention sweep removes snapshots "by default about 30 days after the session last saved one"; extend via `cleanupPeriodDays`. (https://www.buildthisnow.com/blog/guide/mechanics/claude-code-checkpoints-rewind; https://code.claude.com/docs/en/checkpointing)
- Exclusions/limits:
  - Bash: "Checkpointing does not track files modified by bash commands" (rm, mv, cp; sed/echo redirection). (https://code.claude.com/docs/en/checkpointing)
  - Subagents: edits usually not restored, except a foreground skill with `context: fork`; background forks must be reverted with git. (https://code.claude.com/docs/en/checkpointing)
  - External/manual edits and other sessions' edits are not captured. (https://code.claude.com/docs/en/checkpointing)
  - Symlinks/hardlinks: restores skip them and warn "Restored the code, but skipped N files"; skipped paths logged at `~/.claude/debug/<session-id>.txt`. (https://code.claude.com/docs/en/checkpointing)
  - File content only: "Creating, moving, or deleting directories is not undone by rewinding." (https://code.claude.com/docs/en/agent-sdk/file-checkpointing)
  - Disable: `fileCheckpointingEnabled: false` setting or `CLAUDE_CODE_DISABLE_FILE_CHECKPOINTING` env var. (https://github.com/luongnv89/claude-howto/blob/main/08-checkpoints/README.md — community; consistent with official settings)
- Positioning: "Checkpoints are designed for quick, session-level recovery. For permanent version history and collaboration, continue using version control, such as Git." (https://code.claude.com/docs/en/checkpointing)

### Aider

- Mechanism: real commits in the user's own git repository — the opposite design pole. "Whenever aider edits a file, it commits those changes with a descriptive commit message." (https://aider.chat/docs/git.html)
- Dirty worktree handling: "Aider will first commit any preexisting changes with a descriptive commit message" before applying its edits, which "keeps your edits separate from aider's edits" — this is what makes /undo safe: it can never discard the user's uncommitted work because none exists by the time aider edits. (https://aider.chat/docs/git.html)
- Restore semantics: `/undo` — "Undo the last git commit if it was done by aider" (i.e., a guarded `git reset` of aider's last commit; mechanics (unverified) are a soft reset of HEAD). (https://aider.chat/docs/usage/commands.html; https://aider.chat/docs/git.html "will undo and discard the last change")
- UX: `/undo`, `/diff` (diff since last message), `/commit`, `/git` for raw git. (https://aider.chat/docs/git.html)
- Flags: `--no-auto-commits` (stop committing each change), `--no-dirty-commits` (stop committing pre-existing dirty files), `--no-git` (never touch git; backups become the user's responsibility), `--git-commit-verify` (run pre-commit hooks; default skips them via `--no-verify`). Attribution: aider appends "(aider)" to author/committer names. (https://aider.chat/docs/git.html)
- Non-git directories: aider "asks to create a git repo" if launched outside one. (https://aider.chat/docs/git.html)
- Trade-off vs shadow snapshots: history is first-class (blame, branch, revert all work) but the user's repo is mutated: reflog noise, commit-signing prompts, `git log` pollution unless the user squashes. Aider accepts this deliberately; aider's docs frame git as the storage layer.

### Cursor

- Mechanism: file snapshots stored "locally and separate from Git" — current docs do not describe internals. (https://cursor.com/docs/agent/overview)
- What is captured and when: "Checkpoints save snapshots of your codebase during an Agent session. Agent automatically creates them before making significant changes, capturing the state of all modified files." (https://cursor.com/docs/agent/overview)
- Restore semantics: files only. "Restoring a checkpoint reverts files only; it does not remove messages from the conversation." To shorten the conversation, the suggested action is to "fork the chat from an earlier message" — restore and fork are separate verbs, same as Claude Code's split menu. (https://cursor.com/docs/agent/overview; https://cursor.com/help/ai-features/agent)
- UX: click any checkpoint in the chat timeline to "preview your files at that point, then restore to revert all files to that state"; or the "Restore Checkpoint button on previous requests"; or "the + button when hovering over a message." "How do I undo Agent changes? Hover over a previous message and click Restore Checkpoint in the bottom right to roll back all changes Agent made after that point." (https://cursor.com/docs/agent/overview; https://cursor.com/help/ai-features/agent)
- Storage + retention: "Checkpoints are stored locally and separate from Git. Only use them for undoing Agent changes; use Git for permanent version control." No retention details published. (https://cursor.com/docs/agent/overview)
- Exclusions/limits: not documented on the current pages (bash-made changes, gitignored/untracked handling unspecified). Community storage teardown: chat/checkpoint data lives under `~/.cursor/chats/*/*/store.db` / `state.vscdb` (https://vibe-replay.com/blog/cursor-local-storage — community). The frequently-cited claim that Cursor historically implemented checkpoints via "bisection" (storing snapshots without git) could not be verified in current docs or archive — (unverified).
- Known UX bugs: Restore Checkpoint button intermittently disappears; restart is the workaround (https://forum.cursor.com/t/revert-restore-checkpoint-button-missing/165791 — community).

### OpenCode (sst/opencode, now anomalyco/opencode)

- Mechanism: shadow git object database outside the repo. "Stored locally in a separate internal Git object database under its data directory." Capture "creates no commits, moves no branches, and leaves your repository 'an ordinary dirty worktree.'" (https://opencode.ai/v2/docs/snapshots)
- What is captured and when: per model step, two snapshots — one "immediately before the model call" and one "when the step reaches a recorded success or failure." Capture is best-effort; a missing half means that step's file changes can't be restored. The assistant message records which paths changed between the pair. Scope: tracked files in the session's active directory plus "non-ignored untracked files up to 2 MiB each." Requires a git worktree; outside one, `/undo` rolls back conversation only. (https://opencode.ai/v2/docs/snapshots)
- Restore semantics: staged rollback. `/undo` stages the rollback, restores affected files, and "puts the removed prompt back in the composer"; resubmitting commits the rollback; `/redo` cancels the staged rollback. Restores only paths attributed to assistant steps after the selected boundary; "each path returns to its state before the first reverted step; files created by those steps are removed if they didn't exist then. Unattributed paths are untouched." (https://opencode.ai/v2/docs/snapshots)
- UX: `/undo`, `/redo`, `<leader>u` / `<leader>r`, or Revert on any earlier message. (https://opencode.ai/v2/docs/snapshots)
- Storage + retention: internal git object database under OpenCode's data directory; snapshot objects "can hold complete file contents" so the data directory is sensitive. Enabled by default; `"snapshots": false` in `opencode.jsonc` disables future capture but "does not delete snapshots already stored." Committing a rollback removes messages only from the active view, "not from durable session history or existing snapshot storage." (https://opencode.ai/v2/docs/snapshots)
- Exclusions/limits: git-ignored files: No. Untracked files over 2 MiB: No. Files outside the active directory: No. Git metadata/commits/branches/databases/processes: No. Shell command effects not reversed. External editors can modify the worktree between capture and restore; restoring can overwrite such later edits — the docs tell users to review the restore summary and `git diff` first. (https://opencode.ai/v2/docs/snapshots)
- Session forking: separate feature; desktop/web clients were missing Revert/Fork actions (https://github.com/anomalyco/opencode/issues/9661 — issue report), and community reports note revert/fork is only supported from the latest message in some clients (https://www.reddit.com/r/opencodeCLI/comments/1s30y0e/ — community).

### Cline (VS Code extension)

- Mechanism: shadow git repository. "Cline maintains a shadow Git repository separate from your project's actual Git history... Your main Git repository stays untouched." Each checkpoint is a commit in that shadow repo (community reporting places it under VS Code's global storage directory — (unverified) for the exact path). (https://docs.cline.bot/core-workflows/checkpoints)
- What is captured and when: "Every time Cline modifies a file or runs a command, it saves a snapshot of your project files" — i.e., snapshot after each tool use, including bash. "Checkpoints capture everything, including files not tracked by Git"; "Each checkpoint captures the complete file state at that moment." Three sequential edits produce three independent checkpoints. (https://docs.cline.bot/core-workflows/checkpoints)
- Restore semantics: three-way menu — "Restore Files" (revert project files to the snapshot), "Restore Task Only" (delete messages after this point, files untouched), "Restore Files & Task" (both). Editing a past message with "Restore All" reverts files to that checkpoint before resubmitting. (https://docs.cline.bot/core-workflows/checkpoints)
- UX: Compare and Restore buttons per checkpoint; message-edit integration. (https://docs.cline.bot/core-workflows/checkpoints)
- Storage + retention: checkpoints persist across editor sessions; on large repos they "may use significant storage and slow down Cline" and the docs advise disabling. Toggle: Settings → Feature Settings → Enable Checkpoints (on by default). (https://docs.cline.bot/core-workflows/checkpoints)
- Exclusions/limits (from issue tracker): full-workspace capture causes real problems in big monorepos — checkpoint corruption reports (#9590), deletion of `.git` folders in some cases (#8273), and commit-signing configs (`commit.gpgsign`) prompting constantly because shadow commits use the user's default git config (#1211). (https://github.com/cline/cline/issues/9590; https://github.com/cline/cline/issues/8273; https://github.com/cline/issues/1211 — links as surfaced in search; issue content not individually fetched)

### Gemini CLI (Google)

- Mechanism: shadow git repo in the home directory + JSON sidecar files. Each checkpoint has three components: (1) a "Git snapshot — a commit in a special, shadow Git repository located in your home directory (~/.gemini/history/<project_hash>)"; (2) conversation history; (3) the tool call about to execute — the latter two in "a JSON file in your project's temporary directory at ~/.gemini/tmp/<project_hash>/checkpoints". (https://google-gemini.github.io/gemini-cli/docs/cli/checkpointing.html)
- What is captured and when: checkpoints happen "before any file modifications are made by AI-powered tools," e.g. on approval of `write_file` or `replace`. Checkpoint filenames embed "a timestamp, the name of the file being modified, and the name of the tool that was about to be run" (e.g. `2025-06-22T10-00-00_000Z-my-file.txt-write_file`). (https://google-gemini.github.io/gemini-cli/docs/cli/checkpointing.html)
- Restore semantics: `/restore` (no args lists checkpoints). Restoring (1) reverts all project files to the snapshot state, (2) restores conversation history in the CLI, and (3) "re-propose[s] the original tool call" for re-run/edit/dismiss. So restore is both files and conversation, keyed to a single tool call rather than a prompt. (https://google-gemini.github.io/gemini-cli/docs/cli/checkpointing.html; https://google-gemini.github.io/gemini-cli/docs/cli/commands.html)
- UX: `/restore [checkpoint]`; "Only available if the CLI is invoked with the --checkpointing option or configured via settings." (https://google-gemini.github.io/gemini-cli/docs/cli/commands.html)
- Storage + retention: paths above; "The Checkpointing feature is disabled by default" (enable via `gemini --checkpointing` or `settings.json` `general.checkpointing.enabled`). No retention/cleanup policy documented. The shadow repo "does not interfere with your own project's Git repository." (https://google-gemini.github.io/gemini-cli/docs/cli/checkpointing.html)
- Exclusions/limits: none documented (no size caps, no ignore rules stated). A feature request (#10223, closed as backlog-p3 without shipped selective restore) asked for Claude-Code-style modes — "Conversation only / Code only / Both" — and to "exclude bash-command changes, manual edits outside the CLI, and Git operations," storing "diffs rather than full copies." (https://github.com/google-gemini/gemini-cli/issues/10223)
- Note: chat-state checkpoints are a separate, always-available feature (`/chat save <tag>` → `~/.gemini/tmp/<project_hash>/`), independent of file checkpointing. (https://google-gemini.github.io/gemini-cli/docs/cli/commands.html)

### OpenAI Codex CLI

- No file-state rewind. Esc-Esc (with empty composer) opens a message-history picker to backtrack/fork the conversation only: "Hitting esc twice lets you change message history, which forks the conversation. This won't restore code, but it helps with context management." (https://github.com/openai/codex/discussions/9618 — discussion; https://community.openai.com/t/creating-snapshots-of-previous-states/1379508 — "Esc rewind only rewinds conversation/history... prior file edits remain in the working tree")
- Open feature request for a `/rewind` that reverts both chat and files: https://github.com/openai/codex/issues/11626. The IDE extension's per-edit Undo toolbar is scoped to the edit tool and disappears afterward (https://medium.com/@furry_ai_diary/why-codex-still-cant-undo-its-own-file-edits-a-possible-solution-implemented-9b2b01f6ab7b — community).
- This is exactly pi's current situation: conversation fork without file snapshotting.

### VS Code Copilot agent (bonus, closest UX analog for fork+restore)

- Mechanism: per-request snapshots of affected workspace files, stored by the extension host (not the user's git). "Before processing each request, VS Code creates a snapshot of affected workspace files." (https://code.visualstudio.com/docs/agents/run/review-code-edits)
- Restore semantics: "Hover over the request and select Restore Checkpoint" — VS Code "removes subsequent requests from the conversation history and restores the workspace files." Fork is a separate action: "Hover over a request and select Fork Conversation to create an independent session that includes the conversation up to that checkpoint." (https://code.visualstudio.com/docs/agents/run/review-code-edits)
- Also has per-edit pending semantics: after the agent saves a file, edits are "pending" — "Select Keep to accept the edit" or "Select Undo to reject the edit and revert the change"; staging in Source Control auto-accepts, discarding discards. Settings: `chat.checkpoints.enabled`, `chat.checkpoints.showFileChanges`, `chat.editing.autoAcceptDelay`. (https://code.visualstudio.com/docs/agents/run/review-code-edits)
- Limits: "A checkpoint restores affected workspace files and chat history" but "doesn't reverse completed terminal commands, network requests, deployments"; terminal-command-modified files are not in the Changes list; "Checkpoints are temporary and don't replace Git version control." (https://code.visualstudio.com/docs/agents/run/review-code-edits)

### Replit Agent (bonus, infra-level upper bound)

- Mechanism: whole-filesystem copy-on-write snapshots under git. Block devices are split into "16 MiB chunks" that are "stored immutably in GCS"; a manifest points at the chunks, so "copying a disk is a matter of copying the manifest." Code layer is standard git: each checkpoint state becomes a git commit; the git history is additionally mirrored to "an immutable, append-only git remote" on a separate volume. Restore = swap the manifest + git revert to the checkpoint's commit; the database (local Postgres on the snapshotted FS) comes along for free. (https://replit.com/blog/inside-replits-snapshot-engine)
- Included because it shows the maximal design (revert files, code, and even DBs) and the atomic-application pattern for parallel agents; not practical for a CLI harness, but the manifest-of-immutable-chunks idea is the scalable version of per-file snapshots.

### ZCode

- Firsthand: no rewind/checkpoint feature observed in this environment — absent/unknown.

## Mechanism trade-offs

- Shadow git (OpenCode, Gemini CLI, Cline, Claude Code v2.0 (unverified)):
  - Cost: one `git add -A`-equivalent walk + commit per checkpoint; incremental and cheap after the first.
  - Correctness: renames/deletes/binary/mode-bits handled by git natively; content-addressed objects dedupe repeated edits of the same file.
  - Disk usage: excellent — object compression + dedupe; Cline's full-worktree variant is the counterexample ("significant storage and slow down" on large repos).
  - Untracked files: must be a policy decision. OpenCode includes non-ignored untracked files up to 2 MiB and excludes gitignored ones; Cline includes everything; Claude Code sidesteps the question by only snapshotting files its edit tools touched (so untracked-but-touched files are naturally included).
  - User's git: untouched if the shadow repo lives outside the project (Gemini `~/.gemini/history/<hash>`, OpenCode data dir) — but it inherits the user's git config (Cline's `commit.gpgsign` prompting bug), and a shadow repo inside the project can show up in git status or get clobbered.
  - Failure modes: needs git present (OpenCode degrades to conversation-only rollback outside a worktree); user hooks/config interfere; "ordinary dirty worktree" must be preserved exactly on restore.
- Per-edit file copies (Claude Code current, VS Code):
  - Cost: trivial per edit (copy one file before modifying); no repo walk, no git dependency, works in non-git directories.
  - Correctness: per-file copies handle delete (snapshot existence = restore-by-delete), and binary fine, but renames are two unrelated path events, and directory create/move is not undone (Claude Code documents exactly this).
  - Disk usage: fine with a count cap (100 checkpoints) + dedupe-by-content; Claude Code keeps "each file's first snapshot" as a diff baseline — a natural poor-man's dedupe point.
  - Untracked files: only files the edit tool touched are snapshotted, so user's unrelated untracked files are never captured — the safest default with respect to the user's own work.
  - User's git: zero interaction. This is the mechanism with no way to corrupt the repo or trip user hooks.
- Bisection / whole-disk CoW (Cursor (unverified), Replit): constant-time forks, but Replit needs block-device infra; not applicable to a local CLI.
- Real commits in the user's repo (Aider): best history/instrumentation (blame, branch, push), and /undo is just a guarded reset; costs are repo pollution (message noise, signing prompts, reflog churn) and the mandatory dirty-commit step that rewrites the user's staging area — a non-starter for a harness like pi that must not touch the user's git state at all.

CRITICAL invariant across all snapshot mechanisms: restore must only revert changes attributable to the agent. Aider achieves it by construction (separate commits + guarded reset); OpenCode restores "only paths attributed to assistant steps"; Claude Code snapshots only files its tools edited; VS Code snapshots "affected workspace files." Never restore a path the agent didn't touch unless you can prove the content is still the agent's version — otherwise you destroy the user's concurrent edits. OpenCode's docs acknowledge the residual risk: "current edits to affected paths can be overwritten."

## Gaps and pitfalls

- Bash/command mutations: the universal hole. Claude Code and VS Code explicitly do not track them; Cline's full-workspace snapshot after every command is the only approach that covers `rm`/`mv`/generators, and it costs the most. If pi snapshots only edit/write tool calls, an agent that shells out to `sed`/formatters defeats rewind — document this loudly (Gemini CLI's own issue asks for exactly this exclusion, so silence is also defensible).
- Untracked files the agent didn't touch: snapshotting the whole tree (Cline) captures user secrets/dotfiles into a second copy on disk (OpenCode: "the data directory should be treated as sensitive"). Snapshotting only agent-touched paths (Claude Code) avoids this entirely.
- .gitignore'd files: OpenCode excludes them (so a checkpoint can't restore an agent's edit to `.env`); Cline includes them (leak risk); Claude Code's per-touched-file approach includes them only if the agent edited them. pi must pick explicitly — likely "touched files regardless of ignore status," with the caveat that snapshot storage then contains secrets.
- Huge repos / monorepos: full-tree shadow commits are O(worktree) per checkpoint (Cline issue reports of corruption/slowdown in large monorepos). Per-touched-file copies are O(edited file) and immune.
- Symlinks/hardlinks: Claude Code v2.1.216+ explicitly skips restoring through links and reports skipped counts; earlier versions "wrote/deleted through links" — i.e., restoring through a symlink can clobber a target outside the project. pi's restore must lstat and skip non-regular files.
- Multi-root / out-of-scope paths: OpenCode scopes capture to the session's active directory; edits above the session cwd escape. pi sessions have a single cwd (session-manager), so the boundary exists already — edits via absolute paths outside it need a policy.
- Retention: without a cap, snapshots grow forever; with a cap (Claude Code: 100 checkpoints), deep rewinds silently fail ("No files were restored"); time-based sweeps (30 days) break old resumed sessions. pi needs both a count cap and a sweep tied to existing session cleanup.
- Interaction with session fork: pi's fork (`SessionBeforeForkEvent`, `fork(entryId, {position})` in `packages/coding-agent/src/core/extensions/types.ts`) creates a new session file from an entry. Snapshots must be addressable by entry id so fork+restore compose: VS Code exposes Restore vs Fork as separate hover actions on the same checkpoint; Cursor tells users to fork when they want conversation truncation and restore when they want file reversion. Also note Codex/OpenCode regressions where revert/fork only worked from the latest message — arbitrary-entry restore needs per-entry snapshots, not just a rolling "last state."
- Concurrent processes: external editors/other agents may modify a tracked path after capture; OpenCode warns restores can overwrite such edits. A cheap mitigation is comparing current content to the last-known post-edit content before overwriting, and skipping (with a warning) on mismatch.
- Interrupted turns: OpenCode takes paired snapshots (before model call + at recorded success/failure) because a turn aborted mid-flight still needs a restorable boundary. pi should snapshot before each mutating tool call, not once per turn, to get this for free.
- Subagent edits: Claude Code excludes subagent/background edits from restore. pi runs extensions/subagents that write files; decide whether their writes route through the same snapshotting write path (simplest: they do).

## Design takeaways for pi

- Snapshot before every mutation by pi's own tools — write.ts and edit.ts already serialize through `core/tools/file-mutation-queue.ts`, giving a single choke point; store the pre-mutation bytes keyed by (session id, entry id, path). This is Claude Code's model: O(edited file), no git dependency, safe in non-git directories, and it never captures files the agent didn't touch. Optionally also snapshot before bash.ts executes (Cline's timing) — or at minimum before bash commands, pair a snapshot like OpenCode's per-step model; if bash coverage is too costly, document the exclusion like Claude Code does.
- Keep restore scoped to agent-attributed paths only: replay the recorded (path → pre-state) pairs for all entries after the rewind point; delete files the agent created; never touch paths not present in the snapshot index. This is the "never revert user changes" invariant (OpenCode restores "only paths attributed to assistant steps").
- Pair restore with pi's existing fork rather than replacing it: `/rewind <entry>` should offer "restore code", "restore conversation" (existing navigateTree/fork machinery), or both — the three-way split that Claude Code, Cline, and VS Code all converged on. Cheapest correct combination: fork to the entry (conversation) + snapshot replay (files), so rewind is non-destructive to the transcript and re-runnable.
- Store snapshots under pi's session storage (`~/.pi/agent/sessions/<encoded-cwd>/`, next to the JSONL session files — see `computeDefaultSessionDirectory` in `core/session-manager.ts`), content-addressed by file hash so repeated edits of the same file dedupe, with the first snapshot per file kept as a session-diff baseline (Claude Code's trick for the VS Code diff view; also enables a `pi diff session` later).
- Cap and sweep: keep snapshots for the last N entries (Claude Code uses 100 checkpoints) plus a time-based sweep aligned with existing session cleanup; deleting a checkpoint deletes only blobs no remaining checkpoint references.
- Skip and report non-regular files: lstat before restore; skip symlinks/hardlinks with an explicit "skipped N files" message (Claude Code v2.1.216 semantics), log skipped paths to the session debug output. Refuse to restore through directory renames or into parent dirs that no longer resolve.
- Guard against clobbering concurrent edits: before overwriting a path on restore, compare current content to the recorded post-edit content; on mismatch, skip and warn (OpenCode's documented residual risk becomes a handled case).
- Make it disableable and default-safe: a setting (`snapshotting: false`) that stops future capture but not restore of existing snapshots (OpenCode semantics), and never write anything into the user's repo or its `.git` — pi's value here is being the harness that reverts an agent turn without touching the user's git state at all (the explicit contrast with Aider).

## Sources

- https://code.claude.com/docs/en/checkpointing (Claude Code checkpointing, official)
- https://code.claude.com/docs/en/agent-sdk/file-checkpointing (Agent SDK file checkpointing, official)
- https://www.buildthisnow.com/blog/guide/mechanics/claude-code-checkpoints-rewind (community teardown: storage path, retention mechanics)
- https://github.com/luongnv89/claude-howto/blob/main/08-checkpoints/README.md (community guide: settings/env to disable)
- https://aider.chat/docs/git.html (Aider git integration, official)
- https://aider.chat/docs/usage/commands.html (Aider /undo wording, official)
- https://cursor.com/docs/agent/overview (Cursor agent checkpoints, official)
- https://cursor.com/help/ai-features/agent (Cursor restore checkpoint, official help)
- https://forum.cursor.com/t/revert-restore-checkpoint-button-missing/165791 (community bug report)
- https://vibe-replay.com/blog/cursor-local-storage/ (community storage teardown)
- https://opencode.ai/v2/docs/snapshots (OpenCode snapshots, official)
- https://github.com/anomalyco/opencode/issues/9661 (OpenCode desktop missing revert/fork)
- https://www.reddit.com/r/opencodeCLI/comments/1s30y0e/ (community: revert/fork only from latest message)
- https://docs.cline.bot/core-workflows/checkpoints (Cline checkpoints, official)
- https://github.com/cline/cline/issues/9590, https://github.com/cline/cline/issues/8273, https://github.com/cline/issues/1211 (Cline checkpoint issues; surfaced via search, not individually fetched)
- https://google-gemini.github.io/gemini-cli/docs/cli/checkpointing.html (Gemini CLI checkpointing, official)
- https://google-gemini.github.io/gemini-cli/docs/cli/commands.html (Gemini CLI /restore and /chat commands, official)
- https://github.com/google-gemini/gemini-cli/issues/10223 (feature request, closed backlog)
- https://github.com/openai/codex/discussions/9618 (Codex: no /rewind, esc-esc is conversation-only)
- https://github.com/openai/codex/issues/11626 (Codex: /rewind feature request)
- https://community.openai.com/t/creating-snapshots-of-previous-states/1379508 (Codex: esc rewind only rewinds conversation)
- https://medium.com/@furry_ai_diary/why-codex-still-cant-undo-its-own-file-edits-a-possible-solution-implemented-9b2b01f6ab7b (Codex IDE undo scoping, community)
- https://code.visualstudio.com/docs/agents/run/review-code-edits (VS Code Copilot agent checkpoints, official)
- https://replit.com/blog/inside-replits-snapshot-engine (Replit snapshot engine, official blog)
- Local grounding (repo, read-only): `packages/coding-agent/src/core/extensions/types.ts` (SessionBeforeForkEvent, fork/navigateTree), `packages/coding-agent/src/core/session-manager.ts` (~/.pi/agent/sessions layout), `packages/coding-agent/src/core/tools/` (write.ts, edit.ts, bash.ts, file-mutation-queue.ts)
