# Feature 09: System-Prompt Communication Contract

Add a small, composable "Communication and turn rules" block to pi's default system prompt, built in `buildSystemPrompt` (`packages/coding-agent/src/core/system-prompt.ts`). The block encodes only cross-harness consensus rules — outcome-first final messages, keep-going-until-done, retry-on-failure, assessment-before-fix, honest verification reporting, no filler — as a single exported constant so SDK users composing custom prompts can include it explicitly. The block lives only in the default prompt path: `customPrompt` (from `SYSTEM.md` or `--system-prompt`) fully replaces the default prompt exactly as before, and a new settings key (`enableCommunicationContract`, default `true`) lets users strip the block from the default prompt without abandoning the rest of it. Total prompt growth is ~170 tokens on a ~400-token default prompt.

## Metadata

- Priority: high (cheap win — one string constant, one option, one settings key, tests)
- Effort: S
- Risk: low
- Depends on: none
- Research: feature-tasks/research/09-prompt-communication-contract.md

## Problem

pi's default prompt currently carries exactly two always-on communication guidelines (`system-prompt.ts`, appended after any tool-conditioned and user-supplied guidelines):

```
- Be concise in your responses
- Show file paths clearly when working with files
```

Nothing in the prompt constrains turn structure: when to stop, what the last message must contain, what to do on errors, or whether a question deserves an answer or an edit. Four recurring failure modes (illustrative traces; wording synthesized from typical model behavior, not captured logs — pi has no telemetry of prompt-rule compliance):

1. Buried outcome. User asks "does the login flow reject expired tokens?" The model emits interim text while reading files ("checking auth.ts..."), states the answer in passing mid-turn, and ends the turn with "Anything else?". pi's TUI does render interim text (verified: `interactive-mode.ts` creates an `AssistantMessageComponent` for every assistant `message_start` event and streams it into the chat container, ~lines 3245-3259), so the information is not lost — but the turn ends without a final message that stands alone, and the user has to scroll back to find the answer. A rule that the final message leads with the outcome fixes the ordering, not a fake "interim text is hidden" claim.
2. Stop-and-ask mid-task. User asks to rename a symbol across five files. After editing two, the model ends the turn: "I've updated the imports in `a.ts` and `b.ts`. Shall I continue with the tests?" The task is incomplete; the user must reply "yes" to buy the next half. No pi rule says "keep going until done or blocked".
3. Future-work promise. The model edits code, then ends with "Next I'll run the test suite to verify" — and the turn ends without running anything. The promise substitutes for the work.
4. Unrequested fix. User says "sometimes the CLI hangs on Windows" while thinking out loud. The model immediately edits `bash-executor.ts`. No pi rule distinguishes "describe problem" (deliverable: assessment) from "fix problem" (deliverable: change).

Each failure costs a full user round-trip or misdirected edits. Every surveyed harness (see Prior art) ships rules for exactly these cases; pi ships none.

## Prior art

Verbatim quotes and URLs from the research dossier (fetched 2026-09-14). Dossier caveat: no public controlled ablation of any single clause exists; the strongest effectiveness signal is Gemini CLI's own source comment gating edits to its "Context Efficiency" section on SWEBench runs.

### Claude Code (Anthropic)

Leak capture (2026-01-15): https://gist.github.com/chigkim/1f37bb2be98d97c952fd79cbb3efb1c6 (mirrors: https://github.com/x1xhlol/system-prompts-and-models-of-ai-tools , https://github.com/Piebald-AI/claude-code-system-prompts )

> - Your output will be displayed on a command line interface. Your responses should be short and concise. [...]
> - Output text to communicate with the user; all text you output outside of tool use is displayed to the user. [...]
> - Do not use a colon before tool calls. Your tool calls may not be shown directly in the output, so text like "Let me read the file:" followed by a read tool call should just be "Let me read the file." with a period.

Notably absent: a "keep going until done" stop rule and an assessment-vs-fix rule (dossier finding).

### OpenAI Codex CLI

Per-model prompt files: https://github.com/openai/codex/blob/main/codex-rs/core/gpt_5_1_prompt.md and .../gpt_5_codex_prompt.md

