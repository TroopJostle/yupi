# Feature 08: File Checkpoints and Rewind

Snapshot the pre-mutation state of every file pi's `write` and `edit` tools change, store content-addressed copies beside the session JSONL files under `~/.pi/agent/sessions/<encoded-cwd>/checkpoints/`, and add a `/rewind` command that reverts the agent's file changes after a chosen user message — independently of, or paired with, pi's existing conversation forking. Restore touches only paths the agent's own tools mutated and never writes anything into the user's repository or its git state. This is Claude Code's per-edit file-copy model implemented at pi's `file-mutation-queue.ts` serialization choke point.

## Metadata

- Priority: medium
- Effort: L (new storage module, tool wiring, restore engine, TUI command; no provider/protocol changes)
- Risk: medium (touches the write/edit hot path; failure must never block a tool call; restore can delete agent-created files)
- Depends on: nothing unbuilt. Uses existing `withFileMutationQueue` (`packages/coding-agent/src/core/tools/file-mutation-queue.ts`), `SessionManager` tree/branch APIs (`packages/coding-agent/src/core/session-manager.ts`), and `AgentSessionRuntime.fork` (`packages/coding-agent/src/core/agent-session-runtime.ts`).
- Research: `feature-tasks/research/08-file-checkpoints-rewind.md`

Jargon used below:

- Checkpoint: one record of "file X had bytes B (or did not exist) immediately before tool call T ran", plus the hash of the bytes T wrote.
- Blob: a raw file copy stored once, named by the sha256 of its content (content-addressed), so repeated edits of identical content dedupe to one blob.
- Span: the set of session entries strictly after a boundary entry on the current branch — the agent work being reverted.
- Shadow git: a second git object database owned by the tool (OpenCode/Cline/Gemini style). Rejected here; see Proposed design.

## Problem

Concrete trace. A user asks pi to refactor an Express app. Over three turns the agent makes 6 file edits:

- Turn 1 (user message `u1`, assistant entry `a1`): `edit src/routes/users.ts`, `edit src/routes/auth.ts` — good.
- Turn 2 (user message `u2`, assistant entry `a2`): `write src/middleware/validate.ts`, `edit src/routes/users.ts`, `edit src/db/schema.sql` — wrong approach; the schema edit is bad.
- Turn 3 (user message `u3`, assistant entry `a3`): `edit src/server.ts`, `edit src/routes/users.ts` — builds on turn 2's mistake.

The user realizes turn 2 was wrong and wants the code as it was after turn 1, with a conversation that continues from there. Today pi gives half of this: `/fork` and `/tree` (`packages/coding-agent/src/core/agent-session-runtime.ts` `fork()`, `SessionManager.branch()`/`createBranchedSession()`) restore the conversation, but every one of the 6 edits is still on disk. The user's only option is manual `git checkout`/`git diff` archaeology — and if the worktree was dirty before the session or the directory is not a git repo, even that fails, with real risk of destroying their own uncommitted edits. This is exactly the gap the research dossier documents for OpenAI Codex ("Esc rewind only rewinds conversation/history... prior file edits remain in the working tree"). pi needs file state that follows the conversation back, without committing anything to the user's git history.

## Prior art

Condensed from the research dossier (`feature-tasks/research/08-file-checkpoints-rewind.md`); URLs included.

- Claude Code (current, shipped)
  - Mechanism: per-file pre-edit copies stored outside the repo under `~/.claude/file-history/<session>/`. "A checkpoint is not a git commit and it is not a snapshot of your whole repository." https://code.claude.com/docs/en/checkpointing
  - Capture timing: copy of each file immediately before Write/Edit/NotebookEdit modifies it; one checkpoint per user prompt that starts a turn. https://code.claude.com/docs/en/agent-sdk/file-checkpointing
  - Restore semantics: `/rewind` menu with Restore code and conversation / Restore conversation / Restore code / Summarize options; code options appear only when the checkpoint has tracked file changes. Files-only restore deletes files the agent created and restores files it modified. https://code.claude.com/docs/en/checkpointing
  - Storage/caps: per session; "the 100 most recent checkpoints"; discarding a checkpoint deletes blobs no remaining checkpoint references except each file's first snapshot (diff baseline); time sweep ~30 days (`cleanupPeriodDays`). https://code.claude.com/docs/en/checkpointing, https://www.buildthisnow.com/blog/guide/mechanics/claude-code-checkpoints-rewind
  - Exclusions: bash-command modifications not tracked; external/user edits not captured; symlink/hardlink restores skipped with "skipped N files" warning; directory create/move/delete not undone; disable via setting/env. https://code.claude.com/docs/en/checkpointing
