# Research: harness-invoked skills (Skill tool that loads SKILL.md into context)

## Summary

Every skills-compatible harness uses the same three-tier progressive disclosure (metadata catalog at session start -> full SKILL.md on activation -> bundled files on demand), but they split into two activation mechanisms: (a) prompt-listed catalog where the model reads the SKILL.md file itself with its read/bash tools (pi today, Codex CLI for file-backed skills, and Anthropic's own documented claude.ai/API example), and (b) a harness-registered dedicated tool (`Skill`/`skill`/`activate_skill`) that returns the skill content as the tool result, so the model never touches the filesystem (Claude Code, OpenCode, Gemini CLI, ZCode). The dedicated-tool camp differs mainly in where the catalog lives (system prompt vs tool description vs a refreshable "system context" fragment), how strongly the prompt contract forces invocation, and what the tool result wraps around the body (base-dir note, sampled file list, permission gate, dedup-on-reinvoke, compaction protection).

## Findings by harness

### Agent Skills spec (agentskills.io)

Source: https://agentskills.io/integrate-skills , https://agentskills.io/specification

The spec's integration guide explicitly blesses both activation patterns and treats the choice as an implementation detail:

- "How does the model access skill content? If the model has file-reading capabilities, it can read `SKILL.md` files directly. Otherwise, you'll provide a dedicated tool or inject skill content into the prompt programmatically."
- Progressive disclosure tiers: tier 1 catalog = "Name + description ... ~50-100 tokens per skill" at session start; tier 2 instructions = "Full `SKILL.md` body ... <5000 tokens (recommended)" on activation; tier 3 resources on demand.
- Catalog placement, both acceptable: "System prompt section: Add the catalog as a labeled section in the system prompt ... Tool description: Embed the catalog in the description of a dedicated skill-activation tool." It notes system-prompt placement "is simpler and more broadly compatible; tool description embedding is cleaner when you have a dedicated activation tool."
- Verbatim behavioral-instruction templates it recommends for each mode:
  - File-read mode: "The following skills provide specialized instructions for specific tasks. / When a task matches a skill's description, use your file-read tool to load the SKILL.md at the listed location before proceeding. / When a skill references relative paths, resolve them against the skill's directory (the parent of SKILL.md) and use absolute paths in tool calls." (pi's current `formatSkillsForPrompt` is clearly derived from this.)
  - Dedicated-tool mode: "The following skills provide specialized instructions for specific tasks. / When a task matches a skill's description, call the activate_skill tool with the skill's name to load its full instructions."
- Dedicated tool advantages listed: "Control what content is returned — e.g., strip YAML frontmatter or preserve it", "Wrap content in structured tags for identification during context management", "List bundled resources ... alongside the instructions", "Enforce permissions or prompt for user consent", "Track activation for analytics."
- Tip: "constrain the `name` parameter to the set of valid skill names (e.g., as an enum in the tool schema). This prevents the model from hallucinating nonexistent skill names. If no skills are available, don't register the tool at all."
- `location` in the catalog is only needed to enable file-read activation or relative-path resolution: "If your dedicated activation tool provides the skill directory path in its result ... you can omit `location` from the catalog."
- Content returned: "Full file" (frontmatter preserved; `compatibility` may be useful) vs "Body only (frontmatter stripped) ... Among existing implementations with dedicated activation tools, most take this approach."
- Structured wrapping recommendation (their example): `<skill_content name="pdf-processing"> ... body ... Skill directory: /home/user/.agents/skills/pdf-processing / Relative paths in this skill are relative to the skill directory. / <skill_resources><file>scripts/extract.py</file>...</skill_resources></skill_content>` — resources enumerated "but ... not eagerly read."
- Permission allowlisting: "allowlist skill directories so the model can read bundled resources without triggering user confirmation prompts."
- Compaction: "exempt skill content from pruning ... Flag skill tool outputs as protected so the pruning algorithm skips them"; dedup: "If the model (or user) attempts to load a skill that's already in context, you can skip the re-injection."
- User-explicit activation: "a slash command or mention syntax (`/skill-name` or `$skill-name`) that the harness intercepts ... the harness handles the lookup and injection, so the model receives skill content without needing to take an activation action itself."
- Filtering / user-only skills: "The skill has opted out of model-driven activation (e.g., via a `disable-model-invocation` flag)" -> "Hide filtered skills entirely from the catalog rather than listing them and blocking at activation time. This prevents the model from wasting turns attempting to load skills it can't use." Note: `disable-model-invocation` is NOT in the spec's frontmatter table (fields are `name`, `description`, `license`, `compatibility`, `metadata`, `allowed-tools` (experimental)); it is a client-side convention the guide mentions as an example.
- Auto-trigger: "Most implementations rely on the model's own judgment as the activation mechanism, rather than implementing harness-side trigger matching or keyword detection."
- Optional advanced pattern: run the skill in a subagent session instead of injecting into the main conversation.

### Claude Code

Sources: https://code.claude.com/docs/en/skills , https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills , https://platform.claude.com/docs/en/agents-and-tools/agent-skills/overview

Claude Code is the reference dedicated-tool implementation:

- Mechanism: a built-in `Skill` tool. "skill descriptions are loaded into context so Claude knows what's available, but full skill content only loads when invoked" — invoked "by user slash command or by Claude via the Skill tool". When invoked, "the rendered `SKILL.md` content enters the conversation as a single message and stays there across later turns."
- Catalog cost control: the listing truncates combined `description` + `when_to_use` "at 1,536 characters in the skill listing to reduce context usage." Authoring guidance: "Keep `SKILL.md` under 500 lines."
- Dynamic content: `` !`cmd` `` / ` ```! ` blocks are executed and their output substituted "before Claude sees the content"; if no argument placeholder receives input, "Claude Code appends `ARGUMENTS: <your input>` to the end of the skill content."
- Re-invocation dedup: identical rendered content -> "adds a short note that the skill is already loaded rather than a second copy of the content"; changed content (new args/dynamic output) appends the full content again.
- Compaction survival: after auto-compaction Claude Code "re-attaches the most recent invocation of each skill after the summary, keeping the first 5,000 tokens of each", with a combined 25,000-token budget filled newest-first; older skills can be dropped.
- `disable-model-invocation: true` — "Set to `true` to prevent Claude from automatically loading this skill." The description is then "not in context"; it also blocks preloading into subagents and scheduled-task firing. If Claude tries anyway, "Claude Code blocks the call and instructs it not to reproduce the deploy steps another way" — i.e., a hard harness-side block with corrective feedback, not a silent failure.
- `user-invocable: false` — inverse flag: only Claude can invoke it; hidden from the `/` menu. Lifecycle: default = "Description always in context, full skill loads when invoked"; model-invocation disabled = "Description not in context, full skill loads when you invoke."
- Permissions surface: "`Skill(name)` for exact match, `Skill(name *)` for prefix match with any arguments"; denying bare `Skill` disables all skills; some built-in commands (/init, /security-review) are reachable through the Skill tool.
- `allowed-tools` frontmatter: "Tools Claude can use without asking permission during the turn that invokes this skill. The grant clears when you send your next message." `disallowed-tools`: tools removed from the pool while the skill is active.
- Subagent preloading variant: for subagents with preloaded skills, "the full skill content is injected at startup" (harness-side auto-inject, no tool call).
- Namespacing: slash names derive from directory (`/deploy-staging`), nested path (`/apps/web:deploy`), or plugin namespace (`/plugin:skill`); slash stacking expands "the first skill plus up to five more stacked after it."
- Enterprise: skills in a managed settings dir load for all deployed users; collision precedence "Enterprise over personal, and personal over project"; `skillOverrides` states `on`/`name-only`/`user-invocable-only`/`off`; `disableSkillShellExecution` neutralizes injected shell commands by policy.
- Contrast — claude.ai/API surfaces (platform.claude.com overview): no user-visible Skill tool is documented there; skills fire by description matching and the documented loading step is "Claude reads SKILL.md from the filesystem using bash" (the engineering blog's worked example shows "Claude triggers the PDF skill by invoking a Bash tool to read the contents"). So even within Anthropic, the API/container surface uses the self-read model while Claude Code uses the tool model.

### OpenCode

Sources: https://opencode.ai/docs/skills/ (v1), https://opencode.ai/v2/docs/skills/ (v2), and current source at https://github.com/anomalyco/opencode (files `packages/core/src/tool/skill.ts`, `packages/core/src/skill/guidance.ts`; verified 2026-09).

- Mechanism: a dedicated `skill` tool. Docs: "Skills are loaded on-demand via the native skill tool—agents see available skills and can load the full content when needed." v1 docs stated the catalog lives in the skill tool's description; current code instead renders it as a system-context fragment (see below), matching v2 docs: "The agent can then load its instructions with the `skill` tool instead of adding every skill to every prompt." "The model loads a skill by calling the `skill` tool with its exact ID."
- Tool definition (source, verbatim): name `skill`; input schema is a single plain string — `name: "The name of the skill from the available skills list"` — no enum; unknown names fail at execute time ("Unable to load skill X"). Description text (verbatim): "Load a specialized skill when the task at hand matches one of the available skills in the system context." / "Use this tool to inject the skill's instructions and resources into the current conversation. The output may contain detailed workflow guidance as well as references to scripts, files, etc. in the same directory as the skill." / "The skill name must match one of the available skills in the system context."
- Catalog (guidance.ts, verbatim render): "Skills provide specialized instructions and workflows for specific tasks." / "Use the skill tool to load a skill when a task matches its description." followed by `<available_skills>` XML with per-skill `<name>` + `<description>` (no location). It is a keyed, refreshable system-context fragment: on change it emits "The available skills have changed. This list supersedes the previous available skills list." + re-render; on removal: "Skill guidance is no longer available. Do not use any previously listed skill."
- Tool result (toModelOutput, verbatim structure): `<skill_content name="${name}">` / `# Skill: ${name}` / body ("Adds the Markdown body, without frontmatter, to the conversation" per v2 docs) / `Base directory for this skill: ${directory}` / "Relative paths in this skill (e.g., scripts/, reference/) are relative to this base directory." / "Note: file list is sampled." / `<skill_files><file>...</file>...</skill_files>` — the file list is a glob of the skill dir (dot files included, SKILL.md excluded), sorted, capped at 10 entries. Supporting-file contents are NOT loaded ("Supporting file contents are not loaded automatically").
- Permission gate at invocation: `permission.assert` with action `skill` and the skill name as resource, with a save/always-allow option; config effects: `allow` = "Skill loads immediately", `ask` = "User prompted for approval before loading", `deny` = "hidden from agent, access rejected". Per-agent overrides supported; `tools: skill: false` per agent and "When disabled, the <available_skills> section is omitted entirely."
- Model-invocation opt-out: `metadata.opencode/autoinvoke: false` — "only hides the skill from the model's available list. It remains registered and can still be loaded explicitly by ID" (i.e., by the user).
- IDs come from the file path (case-sensitive), not the frontmatter name; v2 does not enforce the spec's naming rules. Names must be unique across locations.

### Gemini CLI

Source: https://geminicli.com/docs/cli/skills/

- Mechanism: dedicated `activate_skill` tool. "When Gemini identifies a task matching a skill's description, it calls the activate_skill tool."
- Surfacing: at session start Gemini CLI "injects the name and description of all enabled skills into the system prompt"; "Only skill metadata (name and description) is loaded initially."
- What activation delivers: "The SKILL.md body and folder structure is added to the conversation history" and "The skill's directory is added to the agent's allowed file paths" (bundled assets readable without extra permission prompts) — i.e., the tool result also widens file-access scope.
- Consent UX: activation triggers "a confirmation prompt in the UI detailing the skill's name, purpose, and the directory path" before loading (equivalent to OpenCode's `ask` permission).
- Discovery tiers (lowest -> highest precedence): built-in, extension-bundled, user (`~/.gemini/skills/` or `~/.agents/skills/`), workspace (`.gemini/skills/` or `.agents/skills/`); higher tier wins on collision; within a tier `.agents/skills/` wins.
- User invocation: none — `/skills list|link|enable|disable|reload` are management commands only; activation is always model-driven. No `disable-model-invocation`-style frontmatter documented.

### Codex CLI (OpenAI)

Sources: https://learn.chatgpt.com/docs/build-skills , https://simonwillison.net/2025/Dec/12/openai-skills/ , source at https://github.com/openai/codex (`codex-rs/ext/skills/src/render.rs`, `catalog_prompt.rs`, `fragments.rs`; verified 2026-09).

Codex is a hybrid: prompt-listed self-read for filesystem skills, dedicated tools for package-backed skills.

- Catalog: a developer-role fragment titled `## Skills` + `### Available skills`, one bullet per skill: `- {name}: {description} ({locator_kind}: {locator})` e.g. `(file: /home/user/.agents/skills/x/SKILL.md)`; with host aliases enabled, paths are shortened and a `### Skill roots` alias table is included. Scope ordering: System, Admin, Repo, User, then name.
- Budget (render.rs constants): metadata budget = 2% of the context window in tokens, or 8,000 characters when the window is unknown; configurable max 10,000 tokens. Under pressure descriptions are shortened first, then skills omitted entirely, with warnings rendered to the model: "Skill descriptions were shortened to fit the skills context budget. Codex can still see every skill, but some descriptions are shorter. Disable unused skills or plugins to leave more room for the rest." and "Exceeded skills context budget. All skill descriptions were removed and N additional skills were not included in the model-visible skills list."
- Behavioral contract for the self-read path (catalog_prompt.rs, verbatim excerpts): "Trigger rules: If the user names a skill (with `$SkillName` or plain text) OR the task clearly matches a skill's description shown above, you must use that skill for that turn. Multiple mentions mean use them all. Do not carry skills across turns unless re-mentioned." / "How to use a skill (progressive disclosure): 1) After deciding to use a skill, the main agent must read its `SKILL.md` completely before taking task actions. For a `file` entry, open the listed path." / "... 3) ... The main agent must read each required instruction or reference file itself before acting on it. Do not delegate reading, summarizing, or interpreting skill instructions to a subagent." / "Announce which skill(s) you're using and why (one short line). If you skip an obvious skill, say why." / "Context hygiene: Progressive disclosure applies to selecting relevant files, not partially reading a selected instruction file."
- Package-backed skills: a `skills.read` tool ("pass the listed locator directly to `skills.read` as `package`"; other files via the same package + their `skill://` resource id) and `skills.list` — the dedicated-tool pattern, used only where there is no filesystem.
- User invocation: "run /skills or type $ to mention a skill" (e.g. `$skill-creator linear`). A `$`-mention expands to a user-role fragment wrapping the content: `<skill><name>...</name><path>...</path>{resource_access?}{contents}</skill>` (fragments.rs) — harness-side injection, same as pi's `/skill:name` expansion.
- Opt-out flags: `agents/openai.yaml` per-skill `allow_implicit_invocation` (default true; false blocks model triggering, "explicit $skill invocation still works"); `[[skills.config]]` with `enabled = false` in config.toml. Initial list also "includes each skill's file path" and the docs state "When Codex selects a skill, it still reads the full SKILL.md instructions for that skill."

### ZCode (firsthand)

- Mechanism: a `Skill` tool with parameters `{skill: string, args?: string}` — `skill` is the exact name with no leading slash; plugin skills use the namespaced form `plugin:skill` and are "also loadable as" their bare short name. The harness injects the SKILL.md content (plus referenced paths) into context as the tool result — the model never reads the file itself.
- Prompt contract is deliberately strong (this session's own tool contract, verbatim): "When a skill matches the user's request, this is a BLOCKING REQUIREMENT: invoke the relevant Skill tool BEFORE generating any other response about the task"; "NEVER mention a skill without actually calling this tool"; "Do not invoke a skill that is already running."
- Catalog: a system-reminder listing available skills with their file paths, grouped into user-level (`~/.agents/skills/*`) and plugin-namespaced entries (e.g. `browser-use:control-browser`, `document-skills:pptx`), each line formatted `- name (file: /abs/path/SKILL.md)` with plugin entries additionally `(also loadable as short-name)`.
- User invocation: typing `/<skill-name>` invokes directly.

### pi (current baseline, for reference)

Source: local files `packages/coding-agent/src/core/skills.ts`, `packages/coding-agent/src/core/system-prompt.ts`, `packages/coding-agent/src/core/agent-session.ts` (read during this research).

- Model-invoked path: `formatSkillsForPrompt` renders `<available_skills>` with `<name>/<description>/<location>` per skill plus "Use the read tool to load a skill's file when the task matches its description" (or a bash variant), and system-prompt.ts only appends this when a read-capable tool (`read` or `bash`) is present in the session's tool list. So skills are entirely self-read today.
- User-invoked path: `/skill:name args` is expanded by the harness (`_expandSkillCommand`) into `<skill name="..." location="...">\nReferences are relative to {baseDir}.\n\n{body, frontmatter stripped}\n</skill>` plus trailing args — pi already has harness-side injection for user invocation; the missing piece is the model-facing tool.
- `disable-model-invocation: true` skills are excluded from the prompt catalog (hidden) and remain reachable only via `/skill:name`. Collisions produce `collision` diagnostics with a deterministic first-winner.

## Design space analysis

Three mechanisms, plus where each fails:

1. Prompt-listed catalog + model self-read (pi, Codex file-backed, Anthropic's documented API example).
   - Failure modes: the model skips the read (Codex spends most of its contract text fighting this: "must read its SKILL.md completely before taking task actions", "Do not delegate reading... to a subagent"); wrong-path reads (relative vs absolute paths — hence pi's resolve-against-skill-dir instruction and Codex's alias-expansion step); one wasted turn per skill; file content read is the raw file, so frontmatter noise enters context; an ordinary read tool result gets no special compaction protection and no permission gate keyed to the skill; the listing depends on a read-capable tool existing (pi gates the entire skills block on read/bash availability, so SDK sessions without file tools get no skills at all).
   - Strengths: zero new tool surface; works with any model/toolset; the model can legitimately skim a long file in pages.
2. Harness-invoked Skill tool (Claude Code, OpenCode, Gemini CLI, ZCode).
   - Single turn, deterministic payload (frontmatter stripped or kept by policy), canonical wrapping with base-dir + resource listing, permission hook at load time, dedup on re-invoke, compaction protection possible because the harness can recognize its own tool results; removes the read-tool dependency entirely.
   - Failure modes: name hallucination (mitigate with enum-constrained parameter per the spec's tip, or a good error message — OpenCode does the latter); catalog/tool drift if the listing is refreshed but the tool is not (OpenCode's "skills changed / no longer available" update fragments address this); per-provider tool-schema overhead; the tool must not be registered when no skills exist (spec explicitly warns an empty-skill tool "would confuse the model").
   - Contract strength varies: OpenCode uses one neutral line ("Use the skill tool to load a skill when a task matches its description"); ZCode escalates to a blocking requirement with anti-patterns ("NEVER mention a skill without actually calling this tool"); Claude Code relies on description matching plus a hard harness-side block when a disabled skill is called. Stronger contract language trades prompt-token cost for invocation reliability.
3. Harness-side auto-inject (no model decision): Claude Code's subagent preloading ("the full skill content is injected at startup") and its post-compaction re-attach; OpenCode's system-context update fragments; pi's `/skill:name` expansion for user invocation. The spec notes most implementations deliberately avoid harness-side trigger matching for model-driven activation; auto-inject is reserved for user-explicit invocation and lifecycle repair.
- `disable-model-invocation` / user-only skills: consensus is hide-don't-block — spec: "Hide filtered skills entirely from the catalog rather than listing them and blocking at activation time"; pi, Claude Code, Codex (`allow_implicit_invocation: false`), OpenCode (`autoinvoke: false`, "remains registered and can still be loaded explicitly by ID") all follow this. Claude Code additionally blocks the call if the model tries anyway and tells it not to reconstruct the content from memory.
- Catalog placement: system prompt section (pi, Gemini, Claude Code, ZCode's system-reminder, Codex's developer fragment) vs tool description (OpenCode v1 docs) vs refreshable system-context fragment (OpenCode v2). The spec considers both main options valid; the refreshable-fragment approach additionally solves stale listings mid-session.

## Gaps and pitfalls

- Context bloat: catalogs need budgets — Claude Code truncates description+when_to_use at 1,536 chars per skill in the listing; Codex budgets the whole catalog at 2% of context / 8k chars with truncate-then-omit degradation and explanatory warnings. A skill-heavy setup can otherwise consume a large fraction of the system prompt (an academic measurement of OpenCode's `<available_skills>` block found ~26% of the system prompt in skill-heavy configurations; (unverified, arXiv 2609.01222)).
- Big SKILL.md bodies: spec recommends <5k tokens / <500 lines; Claude Code's compaction re-attach keeps only the first 5,000 tokens per skill within a 25,000-token budget — a harness Skill tool should decide up front what compaction does to its tool results.
- Multi-file skills: OpenCode returns a sampled file listing capped at 10 entries with an explicit "file list is sampled" caveat; Gemini adds the skill directory to allowed file paths; the spec recommends allowlisting skill dirs in permission systems so bundled resources don't trigger prompts. None of the surveyed tools eagerly loads resources.
- Name collisions and namespacing: Claude Code resolves enterprise > personal > project and namespaces plugin skills as `/plugin:skill`; ZCode uses `plugin:skill` with bare alias; Codex keeps both duplicates visible in selectors; pi produces collision diagnostics with first-winner. A `plugin:skill`-style qualified name plus short alias is the proven pattern once skills arrive from multiple sources.
- Re-invocation: identical content should yield a short "already loaded" note (Claude Code) rather than a duplicate copy; changed args/dynamic content should re-inject.
- Frontmatter: strip it (OpenCode, most implementations per the spec) or keep it (full-file mode, where `compatibility` may matter). pi's existing `/skill:` expansion already strips frontmatter — keep the two paths consistent.
- Staleness: skills edited mid-session are invisible to a session-start catalog; OpenCode re-renders with "This list supersedes the previous available skills list", and pi has a `/reload` command that could be hooked to the same behavior.
- Tool-absent sessions: pi's current listing requires `read` or `bash` in the tool list; a Skill tool removes that coupling (relevant for restricted SDK sessions).

## Design takeaways for pi

- Add a `skill` tool (schema roughly `{ name: string }` or ZCode's `{ skill: string, args?: string }`) registered only when at least one model-invocable skill exists and skills are enabled; mirror OpenCode's minimal contract text and ZCode's stricter guarantees ("blocking requirement" phrasing measurably improves invocation reliability per ZCode's firsthand experience). Do not register it when no skills are available (spec warning).
- Tool result format: reuse pi's existing `<skill name="..." location="...">` wrapper from `_expandSkillCommand` so model-invoked and user-invoked injections are indistinguishable downstream; keep the "References are relative to {baseDir}" line, strip frontmatter, and consider appending a capped, sampled `<skill_files>` listing (OpenCode caps at 10) so multi-file skills are discoverable without eager reads.
- Rewrite `formatSkillsForPrompt`: keep the `<available_skills>` catalog but swap the "read the file yourself" instruction for the tool form ("call the skill tool with the skill's name"). Decide whether `<location>` stays (harmless, and still needed if the read-it-yourself path is kept as a fallback); per the spec, location can be dropped once the tool result carries the skill directory.
- Keep the self-read path only as a fallback for sessions where the skill tool is not registered (e.g., SDK consumers with custom tool sets) — the instruction text must match whichever surface is actually registered, exactly as system-prompt.ts already keys skills off read/bash availability today.
- Enforce `disable-model-invocation` at the tool, not just the prompt: hide from catalog (already done) and have the tool return a corrective error (Claude Code pattern: block the call and instruct the model not to reconstruct the content) while `/skill:name` expansion continues to work for users.
- Add lifecycle behaviors the self-read path cannot support: dedup re-invocations with an "already loaded" note, mark skill tool results as protected during compaction, and re-resolve content at invocation time (pi's resource loader caches Skill records; OpenCode re-lists at execute time) so mid-session edits and `/reload` are reflected.
- Unknown-name errors should list valid names (OpenCode's ToolFailure gives no such list; the spec instead suggests an enum-constrained parameter — check whether pi's tool-definition layer supports enums cheaply).
- Namespacing: pi already tracks source (user/project/path) via SourceInfo; if plugin-vendored skills arrive, adopt the `plugin:skill` qualified-name-plus-alias convention (ZCode, Claude Code) rather than inventing a new scheme, and keep collision diagnostics.

## Sources

- https://agentskills.io/integrate-skills
- https://agentskills.io/specification
- https://code.claude.com/docs/en/skills
- https://platform.claude.com/docs/en/agents-and-tools/agent-skills/overview
- https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills
- https://opencode.ai/docs/skills/
- https://opencode.ai/v2/docs/skills/
- https://github.com/anomalyco/opencode — packages/core/src/tool/skill.ts, packages/core/src/skill/guidance.ts (dev branch, verified 2026-09)
- https://geminicli.com/docs/cli/skills/
- https://learn.chatgpt.com/docs/build-skills
- https://simonwillison.net/2025/Dec/12/openai-skills/
- https://github.com/openai/codex — codex-rs/ext/skills/src/render.rs, catalog_prompt.rs, fragments.rs (main branch, verified 2026-09)
- https://arxiv.org/html/2609.01222v2 (OpenCode `<available_skills>` context-share measurement; (unverified))
- Local: /Users/tmpjolley/Documents/projects/random/opensource/yupi/packages/coding-agent/src/core/skills.ts, .../core/system-prompt.ts, .../core/agent-session.ts