Stop rule (gpt_5_1):

> You are a coding agent. You must keep going until the query or task is completely resolved, before ending your turn and yielding back to the user. Persist until the task is fully handled end-to-end within the current turn whenever feasible and persevere even when function calls fail. [...] Do NOT guess or make up an answer.

Assessment-vs-fix (gpt_5_1):

> Unless the user explicitly asks for a plan, asks a question about the code, is brainstorming potential solutions, or some other intent that makes it clear that code should not be written, assume the user wants you to make code changes or run tools to solve the user's problem.

Final-message ordering (gpt_5_codex):

> - Lead with a quick explanation of the change, and then give more details on the context covering where and why a change was made.

### Gemini CLI (Google)

Open-source prompt composition: https://github.com/google-gemini/gemini-cli/blob/main/packages/core/src/prompts/snippets.ts

Directives vs Inquiries (the most explicit assessment-vs-fix rule found):

> Distinguish between **Directives** (unambiguous requests for action or implementation) and **Inquiries** (requests for analysis, advice, or observations, e.g., "Can you tell me how to"). [...] For Inquiries [...] your scope is strictly limited to research and analysis; you may propose a solution or strategy, but you MUST NOT modify files until a subsequent Directive is issued.

Anti-filler:

> - **No Chitchat:** Avoid conversational filler, preambles ("Okay, I will now..."), or postambles ("I have finished the changes...")

Vendor evidence that this text is perf-sensitive (source comment above the Context Efficiency section):

> ⚠️ IMPORTANT: the Context Efficiency changes strike a delicate balance [...] You must run the major benchmarks, such as SWEBench, prior to committing any changes to the Context Efficiency section to avoid regressing this behavior.

### OpenCode (SST)

https://github.com/sst/opencode/blob/main/packages/opencode/src/session/prompt/default.txt

Proactiveness balance (assessment-vs-fix):

> For example, if the user asks you how to approach something, you should do your best to answer their question first, and not immediately jump into taking actions.

Quantified brevity (the family pi should avoid, per dossier):

> You MUST answer concisely with fewer than 4 lines (not including tool use or code generation), unless user asks for detail. [...] One word answers are best.

### Cursor CLI

Leak capture (2025-08-07): https://gist.github.com/gregce/9b45c563affa191caa748f699eeb9d95

Stop rule and status-update contract:

> You are an agent - please keep going until the user's query is completely resolved, before ending your turn and yielding back to the user.
> - Critical execution rule: If you say you're about to do something, actually do it in the same turn (run the tool call right after).
> - Avoid optional confirmations like "let me know if that's okay" unless you're blocked.

### Zed

Open-source template: https://github.com/zed-industries/zed/blob/main/crates/agent/src/templates/system_prompt.hbs