- Aider
  - Mechanism: real commits in the user's own repo; pre-existing dirty changes committed first so `/undo` (guarded reset of aider's last commit) can never discard user work. https://aider.chat/docs/git.html, https://aider.chat/docs/usage/commands.html
  - Trade-off: first-class history (blame/branch/revert) at the cost of repo pollution and rewriting the user's staging area — a non-starter for pi, which must not touch the user's git state at all.
- Cursor
  - Mechanism: local snapshots "separate from Git"; created before significant changes. Restore is files-only; conversation truncation is a separate fork action. https://cursor.com/docs/agent/overview, https://cursor.com/help/ai-features/agent
- OpenCode
  - Mechanism: shadow git object database under its data directory; paired snapshots (before model call + at recorded success/failure); scope = tracked files in the active directory plus non-ignored untracked files up to 2 MiB each. https://opencode.ai/v2/docs/snapshots
  - Restore: `/undo` stages a rollback; restores only paths attributed to assistant steps after the boundary; files created by those steps are removed; unattributed paths untouched; external edits between capture and restore can be overwritten (documented residual risk). Same docs.
  - Exclusions: gitignored files, untracked > 2 MiB, outside active directory, git metadata; shell effects not reversed.
- Cline
  - Mechanism: full-worktree shadow git commits after every tool use including commands. Three-way restore menu (Files / Task / Both). Captures everything including untracked/gitignored files. https://docs.cline.bot/core-workflows/checkpoints
  - Counterexamples: "significant storage and slow down" on large repos; corruption (#9590), `.git` deletion reports (#8273), and `commit.gpgsign` prompts because shadow commits inherit the user's git config (#1211). https://github.com/cline/cline/issues/9590 et al.
- Gemini CLI
  - Mechanism: opt-in shadow git repo at `~/.gemini/history/<project_hash>` + JSON sidecars in `~/.gemini/tmp/...`; checkpoint before each AI file modification; `/restore` reverts files, restores conversation, and re-proposes the pending tool call. https://google-gemini.github.io/gemini-cli/docs/cli/checkpointing.html, https://google-gemini.github.io/gemini-cli/docs/cli/commands.html
- OpenAI Codex CLI
  - No file rewind. Esc-Esc forks conversation only; open feature request for a `/rewind` covering chat and files. https://github.com/openai/codex/discussions/9618, https://github.com/openai/codex/issues/11626. This is pi's current situation.
- VS Code Copilot agent (closest UX analog)
  - Per-request snapshots of affected workspace files; hover actions Restore Checkpoint vs Fork Conversation as separate verbs on the same point; terminal-command effects not reversed; "checkpoints are temporary and don't replace Git". https://code.visualstudio.com/docs/agents/run/review-code-edits

## Proposed design

### Chosen mechanism: per-edit file copies (Claude Code model), not shadow git

Why, against the dossier's trade-off analysis and pi's minimalism:

- Correctness for the invariant that matters: restore must only revert agent-attributed changes. Per-edit copies capture exactly the paths pi's own `write`/`edit` tools touch — the user's unrelated files, including untracked secrets, are never captured. A shadow git repo that walks the worktree (Cline) captures user secrets into a second copy on disk; even OpenCode's scoped version inherits the user's git config (Cline's `commit.gpgsign` bug) and degrades outside a git worktree.
- Cost: O(edited file) per checkpoint, bounded by a size cap. Full-tree shadow commits are O(worktree) per checkpoint (Cline's monorepo slowdowns). pi is a CLI that must stay fast in huge repos.
- Zero git dependency and zero user-git interaction: works in non-git directories, cannot trip user hooks, cannot appear in `git status`. Aider-style real commits are rejected outright: pi must revert an agent turn without touching the user's git state at all.
- pi already has the choke point: every `write.ts`/`edit.ts` mutation runs inside `withFileMutationQueue` (`core/tools/file-mutation-queue.ts`), which serializes per-realpath. Capturing inside that lock, immediately before the mutation, gives an atomic read-before-write with no new locking machinery.
- Accepted limitations (documented, not hidden): renames appear as two unrelated path events; directory create/move/delete is not undone (same as Claude Code); bash-made changes are not captured (phase 1; see out-of-scope).

### Capture points

- Primary: inside `createWriteToolDefinition`/`createEditToolDefinition` `execute`, within the existing `withFileMutationQueue(absolutePath, ...)` callback, immediately before `ops.writeFile(...)`. At that point the tool has: `absolutePath` (resolved via `resolveToCwd`), the full post-mutation content (`content` in write.ts, `finalContent` in edit.ts), `_toolCallId`, and `ctx?: ExtensionContext` (cwd + `sessionManager`).
- Attribution: `ctx.sessionManager.getLeafId()` at tool-execution time is the assistant message entry that issued the tool call (pi persists the completed assistant message on `message_end` before tools run; tool results append after). That entry id keys each record to its turn and makes checkpoints addressable by the same entry ids `/fork` and `/tree` use.
- The alternative hook — the extension `tool_call` event (`agent.beforeToolCall` in `core/agent-session.ts` `_installAgentToolHooks`) — is rejected as the capture point: it fires outside the mutation queue (no serialization against the write it precedes) and fires for any tool named `write`/`edit`, including extension-registered remote tools.
- Custom operations: `WriteToolOptions.operations`/`EditToolOptions.operations` exist so file I/O can be delegated to remote systems (e.g. SSH). When a caller passes custom operations, capture is disabled for that tool instance — snapshotting the local path when the write lands on a remote host would record wrong pre-state and a restore could delete a local file the agent never touched.
- Optional bash guard: out of scope for phase 1 (see out-of-scope list); the exclusion is documented loudly in `/rewind` help text and the changelog, following Claude Code and VS Code.

### Restore: agent-attributed paths only, with a mismatch guard

Restoring to a boundary user-message entry `E`:

1. Compute the span: `branch = sessionManager.getBranch()` (root-to-leaf on the current path); span = entries strictly after `E`.
2. Load records from this session's checkpoint index plus ancestor session indexes (forks preserve entry ids — `createBranchedSession` copies entries with their ids — so records from a parent session remain valid; walk `SessionHeader.parentSession` file paths). Keep only records whose `entryId` is in the span id set (this also drops ancestor records from abandoned branches).
3. Group by `path`. Per path take the earliest record (pre-state to restore: delete if it says the file did not exist, else write its blob and mode) and the latest record (its `postHash` is the expected current content).
4. Guard before touching each path, inside `withFileMutationQueue(path, ...)`:
   - `lstat`: symlink or non-regular file → skip, warn ("skipped N files", reasons listed) — Claude Code v2.1.216 semantics; never write through a link.
   - Hash current bytes; if missing or not equal to the latest record's `postHash` → skip, warn `modified-since`. This is the never-clobber-user-edits guard: a user edit, another session's edit, or a bash-side modification after the agent's last write makes the file diverge from what the agent last wrote, and restore refuses to touch it. (Conservative corner case: an agent write followed by an agent bash edit also mismatches and is skipped — acceptable; warned, never silent.)
   - Missing blob file → skip, warn `missing-blob`.
5. Apply: write `blobs/<preBlob>` bytes and `mode`, or `unlink` agent-created files. Report restored / deleted / skipped counts and skipped paths.

Only paths present in the index are ever touched. Restore does not delete records (it stays repeatable); new edits after a restore append new records.

### Storage

Beside session storage, keyed off values the tools already have at call time:

```
<sessionDir>/checkpoints/<sessionId>/
  index.jsonl      # one JSON CheckpointRecord per line, append-only
  blobs/<sha256>   # raw pre-state copies, content-addressed
```

- `<sessionDir>` is `ctx.sessionManager.getSessionDir()` — the encoded-cwd directory that already holds the session `.jsonl` files (`getDefaultSessionDir` in `core/session-manager.ts` builds `~/.pi/agent/sessions/--<encoded-cwd>--`). Checkpoints thus live under the pi agent dir, never inside the user's repo, and ride along with per-project session storage (including custom `--session-dir`).
- In-memory sessions (`SessionManager.inMemory`, `isPersisted() === false`) return `""` from `getSessionDir()` → capture is skipped entirely.
- Blob write order is crash-safe: write blob first (`wx` flag; skip if it exists — dedupe), then append the index line. An orphan blob is garbage; a record without a blob cannot happen except disk-full, and restore treats a missing blob as a warned skip.
- Per-session blob namespace (not cross-session) keeps refcounting trivial for the cap and sweep; the cost is duplicated blobs across same-cwd sessions, accepted (Claude Code is per-session too).

Record shape (erasable TypeScript, explicit fields):

```ts
export interface CheckpointRecord {
	checkpointId: string;
	/** Session entry id of the assistant message whose tool call triggered capture. */
	entryId: string | null;
	toolCallId: string;
	/** Absolute, resolved path that was mutated. */
	path: string;
	/** False when the tool created the file (restore deletes it). */
	existed: boolean;
	/** sha256 hex of pre-state bytes; absent when existed === false. */
	preBlob?: string;
	/** sha256 hex of the post-state bytes the tool wrote (mismatch guard). */
	postHash: string;
	/** Permission bits (stat.mode & 0o777) to restore executability. */
	mode?: number;
	size: number;
	timestamp: string;
}
```

Index linkage to conversation turns is `entryId`: the same ids `/fork` (`AgentSessionRuntime.fork(entryId, { position: "before" | "at" })`), `/tree`, and `SessionTreeEvent`/`SessionBeforeForkEvent` operate on.

### Restore UX: `/rewind` command, three-way pairing with fork

- `/rewind` opens the same user-message picker `/fork` uses (`UserMessageSelectorComponent`, fed by `AgentSession.getUserMessagesForForking()`), then a confirmation dialog (`showExtensionSelector`) offering, Claude Code/Cline/VS Code-style:
  1. Restore code and conversation (default)
  2. Restore code only
  3. Restore conversation only
- "Conversation" is the existing non-destructive fork: `runtimeHost.fork(entryId)` (position `"before"` — new session file, prompt text back in the editor). No new conversation machinery.
- "Code" is `AgentSession.rewindFilesAfter(entryId)` (new; runs the restore algorithm above and returns the report).
- "Both" order: code restore first, then fork. Rationale: the restore looks up records by the pre-fork branch's entry ids from the old session's store; forking first would move the runtime to a new session id (ancestor lookup covers it, but restore-then-fork avoids depending on it for the primary flow).
- Code options are offered only when checkpoint records exist after the chosen entry ("No file changes to restore" otherwise), mirroring Claude Code.
- Conversation-only restore with no code restore leaves the transcript describing edits that are back on disk's future — that is the user's explicit choice, same as Claude Code's split menu.

### Caps and retention

- Count cap per session: keep the most recent `checkpoints.maxCheckpoints` records (default 100, Claude Code's number), always retaining additionally the oldest record per distinct path (Claude Code's first-snapshot baseline, which preserves "state before pi first touched the file" for deep rewinds). Enforced after each append by rewriting `index.jsonl` (tmp file + rename) and deleting blobs whose hash is referenced by no retained record.
- Time sweep: pi currently has no session retention sweep at all (verified: `session-manager.ts` only writes; nothing deletes old sessions), so the sweep is self-contained in the checkpoint module: on session start, scan sibling `checkpoints/<sessionId>/` dirs and delete any whose directory mtime is older than `checkpoints.retentionDays` (default 30) or whose matching session file no longer exists in `<sessionDir>` (session files are named `<fileTimestamp>_<sessionId>.jsonl` — ISO timestamp with `[:.]` replaced by `-`, then underscore, then session id — per `SessionManager.newSession`).
- Disable: `checkpoints.enabled: false` in settings stops future capture but leaves existing snapshots restorable (OpenCode semantics: disabling "does not delete snapshots already stored").

### Exclusions (each is a deliberate policy from the dossier)

- Symlinks/hardlinks: `lstat` before capture-restore; non-regular files are skipped from capture and always skipped (warned) on restore.
- Size: files larger than `checkpoints.maxFileBytes` (default 2 MiB, OpenCode's per-file untracked cap as a sane copy bound) are not captured; a debug-level note is recorded and `/rewind` reports them as never-checkpointed if they appear in the span's tool results.
- Gitignored/untracked policy: captured regardless of ignore status when the agent's own tools touched them (Claude Code's model). Consequence: if the agent edits `.env`, the pre-state copy (possibly containing secrets) lives under `~/.pi/agent/...` — same trust domain as session JSONL, which already stores file contents in diffs; documented in settings help.
- Out-of-cwd paths: pi sessions have a single cwd; `write`/`edit` accept absolute paths anywhere. Capture only paths under the session cwd (resolve + prefix check); out-of-cwd edits are skipped from capture with a warning. Keeps restore scoped to the project directory.
- Binary files: captured fine (raw byte copy + sha256).
- Bash-made changes: not captured; documented loudly.

### Out of scope (phase 1)

- Snapshotting before bash commands (any variant: per-command heuristic, paired pre-call/post-step snapshots, or Cline-style full-tree).
- Undo of directory creation/moves/deletes; rename tracking.
- Session-diff view over checkpoint baselines (`pi diff session`); the first-per-path baseline record is kept so this is possible later.
- RPC/SDK command surface for rewind (interactive `/rewind` only); extension API exposure; `doubleEscapeAction` integration.
- Cross-session blob dedupe; compression of blobs.

## Implementation plan

Ordered, file by file. All code must satisfy repo rules: erasable TypeScript only (no enums, no parameter properties, top-level imports only), no `any` unless unavoidable, exact-pinned deps (none new here — only `node:fs`, `node:path`, `node:crypto`).

1. New `packages/coding-agent/src/core/checkpoints/types.ts`
   - `CheckpointRecord` (shape above), `CheckpointCapture` interface with one method `capturePreMutation(input: MutationCaptureInput): Promise<void>`, and `MutationCaptureInput` with explicit fields: `absolutePath: string`, `nextContent: string`, `toolCallId: string`, `entryId: string | null`, `sessionId: string`, `sessionDir: string`, `cwd: string`. Plus `RestoreResult` with explicit fields `restored: string[]`, `deleted: string[]`, `skipped: Array<{ path: string; reason: "modified-since" | "symlink" | "missing-blob" | "out-of-cwd" | "read-error" }>`.

2. New `packages/coding-agent/src/core/checkpoints/store.ts`
   - `export class CheckpointStore` with explicit fields and constructor assignment:
     - `static open(sessionDir: string, sessionId: string): CheckpointStore` — creates `checkpoints/<sessionId>/` lazily; module-level `Map<string, CheckpointStore>` cache keyed by `<sessionDir>/<sessionId>` (stores are plain fs handles; caching is safe).
     - `capture(input: MutationCaptureInput): Promise<void>` — skip when `sessionDir === ""` (in-memory), when `lstat` shows non-regular file, when `stat.size > maxFileBytes`, or when path is not under `cwd`; otherwise `readFile` → sha256 → write `blobs/<hash>` with flag `"wx"` (ignore EEXIST) → sha256 of `nextContent` for `postHash` → append record line → `enforceCap()`.
     - `records(): CheckpointRecord[]` — parse `index.jsonl` (tolerate truncated last line).
     - `recordsForEntries(ids: Set<string>): CheckpointRecord[]`.
     - `readBlob(hash: string): Promise<Buffer | undefined>`.
     - `enforceCap(): void` — as designed in Caps.
     - `static sweep(sessionDir: string, retentionDays: number): void` — as designed in Caps (called once per session start).
   - Defaults exported: `DEFAULT_MAX_CHECKPOINTS = 100`, `DEFAULT_MAX_FILE_BYTES = 2 * 1024 * 1024`, `DEFAULT_RETENTION_DAYS = 30`.
   - `randomUUID` from `node:crypto` for `checkpointId`; `createHash("sha256")` for hashes.

3. New `packages/coding-agent/src/core/checkpoints/capture.ts`
   - `export const defaultCheckpointCapture: CheckpointCapture` — implements `capturePreMutation` by resolving the store via `CheckpointStore.open(input.sessionDir, input.sessionId)` and delegating to `store.capture(input)`. Wrap the whole body in try/catch: checkpoint failure must log (a one-line warning through a pluggable `onError` field, default `console.error`-to-debug) and never reject — a broken snapshot must not block the edit.

4. New `packages/coding-agent/src/core/checkpoints/restore.ts`
   - `readSessionHeaderFirstLine(sessionFile: string): { id: string; parentSession?: string } | undefined` — read/parse the first JSONL line only (avoids importing non-exported session-manager internals).
   - `collectRecords(sessionFile: string): CheckpointRecord[]` — own index + walk `parentSession` chain (records from ancestor session dirs, resolved relative to each parent file's directory).
   - `restoreAfterBoundary(args: { sessionFile: string; boundaryEntryId: string; branchEntryIds: string[] }): Promise<RestoreResult>` — the algorithm from Proposed design (span = `branchEntryIds` strictly after the boundary; per-path earliest/latest; guards; apply inside `withFileMutationQueue` imported from `../tools/file-mutation-queue.ts`).

5. `packages/coding-agent/src/core/checkpoints/index.ts` — re-export the public surface (`CheckpointStore`, `defaultCheckpointCapture`, `restoreAfterBoundary`, types). Export from `src/index.ts` only if the SDK needs it (defer; not required for phase 1).

6. `packages/coding-agent/src/core/settings-manager.ts`
   - Add `export interface CheckpointsSettings { enabled?: boolean; maxCheckpoints?: number; maxFileBytes?: number; retentionDays?: number; }` next to `CompactionSettings` (line ~23) and `checkpoints?: CheckpointsSettings;` on `Settings` (line ~106 block). Add `getCheckpointsSettings(): CheckpointsSettings` applying defaults, following the existing getter pattern (`getCompactionSettings`, `getShellCommandPrefix`).

7. `packages/coding-agent/src/core/tools/write.ts`
   - Add to `WriteToolOptions`: `capture?: CheckpointCapture` (type-only import from `../checkpoints/types.ts`).
   - In `createWriteToolDefinition`: `const capture = options?.operations ? undefined : options?.capture;` (remote/custom ops exclude capture).
   - In `execute`, inside the `withFileMutationQueue` callback, between `await ops.mkdir(dir)` and `await ops.writeFile(absolutePath, content)`:

     ```ts
     if (capture && ctx?.sessionManager) {
         await capture.capturePreMutation({
             absolutePath,
             nextContent: content,
             toolCallId: _toolCallId,
             entryId: ctx.sessionManager.getLeafId(),
             sessionId: ctx.sessionManager.getSessionId(),
             sessionDir: ctx.sessionManager.getSessionDir(),
             cwd: ctx?.cwd || cwd,
         });
     }
     throwIfAborted();
     ```

     (`getSessionId`/`getSessionDir`/`getLeafId` are all on `ReadonlySessionManager`, which is what `ExtensionContext.sessionManager` is.)

8. `packages/coding-agent/src/core/tools/edit.ts`
   - Same as write.ts: `capture?: CheckpointCapture` on `EditToolOptions`, disabled when `options.operations` is set, invoked inside the queue after `finalContent` is computed and before `await ops.writeFile(absolutePath, finalContent)`, passing `nextContent: finalContent`. edit.ts has already read the file; capture still does its own read (keeps store logic uniform and correct when capture is enabled with default ops).

9. `packages/coding-agent/src/core/agent-session.ts`
   - `_buildRuntime` (line ~2787): in the `createAllToolDefinitions(this._cwd, { ... })` call (line ~2802), add:

     ```ts
     write: { capture: this.settingsManager.getCheckpointsSettings().enabled ? defaultCheckpointCapture : undefined },
     edit: { capture: this.settingsManager.getCheckpointsSettings().enabled ? defaultCheckpointCapture : undefined },
     ```

   - Once during construction (after `sessionManager` exists, persist mode only): `CheckpointStore.sweep(this.sessionManager.getSessionDir(), settings.retentionDays)`.
   - New public method:

     ```ts
     async rewindFilesAfter(boundaryEntryId: string): Promise<RestoreResult> {
         const sessionFile = this.sessionManager.getSessionFile();
         if (!sessionFile) throw new Error("Session is not persisted; nothing to rewind");
         const branch = this.sessionManager.getBranch().map((entry) => entry.id);
         const boundaryIndex = branch.indexOf(boundaryEntryId);
         if (boundaryIndex < 0) throw new Error(`Entry ${boundaryEntryId} not on the current branch`);
         return restoreAfterBoundary({
             sessionFile,
             boundaryEntryId,
             branchEntryIds: branch.slice(boundaryIndex + 1),
         });
     }
     ```

   - New read helper for the UI: `hasCheckpointsAfter(boundaryEntryId: string): boolean` (span non-empty in `collectRecords`).

10. `packages/coding-agent/src/core/slash-commands.ts`
    - Add to `BUILTIN_SLASH_COMMANDS`: `{ name: "rewind", description: "Revert agent file edits (and optionally fork) back to a previous message" }` (next to `fork`/`clone`, line ~33).

11. `packages/coding-agent/src/modes/interactive/interactive-mode.ts`
    - In the command dispatch chain (the `if (text === "/fork")` block, line ~3051), add:

      ```ts
      if (text === "/rewind") {
          this.showRewindSelector();
          this.editor.setText("");
          return;
      }
      ```

    - New private `showRewindSelector(): void`, modeled directly on `showUserMessageSelector()` (line 5165): `UserMessageSelectorComponent` (import already exists at line 154) over `this.session.getUserMessagesForForking()`; on selection, compute `this.session.hasCheckpointsAfter(entryId)`; if false, offer conversation-only (`this.runtimeHost.fork(entryId)` exactly as line 5181 does) or cancel; else `await this.showExtensionSelector("Rewind to this message?", ["Restore code and conversation", "Restore code only", "Restore conversation only", "Cancel"])` (the `showExtensionSelector` helper is at line 2499; escape/cancel paths mirror `showTreeSelector`'s loop at line ~5250):
      - conversation-only → `this.runtimeHost.fork(entryId)`; status "Forked to new session".
      - code only → `const report = await this.session.rewindFilesAfter(entryId)`; then summary status: `Restored ${report.restored.length}, deleted ${report.deleted.length}, skipped ${report.skipped.length}` plus, when non-empty, a follow-up `showExtensionSelector` listing skipped paths with reasons (Dismiss).
      - both → code restore, then fork.
      - Guard with `this.session.isStreaming` exactly like `showTreeSelector` (abort streaming before restoring files, lines ~5284-5296).
    - Optional (nice-to-have, separate commit): add `rewind` to the `/settings` checkpoints submenu and to `/hotkeys`-visible bindings only if a keybinding is added; do not hardcode a key check — if a double-escape `rewind` action is later wanted, extend the `doubleEscapeAction` setting union rather than hardcoding.

12. `packages/coding-agent/CHANGELOG.md` — entries under `## [Unreleased]` (see Changelog section below).

13. Run `npm run check` from the repo root and fix everything; run the new tests per the testing plan; do not run the full vitest suite.

## Testing plan

All tests under `packages/coding-agent/test/` (vitest). Run each with `node "$(git rev-parse --show-toplevel)/node_modules/vitest/dist/cli.js" --run test/<file>` from `packages/coding-agent`, or `./scripts/test.sh` from the repo root before finishing. Fixtures use `fs.mkdtemp(join(tmpdir(), "pi-checkpoints-"))` and clean up in `afterEach`. No real providers anywhere; agent-level tests use `test/suite/harness.ts` with the faux provider (`registerFauxProvider`/`streamSimple` from `@earendil-works/pi-ai/compat`).

1. `test/checkpoints/store.test.ts`
   - snapshot-before-edit: seed a file with content A; `store.capture` with `nextContent` B; assert record `existed: true`, blob equals A's bytes, `postHash` equals sha256(B).
   - created file: capture on missing path → `existed: false`, no blob.
   - dedupe: capture the same pre-content twice → one blob file on disk.
   - cap enforcement: `maxCheckpoints: 3`, capture 5 records over 2 paths → 3 newest kept plus each path's oldest; unreferenced blobs deleted; referenced kept.
   - sweep: create a checkpoints dir with old mtime (`utimes`) beyond `retentionDays` → deleted; recent dir and dir whose session file still exists → kept; dir with no matching session file → deleted.
   - exclusions: symlink path → no record; oversized file (tiny `maxFileBytes`) → no record; path outside `cwd` → no record.
   - crash safety: truncated last index line is tolerated by `records()`.

2. `test/checkpoints/restore.test.ts`
   - restore-to-checkpoint: hand-built session dir with a real session JSONL (header + entries `u1 < a1 < u2 < a2`); records attributed to `a1`/`a2` across two files, multiple edits per file; `restoreAfterBoundary` with boundary `u1` → each path back to its earliest pre-state; executable mode restored (`mode`).
   - delete created: `existed: false` record in span → file unlinked.
   - mismatch guard: after captures, overwrite one path with user content → restore skips it with `modified-since`; others still restored.
   - symlink skip: replace a span path with a symlink to a canary file → skipped as `symlink`, canary untouched.
   - missing blob: delete a blob file → `missing-blob` skip.
   - ancestor chain: parent session file with `parentSession` header pointing at a grandparent; records spread across both; boundary in the child → all span records found; records on ids not in the child's branch ignored.
   - boundary not on branch → throws.

3. `test/checkpoints/tool-capture.test.ts`
   - `createWriteToolDefinition(tmpCwd, { capture: fakeCapture })` (default ops): execute a write over an existing file → fake capture received `absolutePath`, `nextContent === content`, and the real pre-bytes via store integration; second write → two records, same entryId, deduped blobs.
   - `createEditToolDefinition` likewise: capture fired before the edit applied; pre-bytes are the original content; `nextContent` is the post-edit content.
   - custom `operations` passed → capture never invoked.
   - abort: `signal.aborted` before execute → no record.

4. `test/suite/rewind.test.ts` (agent-level, `test/suite/harness.ts` + faux provider, per repo rules for `test/suite/`)
   - Script a faux response whose assistant message issues a `write` tool call against a file in the harness tmp cwd; after the turn settles, assert a checkpoint record exists whose `entryId` is the assistant message entry on the current branch and whose pre-state matches the file's prior content.
   - `session.rewindFilesAfter(userEntryId)` → file content reverted; transcript untouched.
   - User modifies the file after the agent turn → rewind skips it (`modified-since`) and reports it.
   - Fork pairing: perform code restore then `fork`-equivalent via `SessionManager.createBranchedSession` semantics is already covered by existing fork tests (`agent-session-branching.test.ts`); here assert only that entry ids used by records survive a `createBranchedSession`-produced session file (ids preserved), so post-fork rewind still finds span records via the ancestor chain.

5. Regression guards in existing suites: `test/file-mutation-queue.test.ts` and `test/edit-tool-legacy-input.test.ts` must still pass unchanged (capture is additive inside the queue).

## Changelog

Draft entries for `packages/coding-agent/CHANGELOG.md` under `## [Unreleased]`:

### Added

- Added file checkpoints and `/rewind`: the `write` and `edit` tools snapshot the pre-edit state of each file they change (content-addressed copies under the session directory), and `/rewind` restores code, conversation (fork), or both back to a previous user message without touching the user's git history. Restores only revert agent-edited paths, skip files modified since the agent's last write, and skip symlinks with a warning. Bash-command file changes are not checkpointed. Configure via the `checkpoints` settings (`enabled`, `maxCheckpoints`, `maxFileBytes`, `retentionDays`); disabling stops future capture but keeps existing snapshots restorable.

## Risks and open questions

- Disk usage: worst case is 100 checkpoints x 2 MiB of distinct pre-states per session, plus baselines. The count cap, size cap, per-session sweep, and content-addressed dedupe bound it; multi-hundred-MB growth requires pathological use. Open: whether to gzip blobs (rejected for phase 1 — raw copies keep restore trivially binary-safe).
- Races with concurrent sessions: two pi sessions in the same cwd have separate stores; session A's restore can hit a file session B just wrote — the `postHash` guard skips it (`modified-since`) instead of clobbering. Within one session, capture and restore both run inside `withFileMutationQueue`, so they serialize against the agent's own writes. Residual race: an external editor writing between the guard's hash and the restore write — same window Claude Code/OpenCode accept; restore is user-initiated and idle-gated.
- Secrets in snapshot storage: agent edits to `.env`-style files store pre-state bytes under `~/.pi/agent/sessions/...`. Same trust domain as session JSONL (which already contains edit diffs). Documented in settings help; open question whether to add an ignore-list setting later.
- Multi-root repos: pi sessions have a single cwd; edits outside it (absolute paths) are not checkpointed and `/rewind` reports them as uncovered. Users with monorepo roots must start pi at the root.
- Baseline retention vs. deep rewind: keeping each path's oldest record means a "rewind to before the first turn" stays possible even past the count cap; rewinds older than the cap for non-baseline intermediate states silently degrade to the baseline pre-state (Claude Code's documented "No files were restored" failure mode becomes "restored to first-touch state" — verify this is acceptable; alternative is refusing when the exact earliest in-span record was capped away).
- Fork interplay: after "both", the forked session's future edits checkpoint under the new session id; ancestor-chain lookup keeps old records reachable. `/rewind` after a `/tree` navigation uses the current branch, so abandoned-branch records are correctly ignored. Open: whether `session_before_fork` should gain a `skipFileRestore`-style hook for extensions that manage file state themselves (existing `SessionBeforeForkResult.skipConversationRestore` is the precedent).
- Performance: capture adds one `readFile` + sha256 + (usually skipped) blob write per edit, bounded by `maxFileBytes`. Not expected to be measurable next to an LLM round trip.

## Acceptance criteria

- [ ] An `edit` or `write` tool call over an existing file records the file's exact pre-mutation bytes (and mode) in `<sessionDir>/checkpoints/<sessionId>/`, content-addressed, before the mutation lands; identical pre-content across edits dedupes to one blob on disk.
- [ ] A tool call creating a new file records `existed: false` with a `postHash` and no blob.
- [ ] Checkpoint capture is attributed to the assistant entry id of the issuing turn (`ctx.sessionManager.getLeafId()` at execution time).
- [ ] `/rewind` lists user messages (same picker as `/fork`), and code options appear only when checkpoints exist after the selection.
- [ ] "Restore code only" reverts every agent-touched path in the span to its earliest pre-state in the span, deletes agent-created files, leaves the transcript untouched, and reports restored/deleted/skipped counts.
- [ ] "Restore conversation only" behaves exactly like `/fork` today (new session file, non-destructive).
- [ ] "Restore code and conversation" does code restore then fork; the forked session can still rewind older entries via ancestor-session record lookup.
- [ ] A user (or other process) modification to a span path after the agent's last write causes a warned skip, never an overwrite; a path the agent never touched is never read or written by restore.
- [ ] Symlinked span paths are skipped with a warning; restore never writes through a link.
- [ ] Files over `checkpoints.maxFileBytes`, non-regular files, and paths outside the session cwd are excluded from capture.
- [ ] Per-session record cap (default 100) plus per-path baseline retention is enforced; unreferenced blobs are deleted; a time sweep (default 30 days) and orphan-session cleanup remove stale checkpoint dirs.
- [ ] `checkpoints.enabled: false` stops capture immediately and leaves existing snapshots restorable; in-memory sessions never capture.
- [ ] Tools with custom `operations` (e.g. SSH) never capture; a checkpoint-store failure (permissions, disk) logs and never fails the tool call.
- [ ] Nothing is ever written inside the user's repository or its `.git`; the user's `git status` is byte-identical before and after any capture or restore (modulo the file contents being intentionally reverted).
- [ ] `npm run check` passes clean; all new tests and the existing `test/file-mutation-queue.test.ts`, `test/session-manager/`, and `test/suite/` suites pass; no real provider or network access in tests.
- [ ] `packages/coding-agent/CHANGELOG.md` has the entry under `## [Unreleased]` in the existing format; no other packages change.
