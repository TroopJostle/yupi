# Feature 05: Skill Invocation Tool

Add a harness-managed `skill` tool to pi's coding agent that loads a skill's SKILL.md content into the conversation as the tool result, replacing today's contract where the model is told to read the SKILL.md file itself with `read`/`bash`. The system prompt keeps the `<available_skills>` catalog but swaps the self-read instruction for "call the skill tool"; the tool strips frontmatter, wraps the body in the same `<skill ...>` block pi already emits for user-run `/skill:name` commands (plus a sampled bundled-file listing), rejects unknown and model-invocation-disabled skills with corrective errors, deduplicates re-invocations, and its output is re-attached after context compaction. Sessions where the tool is not registered (restricted SDK/custom tool sets without it) keep the existing self-read instructions and `<location>` entries as a fallback.

## Metadata

- Priority: medium
- Effort: M (new tool + tool wiring + prompt text change + compaction hook; ~6 files touched plus tests)
- Risk: medium (changes the skills section of every system prompt with skills present; contract change must stay in sync between prompt text, tool registration, and fallback sessions)
- Depends on: none (standalone). Coordinate with the subagent-delegation feature (feature-tasks research 01) if subagent sessions get their own tool registries later.
- Research: feature-tasks/research/05-skill-invocation-tool.md

## Problem

Today pi's model-invoked skills path is "prompt-listed catalog + model self-read":

- `packages/coding-agent/src/core/skills.ts` `formatSkillsForPrompt()` renders an `<available_skills>` catalog (`<name>/<description>/<location>` per skill) and instructs: "Use the read tool to load a skill's file when the task matches its description."
- `packages/coding-agent/src/core/system-prompt.ts` `buildSystemPrompt()` appends that catalog only when `read` or `bash` is in the active tool list (`skillFileReadTool`).

Failure modes, with a concrete trace. A user with a `pdf-tools` skill asks "extract the table from invoice.pdf". The model sees:

```
<available_skills>
  <skill>
    <name>pdf-tools</name>
    <description>Extract and process PDF tables.</description>
    <location>/home/u/.pi/agent/skills/pdf-tools/SKILL.md</location>
  </skill>
</available_skills>
```

What can go wrong:

1. Model skips the read. It answers from memory ("use bash with pdftotext...") without ever loading the SKILL.md that defines the actual workflow. pi's own docs acknowledge this: `docs/skills.md` "How Skills Work" step 3 says "(models don't always do this; use prompting or `/skill:name` to force it)". Codex spends most of its skills contract text fighting the same thing ("must read its `SKILL.md` completely before taking task actions").
2. Burned turn. Even when the model complies, one full agent turn is spent on a `read` round-trip per skill before any task work starts.
3. Wrong-path resolution. The model reads `scripts/extract.py` relative to the cwd instead of the skill's base dir. That is why `formatSkillsForPrompt` carries the "resolve against the skill directory" instruction at all — it is a patch over self-read, not a guarantee.
4. No invocation guarantee or lifecycle. An ordinary `read` result is indistinguishable from any other file read: the harness cannot dedup re-reads, cannot apply `disable-model-invocation` at load time (only by hiding from the catalog), cannot protect the content during compaction, and cannot recognize skill loads for analytics.
5. Sessions without `read`/`bash` get no skills at all, because `buildSystemPrompt` gates the entire skills block on those tools.

A harness-invoked tool fixes all five: single turn, deterministic payload, harness-visible invocation records, and no read-tool dependency. The Agent Skills spec explicitly blesses both patterns and treats the choice as an implementation detail ("If the model has file-reading capabilities, it can read `SKILL.md` files directly. Otherwise, you'll provide a dedicated tool...").

## Prior art

### agentskills.io (the spec pi implements)

Sources: https://agentskills.io/integrate-skills , https://agentskills.io/specification