Interim narration (matches pi's rendering reality) and verification honesty:

> - Before a group of related tool calls, send a brief one- to two-sentence preamble explaining what you're about to do, so the user can follow along. Skip the preamble for trivial single reads or when continuing a clearly described step.
> - Do not claim validation passed unless you actually ran it and saw it pass.

Final message:

> - When you finish a coding task, briefly summarize what changed, reference the relevant files, and state what validation you ran (or why you did not run any).

### Amp (Sourcegraph)

Leak collection: https://github.com/asgeirtj/system_prompts_leaks/blob/main/Misc/amp-code.md

Retry discipline (most precise phrasing found) and anti-openers:

> If an approach fails, diagnose why before switching tactics - read the error, check your assumptions, try a focused fix. Don't retry the identical action blindly, but don't abandon a viable approach after a single failure either.
> Do not begin responses with conversational interjections or meta commentary. Avoid openers such as acknowledgements ("Done --", "Got it", "Great question, ") or framing phrases.

### Taxonomy (12 rule families across harnesses; dossier section "Contract taxonomy")

1. Final-message/visibility rules (everything needed in the last text message) — ZCode firsthand, Amp channels, Cursor, Gemini, Claude Code (weaker).
2. Outcome-first ordering — ZCode, Codex, Amp, Zed.
3. Readability vs brevity — two camps: quantified caps (Gemini, OpenCode, Codex tiers) vs match-detail-to-task (Zed, ZCode, Amp, Claude Code).
4. Stopping/continuing rules — Codex, Cursor, Zed near-identical "keep going until... before ending your turn".
5. Autonomy vs confirmation — proceed on reversible in-scope actions; ask only for destructive/scope-expanding ones.
6. Assessment-vs-fix mode — Gemini (most explicit), Codex, Amp, OpenCode, ZCode; absent from Claude Code and Cursor.
7. Verification discipline — Zed ("Do not claim validation passed unless you actually ran it"), Amp, OpenCode, Codex.
8. Question budget — narrow, rare, high-threshold questions (Amp, Zed, Codex, Gemini, Cursor).
9. Retry/self-recovery — ZCode, Codex ("persevere even when function calls fail"), Amp.
10. Anti-filler/anti-openers — Amp, Gemini, OpenCode, Codex, Claude Code, Zed.
11. Progress narration — split camp: pro (Zed, Codex, Cursor, Claude Code) vs anti (Gemini current, OpenCode, Amp).
12. Todo/plan-tool discipline — Claude Code, Codex, Gemini (pi ships no such tool; out of scope).

## Proposed design

### Exact contract text

One block, added verbatim below the `Guidelines:` section of the default prompt. ~200 words, ~170 tokens — inside the dossier's ~250-token budget:

```
Communication and turn rules:
- All text you write is shown to the user, including text between tool calls. Brief one-line notes about what you are doing next are useful; end them with a period, not a colon.
- End every turn with a final message that stands alone. Lead with the outcome - what changed, what you found, or the answer - then add only the detail the user needs.
- Keep going until the task is complete or you are blocked on something only the user can provide. Do not end the turn by asking whether to continue or by promising work you have not done; do the work now, or state what blocked you.
- When a command or edit fails, read the error, fix the cause, and try again before giving up.
- When the user describes a problem or asks a question, the deliverable is your assessment; do not edit files until they ask for a fix.
- Report verification honestly: say what you ran and what you did not run. Never claim untested code works.
- No filler: skip acknowledgements, apologies, and restatements of the request.
```

Rule-to-family mapping (consensus-only, per dossier takeaways): bullet 1 = family 11 (pro-narration camp, calibrated with Zed's "skip for trivial steps" and Claude Code's colon rule, no "always narrate" mandate); bullets 2-3 = families 1+2+4; bullet 4 = family 9 (Codex/Amp phrasing); bullet 5 = family 6; bullet 6 = family 7 (Zed's honesty wording); bullet 7 = family 10. Deliberately excluded: quantified brevity (family 3, quantified camp — most-copied and most-criticized), autonomy/question budgets (families 5+8 — pi's default interaction already surfaces mid-turn steering, and dossier evidence is weakest here), todo/plan discipline (family 12 — pi ships no such tool), file-reference formats (pi already has the "Show file paths clearly" guideline; one rule lives in exactly one place).

### Visibility rule wording (grounded in pi's TUI)

Verified in `packages/coding-agent/src/modes/interactive/interactive-mode.ts`: the `message_start` event handler for `role === "assistant"` (~lines 3245-3259) creates an `AssistantMessageComponent`, adds it to `chatContainer`, and streams content via `updateContent(message, true)` on every `message_update`. Every assistant text block — including text emitted between tool calls — is rendered. Therefore the block's first bullet states the opposite of ZCode's rule: interim text IS shown, short notes are welcome, and the requirement on the final message is ordering/self-containment (bullet 2), not "the user can only see the last message". A "final message only" visibility rule would be factually wrong for pi.

### Placement in buildSystemPrompt

In `system-prompt.ts`, the default-path template literal currently reads (abridged): `...Guidelines:\n${guidelines}\n\nPi documentation (...)`. Insert the block between them so the rendered prompt is:

```
Guidelines:
- ...existing bullets...

Communication and turn rules:
- ...

Pi documentation (read only when the user asks about pi itself, ...):
```

Rationale: the `Guidelines:` list is a merge surface (tool-conditioned bullets + user `promptGuidelines` + the two always-on bullets); the contract is harness-owned prose and must not participate in that merge, so it gets its own section directly after it. The Pi-documentation tail stays last. `appendSystemPrompt`, `<project_context>`, skills, and the cwd line keep their existing positions after everything.

### customPrompt interaction (recommendation)

Include the contract only in the default path. Do not append it when `customPrompt` is set (the early-return branch at `system-prompt.ts:48-73` stays byte-identical).

Justification: (a) `customPrompt` semantics are full replacement (sourced from `.pi/SYSTEM.md` / `~/.pi/agent/SYSTEM.md` via `ResourceLoader.discoverSystemPromptFile`, `resource-loader.ts:1029`, or `--system-prompt`); every surveyed harness treats a user-supplied full replacement as replacing the contract too (Gemini `GEMINI_SYSTEM_MD`, OpenCode per-model files, Codex experimental instructions — dossier gap #3). (b) Force-appending after a custom prompt produces duplicate or contradicting instructions (e.g., a user prompt demanding verbose output vs the contract's "only the detail the user needs"). (c) Custom-prompt authors keep two additive hooks: `APPEND_SYSTEM.md` (`appendSystemPrompt`, appended last — de-facto override by position, as in every surveyed harness) and the newly exported constant for composition.

### SDK export

Export the block as a string constant from `system-prompt.ts`:

```ts
export const COMMUNICATION_CONTRACT = `Communication and turn rules:
...`;
```

and re-export it from the package root (`src/index.ts`, new line: `export { COMMUNICATION_CONTRACT } from "./core/system-prompt.ts";`). Note: `BuildSystemPromptOptions` already reaches the public SDK surface through the extension re-export chain (`src/core/extensions/index.ts:42` -> `src/index.ts:67`), so the new option field below is automatically part of the SDK type; extensions can also read the live options object via `context.getSystemPromptOptions()` (`extensions/runner.ts:811`).

### Config escape hatch

- `BuildSystemPromptOptions.includeCommunicationContract?: boolean` — default `true`; `false` omits the block from the default path. No effect on the `customPrompt` branch (nothing to omit there).
- Settings key `enableCommunicationContract?: boolean` (default `true`) in the `Settings` interface (`settings-manager.ts:106` block, flat optional-key style with a `// default:` comment), exposed via `getEnableCommunicationContract(): boolean` following the existing getter pattern (e.g. `getShowTerminalProgress()`, `settings-manager.ts:1235`). Wired in `AgentSession._rebuildSystemPrompt` (`agent-session.ts:1061`) into `_baseSystemPromptOptions`. This lets a user keep the default prompt's tools/docs/guidelines but drop the contract, which `SYSTEM.md` (full replacement) cannot express.
- Document in `docs/settings.md` (one row) and `docs/usage.md` near the existing `SYSTEM.md`/`APPEND_SYSTEM.md` documentation (~lines 115-121).

### Out of scope

- Turn-scoped reminder injections (`<system-reminder>` pattern) — reinforcement for long-session decay; add later without touching the base block.
- Model-specific contract variants (OpenAI/OpenCode maintain per-model files; pi is model-agnostic and ships one model-neutral wording).
- Headless/non-interactive variant (Gemini's "never ask" wording) — revisit if pi grows a non-interactive mode; would go behind the same option.
- Per-tool discipline rules (todo/plan tool) — belong in tool descriptions when those tools exist.
- Changing the two existing guidelines or the `promptGuidelines` merge behavior.
- The vendored copy under `packages/coding-agent/vendor/pi-subagents/` references its own prompt building and is not touched.

## Implementation plan

All code under erasable-TypeScript constraints (plain constants, explicit fields, no enums/namespaces/parameter properties).

1. `packages/coding-agent/src/core/system-prompt.ts`
   - Add `export const COMMUNICATION_CONTRACT` holding the exact block text from "Proposed design" (header line plus seven bullets, no leading/trailing blank lines).
   - Add to `BuildSystemPromptOptions` (interface at lines 8-25): `includeCommunicationContract?: boolean;` with doc comment `/** Include the communication and turn-rules block in the default prompt. Default: true. Ignored when customPrompt is set. */`
   - Destructure it in `buildSystemPrompt` alongside the other options (lines 29-38).
   - In the default path, after `const guidelines = ...` (line 125), add `const contractSection = includeCommunicationContract === false ? "" : `\n\n${COMMUNICATION_CONTRACT}`;` and change the template literal from `${guidelines}\n\nPi documentation` to `${guidelines}${contractSection}\n\nPi documentation` so disabled output is byte-identical to today's prompt.
   - Do not modify the `customPrompt` branch (lines 48-73).
2. `packages/coding-agent/src/core/settings-manager.ts`
   - Add `enableCommunicationContract?: boolean; // default: true - include the communication and turn-rules block in the default system prompt` to the `Settings` interface (line 106 block).
   - Add getter `getEnableCommunicationContract(): boolean { return this.settings.enableCommunicationContract ?? true; }` near the other boolean getters.
3. `packages/coding-agent/src/core/agent-session.ts`
   - In `_rebuildSystemPrompt` (line 1061), add `includeCommunicationContract: this.settingsManager.getEnableCommunicationContract(),` to the `_baseSystemPromptOptions` object literal (built ~lines 1080-1092). `this.settingsManager` is already a field (line 383). No other change; `_rebuildSystemPrompt` is re-invoked on tool-set changes (lines 979, 2514), so the flag is naturally respected on rebuilds.
4. `packages/coding-agent/src/index.ts`
   - Add `export { COMMUNICATION_CONTRACT } from "./core/system-prompt.ts";` (e.g. near the config exports at the top or with other core value exports).
5. Tests — extend `packages/coding-agent/test/system-prompt.test.ts` (see Testing plan) and optionally `packages/coding-agent/test/settings-manager.test.ts`.
6. Docs — `docs/settings.md`: add one row (`enableCommunicationContract`, boolean, `true`, description) to the most fitting "All Settings" table; `docs/usage.md`: one sentence near the `SYSTEM.md`/`APPEND_SYSTEM.md` docs noting the default prompt's contract block and how to disable or re-add it.
7. `packages/coding-agent/CHANGELOG.md` — add entry under `## [Unreleased]` -> `### Added` (draft below).
8. Verify — run from repo root: `npm run check` (fix all errors/warnings). Run the touched tests from `packages/coding-agent` root: `node "$(git rev-parse --show-toplevel)/node_modules/vitest/dist/cli.js" --run test/system-prompt.test.ts` (same for `test/settings-manager.test.ts` if modified). Do not run the full vitest suite. Do not commit unless asked.

## Testing plan

All in `packages/coding-agent/test/system-prompt.test.ts` (vitest, existing file, existing helpers), inside a new `describe("communication contract", ...)` block. Scenarios:

1. Default prompt contains the contract: `buildSystemPrompt({ selectedTools: [], contextFiles: [], skills: [], cwd: process.cwd() })` contains `"Communication and turn rules:"`, `"Lead with the outcome"`, and `"Never claim untested code works"`.
2. Placement: with default options, `prompt.indexOf("- Be concise in your responses") < prompt.indexOf("Communication and turn rules:") < prompt.indexOf("Pi documentation")` (all three `indexOf` values >= 0).
3. Opt-out: same call with `includeCommunicationContract: false` does not contain `"Communication and turn rules:"` but still contains the Guidelines section and the Pi documentation section (byte-identical to pre-change prompt for the overlapping parts).
4. customPrompt unchanged: `buildSystemPrompt({ customPrompt: "Custom system prompt", ... })` does not contain `"Communication and turn rules:"` — guards the full-replacement semantics.
5. promptGuidelines ordering unchanged: with `promptGuidelines: ["Use dynamic_tool for project summaries."]`, that bullet's `indexOf` lies between `prompt.indexOf("Guidelines:")` and `prompt.indexOf("Communication and turn rules:")` — user bullets stay in the Guidelines list, not the contract.
6. appendSystemPrompt still last: with `appendSystemPrompt: "APPENDED_MARKER"`, `prompt.indexOf("Communication and turn rules:") < prompt.indexOf("APPENDED_MARKER")`.
7. (Optional, `packages/coding-agent/test/settings-manager.test.ts`) `getEnableCommunicationContract()` defaults to `true` and returns `false` when the settings object sets `enableCommunicationContract: false` — follow that file's existing construction pattern.
8. Existing tests in `system-prompt.test.ts` must pass unmodified; if any assertion breaks, that is a regression in default-prompt structure, not a test to update.

Per repo rules: run each modified test file and iterate until green (command in Implementation plan step 8).

## Changelog

Draft entry for `packages/coding-agent/CHANGELOG.md`, appended to the existing `### Added` list under `## [Unreleased]` (do not duplicate the subsection):

```
- Added a "Communication and turn rules" block to the default system prompt (outcome-first final messages, keep going until done or blocked, retry after failures, assessment before fix, honest verification reporting, no filler). Disable it with `enableCommunicationContract: false` in settings; `SYSTEM.md` custom prompts are unaffected. SDK users can import the exported `COMMUNICATION_CONTRACT` constant to include the block in custom prompts.
```

## Risks and open questions

- Rule bloat vs compliance: the default prompt grows from ~400 to ~600 tokens. Instruction-following literature (unverified, per dossier) reports compliance decay as constraint count grows, and Gemini CLI gates its equivalent text on SWEBench runs. Mitigation: seven one-line consensus rules, no quantified caps, model-neutral prose, and a settings off-switch. If quality regressions are suspected, disable via settings before rewording.
- Compliance variance across models: OpenAI and OpenCode maintain per-model prompt files because one wording does not transfer cleanly. pi ships a single variant; wording was chosen from the least model-specific phrasings (no "NEVER", no formatting tiers). Monitor; per-model variants are explicitly out of scope.
- Interaction with user-provided rules: `<project_context>` (AGENTS.md etc.) and `appendSystemPrompt` land after the contract, so user instructions override by position — intended. Conversely a user's AGENTS.md style rules ("always explain in detail") may fight the contract's "only the detail the user needs"; last-position text wins, which is the same resolution order every surveyed harness uses.
- Duplication drift: "Be concise" and "Show file paths clearly" stay in Guidelines; the contract must not restate them (each rule lives in exactly one place — dossier pitfall). Future edits to either surface should keep that separation.
- Open question: should extensions be able to toggle `includeCommunicationContract` via the options object they read through `context.getSystemPromptOptions()` (`extensions/runner.ts:811`)? Currently read-only in practice; leave as-is until an extension needs it.
- Open question: if pi grows a headless/SDK non-interactive mode, the narration/stop rules need Gemini's non-interactive variant ("do not ask; use best judgment"); that would go behind the same option rather than a new block.

## Acceptance criteria

- [ ] Default prompt from `buildSystemPrompt` contains the exact "Communication and turn rules:" block from this spec, positioned between the `Guidelines:` bullets and the `Pi documentation` header.
- [ ] `buildSystemPrompt` with `customPrompt` set produces output identical to the pre-change customPrompt branch (no contract, no other additions).
- [ ] `buildSystemPrompt` with `includeCommunicationContract: false` omits the block; all other default-path sections unchanged.
- [ ] `SettingsManager.getEnableCommunicationContract()` defaults to `true`; setting `enableCommunicationContract: false` in settings removes the block from the session's built system prompt (verified by the agent-session wiring in `_rebuildSystemPrompt`).
- [ ] `COMMUNICATION_CONTRACT` is exported from `packages/coding-agent/src/core/system-prompt.ts` and re-exported from the package root `src/index.ts`.
- [ ] `promptGuidelines` merge behavior and ordering are unchanged; all pre-existing tests in `test/system-prompt.test.ts` pass without modification.
- [ ] New vitest cases from the Testing plan exist in `test/system-prompt.test.ts` and pass (run via the vitest CLI from the package root).
- [ ] `npm run check` passes clean from the repo root after all changes.
- [ ] `packages/coding-agent/CHANGELOG.md` has one new entry under `## [Unreleased]` -> `### Added`; no released sections modified.
- [ ] No changes under `packages/agent/src` (the system prompt remains an opaque string there), `vendor/`, or `packages/coding-agent/dist/`.
- [ ] All added TypeScript uses erasable syntax only (no enums, namespaces, parameter properties, or `import =`).