- Both activation modes are valid; catalog placement may be a "System prompt section" or a "Tool description"; the spec calls system-prompt placement "simpler and more broadly compatible".
- Recommended dedicated-tool behavioral instruction, verbatim: "The following skills provide specialized instructions for specific tasks. / When a task matches a skill's description, call the activate_skill tool with the skill's name to load its full instructions."
- Dedicated tool advantages: "Control what content is returned — e.g., strip YAML frontmatter or preserve it", "Wrap content in structured tags for identification during context management", "List bundled resources ... alongside the instructions", "Enforce permissions or prompt for user consent", "Track activation for analytics."
- Name-hallucination mitigation, verbatim: "constrain the `name` parameter to the set of valid skill names (e.g., as an enum in the tool schema). This prevents the model from hallucinating nonexistent skill names. If no skills are available, don't register the tool at all."
- Catalog `location` is only needed for file-read activation or relative-path resolution: "If your dedicated activation tool provides the skill directory path in its result ... you can omit `location` from the catalog."
- Content mode: "Body only (frontmatter stripped) ... Among existing implementations with dedicated activation tools, most take this approach."
- Compaction: "exempt skill content from pruning ... Flag skill tool outputs as protected so the pruning algorithm skips them." Dedup: "If the model (or user) attempts to load a skill that's already in context, you can skip the re-injection."
- Filtered skills: "Hide filtered skills entirely from the catalog rather than listing them and blocking at activation time. This prevents the model from wasting turns attempting to load skills it can't use." (`disable-model-invocation` is not in the spec's frontmatter table; it is a client-side convention pi already parses.)
- Progressive disclosure tiers: tier 1 catalog = name + description, ~50-100 tokens per skill at session start; tier 2 = full SKILL.md body on activation (recommended <5000 tokens); tier 3 = bundled resources on demand, never eagerly read.

### Claude Code

Sources: https://code.claude.com/docs/en/skills , https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills

- Built-in `Skill` tool; descriptions are always in context, "full skill content only loads when invoked"; invoked "by user slash command or by Claude via the Skill tool"; loaded content "stays there across later turns".
- Re-invocation dedup: identical rendered content "adds a short note that the skill is already loaded rather than a second copy of the content"; changed content re-injects in full.
- Compaction survival: after auto-compaction it "re-attaches the most recent invocation of each skill after the summary, keeping the first 5,000 tokens of each", within a combined 25,000-token budget filled newest-first; older skills can be dropped.
- `disable-model-invocation: true`: "Set to `true` to prevent Claude from automatically loading this skill." Description is not in context; if Claude tries anyway, "Claude Code blocks the call and instructs it not to reproduce the deploy steps another way" — a hard harness-side block with corrective feedback.
- Catalog cost: description (+`when_to_use`) truncated at 1,536 characters in the listing; authoring guidance "Keep `SKILL.md` under 500 lines."

### OpenCode

Source: https://opencode.ai/docs/skills/ , https://opencode.ai/v2/docs/skills/ , source `packages/core/src/tool/skill.ts`, `packages/core/src/skill/guidance.ts` (verified 2026-09)

- Tool name `skill`; input schema is a single plain string parameter `name: "The name of the skill from the available skills list"` — no enum; unknown names fail at execute time ("Unable to load skill X").
- Tool description, verbatim: "Load a specialized skill when the task at hand matches one of the available skills in the system context." / "Use this tool to inject the skill's instructions and resources into the current conversation. The output may contain detailed workflow guidance as well as references to scripts, files, etc. in the same directory as the skill."
- Tool result structure, verbatim: `<skill_content name="${name}">` / `# Skill: ${name}` / body without frontmatter / `Base directory for this skill: ${directory}` / "Relative paths in this skill (e.g., scripts/, reference/) are relative to this base directory." / "Note: file list is sampled." / `<skill_files><file>...</file>...</skill_files>` — file list is a glob of the skill dir (dot files included, SKILL.md excluded), sorted, capped at 10 entries; supporting-file contents are not loaded.
- `metadata.opencode/autoinvoke: false` "only hides the skill from the model's available list. It remains registered and can still be loaded explicitly by ID" (hide-don't-block).
- Permission gate at invocation (allow/ask/deny on action `skill`); when disabled, the `<available_skills>` section is omitted entirely.

### Gemini CLI

Source: https://geminicli.com/docs/cli/skills/

- Dedicated `activate_skill` tool; metadata injected in the system prompt at session start; "When Gemini identifies a task matching a skill's description, it calls the activate_skill tool."
- Activation delivers "The SKILL.md body and folder structure ... added to the conversation history" and "The skill's directory is added to the agent's allowed file paths" (bundled assets readable without extra permission prompts); a UI confirmation prompt shows skill name, purpose, and directory before loading.

### Codex CLI (hybrid — the pattern pi has today)

Sources: https://learn.chatgpt.com/docs/build-skills , https://simonwillison.net/2025/Dec/12/openai-skills/ , source `codex-rs/ext/skills/src/` (verified 2026-09)

- Filesystem skills: prompt-listed catalog (`## Skills` / `### Available skills`, one `- {name}: {description} ({locator_kind}: {locator})` bullet per skill) and model self-read; most of its contract text exists to fight self-read failure modes: "you must use that skill for that turn", "the main agent must read its `SKILL.md` completely before taking task actions", "Do not delegate reading, summarizing, or interpreting skill instructions to a subagent."
- Package-backed skills (no filesystem): dedicated `skills.read` / `skills.list` tools — the dedicated-tool pattern.
- Catalog budget: 2% of context window in tokens, or 8,000 characters when unknown; degradation shortens descriptions first, then omits skills, with explanatory warnings rendered to the model.
- Per-skill opt-out `allow_implicit_invocation` (default true; false blocks model triggering, "explicit $skill invocation still works").

### ZCode

Mechanism: `Skill` tool with `{skill: string, args?: string}`; content injected as the tool result; catalog as a system-reminder listing `- name (file: /abs/path/SKILL.md)`. Strong prompt contract, verbatim: "When a skill matches the user's request, this is a BLOCKING REQUIREMENT: invoke the relevant Skill tool BEFORE generating any other response about the task"; "NEVER mention a skill without actually calling this tool"; "Do not invoke a skill that is already running."

## Proposed design

### Tool name and schema

Tool name: `skill` (lowercase, matching pi's built-in `read`/`bash`/`edit`/`write` naming).

Schema (TypeBox, mirroring `packages/coding-agent/src/core/tools/read.ts`):

```ts
const skillSchema = Type.Object({
	name: Type.String({ description: "Exact name of the skill, from the available skills list in the system prompt" }),
});
```

Free string vs enum — decision: free string, rejected at execute time with a corrective error listing valid names. Justification:

- Skill sets are dynamic: they change on `/reload` and when extension-provided resources arrive mid-session (`extendResources` in agent-session.ts). An enum baked into the tool schema can drift from the catalog between refreshes; OpenCode hit this class of problem and moved its catalog to refreshable fragments. A free string has no drift.
- pi enables strict-prefer JSON-schema sampling for built-in tools (`constrainedSampling: { type: "json_schema", strict: "prefer" }`). Large literal unions (`Type.Union([Type.Literal(...), ...])`) bloat every provider request with the full skill name list — which is already in the system prompt — and strict-mode `anyOf`/enum handling varies by provider. The agentskills.io enum tip is a "tip", not a requirement; the corrective-error path achieves the same recovery with fewer provider-side failure modes.
- The unknown-name error message will list valid names, which is strictly better than OpenCode's "Unable to load skill X" (no list).

No `args` parameter in v1: pi's model-invoked path has no argument concept today, and user argument passing stays on `/skill:name args`. (Claude Code's "ARGUMENTS: <input>" append pattern is noted in Risks and open questions.)

Tool definition metadata:

- `label: "skill"`
- `description` (verbatim): `Load a skill's full instructions into the conversation. Call this tool when the current task matches one of the available skills listed in the system prompt. The result contains the skill's instructions, the skill's base directory for resolving relative paths, and a sampled list of bundled files. The name must match one of the listed skills exactly. Do not call this for a skill whose instructions are already in the conversation.`
- `promptSnippet: "Load a skill's instructions"` (one line, so it appears in the system prompt's "Available tools" list; `buildSystemPrompt` only lists tools that have a snippet).
- `promptGuidelines`: none (the catalog text carries the contract; avoids duplication).
- `constrainedSampling: { type: "json_schema", strict: "prefer" }` (consistent with other built-ins).
- `details` on results: `{ skill: string }` (skill name), so dedup and compaction do not have to parse text.

### Tool result format

Reuse and extend the exact wrapper `AgentSession._expandSkillCommand` already emits (agent-session.ts line ~1375), so model-invoked and user-invoked injections are indistinguishable downstream. Extract a shared, exported renderer in `core/skills.ts`:

```ts
/** Render a skill invocation block shared by the skill tool and /skill:name expansion. */
export function renderSkillInvocation(skill: Skill): string; // may throw on read failure
```

Output shape (illustration; `<skill_files>` omitted when the skill directory has no other files):

```
<skill name="pdf-tools" location="/home/u/.pi/agent/skills/pdf-tools/SKILL.md">
References are relative to /home/u/.pi/agent/skills/pdf-tools.

# PDF Tools

(body of SKILL.md, frontmatter stripped)

<skill_files>
<file>reference/tables.md</file>
<file>scripts/extract.py</file>
</skill_files>
File list is sampled; file contents are not loaded automatically.
</skill>
```

- Frontmatter stripped via the existing `stripFrontmatter` from `packages/coding-agent/src/utils/frontmatter.ts` (same as `_expandSkillCommand` today; matches the majority pattern per agentskills.io and OpenCode).
- File listing via a new `listSkillFiles(baseDir: string, cap = 10): string[]` in `core/skills.ts`: recursive `readdirSync` walk (skip dotfiles and `node_modules`, consistent with the loader's discovery rules), posix-relative paths, sorted, `SKILL.md` excluded, capped at 10 entries. OpenCode's cap and "file list is sampled" caveat, verbatim style.
- Both the tool result and the rewritten `_expandSkillCommand` use `renderSkillInvocation`, so the `/skill:name` expansion gains the `<skill_files>` block too. This is an intentional output change for the user path (changelog under Changed).

### Prompt-side changes

`formatSkillsForPrompt` in `core/skills.ts` changes its second parameter from `fileReadTool: "read" | "bash" = "read"` to:

```ts
export type SkillInvocationMode = "skill-tool" | "read" | "bash";
export function formatSkillsForPrompt(skills: Skill[], invocation: SkillInvocationMode = "read"): string;
```

Behavior:

- `"skill-tool"`: instruction lines become the tool contract; `<location>` is omitted from each `<skill>` entry (agentskills.io: location can be dropped once the tool result carries the directory; keeping it would invite the model to self-read, the exact failure being fixed).
- `"read"`/`"bash"`: current behavior and text, unchanged (fallback path).

Literal instruction text for `"skill-tool"` mode (full replacement of the current two instruction lines; the "resolve relative paths" line is kept because the tool result still references sibling files):

```
The following skills provide specialized instructions for specific tasks.
When a task matches a skill's description, call the skill tool with the skill's exact name to load its full instructions before proceeding. Do not read the SKILL.md file yourself; the skill tool returns its content.
Do not call the skill tool for a skill whose instructions are already in the conversation.
When loaded instructions reference a relative path, resolve it against the skill directory reported by the skill tool and use that absolute path in tool commands.
```

This is OpenCode's minimal contract plus ZCode-derived anti-skip/anti-dedup clauses; the research dossier notes ZCode's stronger phrasing measurably improves invocation reliability. No "BLOCKING REQUIREMENT" escalation in v1 — pi's catalog is a passive system-prompt section, not a per-turn tool contract, and the stronger form buys reliability at prompt-token cost; revisit after dogfooding.

`core/system-prompt.ts` `buildSystemPrompt` — literal replacement of the selection and both append sites (lines ~46 and ~160-163 currently read):

```ts
const skillFileReadTool = (["read", "bash"] as const).find((tool) => tools.includes(tool));
...
if (skillFileReadTool && skills.length > 0) {
    prompt += formatSkillsForPrompt(skills, skillFileReadTool);
}
```

becomes (identical in both the `customPrompt` branch and the default branch):

```ts
const skillInvocation: SkillInvocationMode | undefined = tools.includes("skill")
    ? "skill-tool"
    : (["read", "bash"] as const).find((tool) => tools.includes(tool));
...
if (skillInvocation && skills.length > 0) {
    prompt += formatSkillsForPrompt(skills, skillInvocation);
}
```

So: tool active → tool contract without `<location>`; no skill tool but read/bash present → today's self-read text with `<location>` (fallback preserved); neither → no skills block (unchanged).

### Tool registration and activation

New file `packages/coding-agent/src/core/tools/skill.ts`:

```ts
export interface SkillToolOptions {
	/** Skills by name, re-read at every invocation so /reload and mid-session edits are reflected. */
	getSkills: () => Skill[];
}
export interface SkillToolDetails {
	skill: string;
}
export function createSkillToolDefinition(options: SkillToolOptions): ToolDefinition<typeof skillSchema, SkillToolDetails>;
```

`execute` logic (sync FS reads are fine here; `core/skills.ts` and `_expandSkillCommand` already use `readFileSync`):

1. `const skills = options.getSkills();` then `const skill = skills.find((s) => s.name === params.name);`
2. Not found → `throw new Error(`Unknown skill "${params.name}". Available skills: ${skills.filter(s => !s.disableModelInvocation).map(s => s.name).join(", ")}.`)`. Thrown errors surface as `isError: true` tool results (pi-agent-core agent loop wraps `execute` rejections), which is the corrective-feedback channel.
3. Found but `disableModelInvocation` → `throw new Error(`Skill "${skill.name}" does not allow model invocation. Do not reconstruct its content from memory or read its file. Continue the task without it; the user can load it with /skill:${skill.name}.`)` — Claude Code's hard-block-with-corrective-feedback pattern. Hide-don't-block still governs the catalog (already implemented); this is defense in depth at the tool, per the dossier's design takeaways.
4. Dedup: if an identical rendered block for this skill is already in the live context, return `[{ type: "text", text: `[Skill "${skill.name}" is already loaded. Its full instructions appear earlier in this conversation; follow them from there. Do not call the skill tool again for this skill.] }]` with `details: { skill: name }`. "Live context" = `ctx.sessionManager.buildContextEntries()` (compaction-aware: entries summarized away are gone, so post-compaction re-invocation correctly re-injects in full). Scan for `role === "toolResult"` entries with `toolName === "skill" && isError === false` whose `details?.skill === name`, take the latest, and string-compare its first text block against the fresh `renderSkillInvocation(skill)` output. Identical → short note; different (file edited mid-session) → full re-injection. Claude Code semantics minus the args/dynamic-content dimension (no args in v1). `ReadonlySessionManager` (session-manager.ts line ~190) exposes both `buildContextEntries` and `getEntries`.
5. Otherwise return the rendered block as `content: [{ type: "text", text: rendered }]`, `details: { skill: skill.name }`.

Registration in `AgentSession._refreshToolRegistry` (`core/agent-session.ts` line ~2694) — the single choke point through which `_buildRuntime`, `reload()`, and `extendResourcesFromExtensions` all flow, so the tool tracks the current skill set:

- After `allCustomTools` is assembled from registered extension tools + `_customTools` (and before the `isAllowedTool` filter would drop it, or simply inside the same array), append the session skill tool when both: (a) an extension/SDK tool named `skill` does not already exist (user overrides win), and (b) `this._resourceLoader.getSkills().skills.some((s) => !s.disableModelInvocation)` is true (agentskills.io: "If no skills are available, don't register the tool at all"). Definition built with `getSkills: () => this._resourceLoader.getSkills().skills`; `sourceInfo: createSyntheticSourceInfo("<builtin:skill>", { source: "builtin" })`. It flows through the existing `isAllowedTool` allow/exclude filtering like every other tool — a `--tools read` session legitimately loses it and the system prompt falls back to self-read mode automatically (the mode keys off the active tool set).
- Activation: the existing auto-add for new registry names is guarded by `else if (!options?.activeToolNames)`, which `_buildRuntime` always sets, so add explicitly just before the final `setActiveToolsByName([...new Set(nextActiveToolNames)])` call:

```ts
if (this._toolRegistry.has("skill") && !previousRegistryNames.has("skill")) {
	nextActiveToolNames.push("skill");
}
```

  `previousRegistryNames` is already computed at the top of the method, so a user who later deactivates the tool via `setActiveToolsByName` is not re-forced on subsequent refreshes. `setActiveToolsByName` rebuilds the system prompt, which switches the catalog to tool mode with no further wiring.

- Export `createSkillToolDefinition` from `core/tools/index.ts` (add to the export block; do NOT add `"skill"` to the `ToolName` union or `createAllToolDefinitions`/`createTool` switch — it is session-managed, not a `--tools`-selectable filesystem tool, and has no `cwd`-based factory shape).

`_expandSkillCommand` (agent-session.ts line ~1362) is refactored to call `renderSkillInvocation` for its body construction (gains the `<skill_files>` block; the `args` append behavior stays).

### Compaction protection for skill content

pi has no per-message protection flag today (tool results are never cut points, but everything before the cut point is summarized and discarded in `packages/coding-agent/src/core/compaction/compaction.ts`). Adding a `protected` field to `ToolResultMessage` would require changes in `packages/ai` (pi-ai) and pi-agent-core; out of proportion for v1. Instead implement the Claude Code re-attach pattern entirely inside coding-agent compaction:

- New pure function in `core/compaction/compaction.ts` (or `compaction/utils.ts` next to `computeFileLists`):

```ts
/** Max characters of a single skill's content re-attached after compaction (~5,000 tokens at chars/4). */
export const SKILL_REATTACH_MAX_CHARS_PER_SKILL = 20_000;
/** Max total characters of re-attached skill content (~25,000 tokens at chars/4, matching Claude Code's budget). */
export const SKILL_REATTACH_MAX_TOTAL_CHARS = 100_000;

/** Extract the most recent skill invocation per skill name from messages that compaction will discard. */
export function extractSkillReattachments(messages: AgentMessage[]): string;
```

- Matching: `role === "toolResult" && toolName === "skill" && !isError` (take the skill name from `details.skill`), plus user messages whose text starts with `<skill name="` (the `/skill:name` expansion) with the name parsed from that attribute. Latest invocation per name wins; ties impossible (append-only).
- Output appended to the summary in `compact()` after `summary += formatFileOperations(...)` (compaction.ts line ~951):

```
## Active Skills

<skill name="pdf-tools" location="...">
(first SKILL_REATTACH_MAX_CHARS_PER_SKILL characters of the rendered block, with a
"[skill content truncated by compaction]" marker when cut)
</skill>
```

  Fill newest-first up to `SKILL_REATTACH_MAX_TOTAL_CHARS`; drop whole older skills that no longer fit (Claude Code semantics). Newest-first plus dedup scanning `buildContextEntries()` means a skill still present in the kept region is not re-attached twice (it will not appear in `messagesToSummarize`).

### Behavior when no skill tool is active

Covered above, restated as contract: the skills catalog and its instruction text must always describe the surface actually registered. `buildSystemPrompt` selects the mode from the active tool list exactly as it keys off `read`/`bash` today, so SDK sessions with custom `baseToolsOverride`, `--tools`-restricted sessions, and extension-disabled sessions all automatically get the self-read fallback (with `<location>`) instead of a dangling "call the skill tool" instruction. This also fixes the existing gap where SDK sessions without `read`/`bash` get no skills at all: with the `skill` tool registered session-side, such sessions now get skills via the tool.

### Out of scope

- Plugin-style namespacing (`plugin:skill` qualified names) and skill marketplaces — pi has single-source skills today with collision diagnostics (first winner, `collision` diagnostics in `loadSkills`); revisit when plugin-vendored skills exist.
- Permission/consent gating at invocation (OpenCode `ask`, Gemini's confirmation prompt) — pi has no per-built-in-tool permission prompt to hook into.
- Argument forwarding (`args` parameter, "ARGUMENTS:" append), dynamic `` !`cmd` `` content execution, subagent preloading, enum-constrained names, catalog budgets/truncation (pi's catalog is currently unbudgeted; that is an independent problem).

## Implementation plan

Ordered; all paths under `packages/coding-agent/` unless noted. Every symbol referenced exists as of writing.

1. `src/core/skills.ts`
   - Add `renderSkillInvocation(skill: Skill): string` — reads `skill.filePath` with `readFileSync`, strips frontmatter with the same `parseFrontmatter`-based helper used today (`stripFrontmatter` lives in `src/utils/frontmatter.ts`; import it), and emits the wrapper block shown in Proposed design (existing `escapeXml` can be reused for the attribute values).
   - Add `listSkillFiles(baseDir: string, cap = 10): string[]` — recursive walk skipping dotfiles and `node_modules` (mirror `loadSkillsFromDirInternal` rules), posix-relative sorted paths, exclude `SKILL.md`, cap at `cap`.
   - Change `formatSkillsForPrompt(skills: Skill[], fileReadTool: "read" | "bash" = "read")` (line ~355) to accept `invocation: SkillInvocationMode = "read"`, add the `"skill-tool"` instruction text from Proposed design, and omit `<location>` lines when `invocation === "skill-tool"`. Export `SkillInvocationMode`.
2. New `src/core/tools/skill.ts` — `createSkillToolDefinition` per Proposed design: TypeBox schema `Type.Object({ name: Type.String(...) })`, execute steps 1-5 (unknown-name error, disable-model-invocation corrective error, dedup via `ctx.sessionManager.buildContextEntries()`, full render). Follow the definition shape of `src/core/tools/read.ts` (`name`, `label`, `description`, `promptSnippet`, `parameters`, `constrainedSampling`, `execute`). No renderers needed — default tool shell rendering is acceptable for v1.
3. `src/core/tools/index.ts` — export `createSkillToolDefinition`, `SkillToolDetails`, `SkillToolOptions` from `"./skill.ts"` in the export block at the top. Do not touch `ToolName`, `allToolNames`, `createTool`, `createAllToolDefinitions`.
4. `src/core/system-prompt.ts` — replace `skillFileReadTool` selection and both `if (skillFileReadTool && ...)` append sites (custom-prompt branch ~line 66, default branch ~line 161) with the `skillInvocation` selection shown in Proposed design; import `SkillInvocationMode`.
5. `src/core/agent-session.ts`
   - `_refreshToolRegistry` (~line 2694): append the session skill tool to `allCustomTools` when no other `skill` tool exists and at least one model-invocable skill is loaded; add the auto-activation `push("skill")` before the final `setActiveToolsByName`.
   - `_expandSkillCommand` (~line 1362): replace the inline `skillBlock` construction with `renderSkillInvocation(skill)` (keep the error emission and the `args` append).
6. `src/core/compaction/compaction.ts` — add `extractSkillReattachments` + budget constants; call it in `compact()` and append the `## Active Skills` section to the summary (after `summary += formatFileOperations(readFiles, modifiedFiles)` at ~line 951). If `src/core/compaction/index.ts` re-exports module members (verify), export the new function for tests.
7. Tests — see Testing plan. Update the existing prompt-format expectations in `test/skills.test.ts` and `test/system-prompt.test.ts` where the new mode changes output (only the new `"skill-tool"` mode is new behavior; default `"read"` output is unchanged, so most existing assertions hold).
8. Docs and changelog — update `docs/skills.md` "How Skills Work" step 3 (agent calls the `skill` tool; fallback text for sessions without it) and note the `/skill:name` file-listing change; add changelog entries below to `packages/coding-agent/CHANGELOG.md` under `## [Unreleased]`.

All snippets above use erasable TypeScript only (no enums, parameter properties, or `import =`).

## Testing plan

Run non-e2e tests with `./scripts/test.sh` from the repo root, or per-file from `packages/coding-agent`:
`node "$(git rev-parse --show-toplevel)/node_modules/vitest/dist/cli.js" --run test/<file>`

Unit tests (vitest):

- `test/skills.test.ts` (extend `describe("formatSkillsForPrompt")`):
  - `"skill-tool"` mode: contains `<available_skills>`, the "call the skill tool" instruction, and does NOT contain `<location>`.
  - `"read"` mode: unchanged output (existing assertions keep passing; `<location>` present).
  - `disableModelInvocation` skills excluded in both modes (existing test, keep).
- New `test/skill-tool.test.ts`:
  - Create fixture skills under a temp dir (pattern: `test/sdk-skills.test.ts` `beforeEach`) with one multi-file skill (`scripts/extract.py`, `reference/tables.md`).
  - `execute` returns the `<skill name=... location=...>` wrapper, frontmatter-stripped body, `References are relative to <baseDir>`, `<skill_files>` with both files, and `details.skill`.
  - Unknown name: rejects; error message contains "Unknown skill" and lists valid names.
  - `disableModelInvocation: true` skill: rejects with the corrective text; `/skill:`-style rendering is not reached.
  - File listing capped at 10 and `SKILL.md` excluded (fixture with 12 files; assert 10 entries, no `SKILL.md`).
  - Dedup: fake `ReadonlySessionManager` (`{ buildContextEntries: () => [...entries], ... }` as the minimal pick) containing a prior `skill` toolResult with identical text → short "already loaded" note; with different text → full re-injection.
- `test/compaction.test.ts` or new `test/compaction-skill-reattach.test.ts`:
  - `extractSkillReattachments` returns empty for no skill content.
  - Tool-injected and user-message-injected (`/^<skill name="/`) skills both captured; latest per name wins.
  - Per-skill truncation marker at `SKILL_REATTACH_MAX_CHARS_PER_SKILL`; total budget fills newest-first and drops older skills.

System-prompt integration:

- `test/system-prompt.test.ts` (extend `describe("skills")`):
  - `"skill" in selectedTools` → tool-mode instruction, no `<location>`.
  - `["read"]` only → self-read text with `<location>` (fallback).
  - Neither `skill` nor `read`/`bash` → no `<available_skills>` (existing "omits skills without read or bash" case, keep).

Agent-level tests via `test/suite/harness.ts` + faux provider (new `test/suite/skill-tool.test.ts`):

- Build a `ResourceLoader` fake from `createTestResourceLoader` (test/utilities.ts) overriding `getSkills` to return fixture skills (shape per `test/sdk-skills.test.ts`). No real provider APIs.
- Invocation loads content: `harness.setResponses([fauxAssistantMessage(fauxToolCall("skill", { name: "test-skill" }), { stopReason: "toolUse" }), fauxAssistantMessage("done")])` (pattern: `test/suite/agent-session-prompt.test.ts`); assert the `toolResult` message (`harness.session.messages[2]`) has `isError === false` and text containing the stripped body.
- Unknown skill error: toolResult `isError === true`, text lists valid names; conversation still completes.
- `disable-model-invocation` rejected: `isError === true`, corrective text, model does not receive the body.
- Dedup: two consecutive `skill` tool calls for the same skill; second toolResult is the short note, not a second copy.
- Prompt listing format: with the skill-bearing loader, `harness.session.agent.state.systemPrompt` contains `<available_skills>` and the tool-mode instruction, and does not contain `<location>`.
- Fallback when tool absent: harness with `allowedToolNames: ["read"]` (skill tool filtered out) → system prompt contains the self-read instruction and `<location>`.

## Changelog

Draft entries for `packages/coding-agent/CHANGELOG.md` under `## [Unreleased]` (append to existing subsections; do not duplicate them):

### Added

- Added a built-in `skill` tool that loads a skill's SKILL.md instructions into the conversation as the tool result. It strips frontmatter, reports the skill's base directory, lists a sample of bundled files, rejects unknown and `disable-model-invocation` skills with corrective errors, skips re-loading skills already in context, and works in sessions without `read`/`bash`. Skill content is re-attached to compaction summaries so instructions survive context compaction.

### Changed

- Skills listed in the system prompt now instruct the model to call the `skill` tool instead of reading SKILL.md with `read`/`bash`; the file path (`<location>`) is omitted from the listing while the tool is active. Sessions without the tool (e.g. restricted tool sets) keep the previous read-it-yourself instructions.
- `/skill:name` expansion now appends a sampled bundled-file listing to the injected skill block.

## Risks and open questions

- Big SKILL.md context cost: the tool loads the full body in one turn. agentskills.io recommends <5,000 tokens per skill; pi has no cap. A pathological 50k-token SKILL.md now enters context verbatim in a single tool result (self-read at least truncated via the read tool's line/byte limits). Mitigation to consider later: a `truncateHead`-style cap on rendered bodies with a continuation marker, or a catalog-side description budget (Claude Code: 1,536 chars; Codex: 2% of context). Not in v1; the truncation hook can reuse `core/tools/truncate.ts`.
- Multi-file skills: the sampled listing (10 entries) may hide important files in large skills, and nothing eagerly loads resources. If this bites, adopt Gemini's approach of adding the skill dir to read-tool allowlists so bundled files read without friction; pi's read tool has no permission allowlist today, so this is a non-trivial follow-up.
- Contract-strength tuning: v1 uses OpenCode-strength instructions plus anti-skip/anti-dedup lines. If invocation reliability is still poor in practice, escalate to ZCode-style "BLOCKING REQUIREMENT" phrasing; measure before adding prompt tokens.
- Enum names: free string + corrective error was chosen for schema-drift and provider-strict-mode reasons (see Proposed design). If hallucinated names turn out to be common, generate `Type.Union` literals at definition-build time (the definition is rebuilt on every `_refreshToolRegistry`, so drift is bounded) behind a provider-capability check.
- Compaction re-attach interplay: re-attached blocks are plain summary text; the dedup scan only sees live context entries, so a post-compaction model re-invocation of the same skill injects a second full copy even though a (possibly truncated) copy sits in the summary. Acceptable in v1 (matches "changed content re-injects" semantics); a smarter check would also grep the summary.
- `args` on model invocation (Claude Code's "ARGUMENTS:" append) is deliberately absent; add only if a real skill needs model-supplied arguments.
- Sessions resume: skill tool results are ordinary session entries, so resumed sessions replay them correctly; `details.skill` is persisted with the entry. Verified against `sessionEntryToContextMessages`, which passes `message` through unchanged.

## Acceptance criteria

- [ ] A `skill` tool (name `skill`, schema `{ name: string }`) is registered and active only when at least one model-invocable skill exists, and is not registered otherwise (agentskills.io empty-tool warning honored).
- [ ] Calling it returns the frontmatter-stripped SKILL.md body wrapped in `<skill name="..." location="...">` with the base-dir reference line and a sampled (max 10, `SKILL.md` excluded, "sampled" caveat) `<skill_files>` listing; `details.skill` records the name.
- [ ] Unknown names fail with an `isError` result that lists the valid skill names.
- [ ] `disable-model-invocation` skills are absent from the catalog (existing behavior) and rejected at the tool with a corrective error that forbids reconstructing the content.
- [ ] Re-invoking an already-loaded identical skill returns a short "already loaded" note instead of a duplicate; changed file content re-injects in full; a skill removed by compaction re-injects in full.
- [ ] With the tool active, the system prompt's `<available_skills>` section uses the tool-invocation instruction and omits `<location>`; with the tool absent but `read`/`bash` present it uses the current self-read instruction with `<location>`; with neither it omits the section. The instruction always matches the registered surface.
- [ ] `/skill:name args` expansion uses the same renderer (gains the file listing) and remains the user-invocation path, including for model-invocation-disabled skills.
- [ ] After compaction, the summary re-attaches the most recent invocation of each skill discarded by the cut, newest-first, within the per-skill and total character budgets.
- [ ] The tool re-resolves skills from the resource loader at each invocation, so mid-session skill edits and `/reload` are reflected without re-registering anything.
- [ ] All new and updated tests pass via `./scripts/test.sh`; `npm run check` is clean.
- [ ] `docs/skills.md` and `packages/coding-agent/CHANGELOG.md` updated per the drafts above.
