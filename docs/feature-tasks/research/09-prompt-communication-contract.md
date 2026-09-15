# Research dossier 09: the system-prompt communication contract layer

Scope: the turn-structure and communication rules baked into coding-agent system prompts (final-message rules, outcome-first ordering, stop/continue rules, retry discipline, autonomy rules), as distinct from identity/personality text. Sources fetched 2026-09-14. Quotes are verbatim from the fetched sources unless marked "firsthand" or "(unverified)".

## Summary

Every major coding-agent harness ships a communication-contract layer alongside its identity text, and the layer converges on the same ~8 rule families: outcome-first ordering, a stop rule (keep going until done or genuinely blocked), assessment-vs-fix mode detection, verification before claiming done, question budgets, anti-filler rules, file-reference formats, and (in newer harnesses) explicit final-message visibility rules. Harnesses differ mainly in placement (monolithic prompt vs composed sections vs per-tool descriptions vs turn-injected reminders) and in how aggressively they quantify brevity. No public controlled ablation of any specific clause exists; the strongest evidence that this text measurably changes behavior is Gemini CLI's own source comment requiring SWEBench runs before editing its "Context Efficiency" prompt section, plus the fact that OpenAI and OpenCode maintain per-model prompt variants.

## Findings by harness

### Claude Code (Anthropic)

Source (leak capture, prompt template extracted from a live Claude Code session; includes tool descriptions): https://gist.github.com/chigkim/1f37bb2be98d97c952fd79cbb3efb1c6 . Mirrors and ongoing extractions: https://github.com/x1xhlol/system-prompts-and-models-of-ai-tools , https://github.com/Piebald-AI/claude-code-system-prompts . The prompt is not public documentation; treat wording as version-specific (this capture dated 2026-01-15).

Placement: one monolithic prompt with markdown sections, plus contract rules duplicated inside per-tool descriptions (TodoWrite), plus turn-scoped `<system-reminder>` injections (e.g. plan-mode reminders; see OpenCode below for verbatim copies of those reminders).

Tone and style section (verbatim):

> - Only use emojis if the user explicitly requests it. Avoid using emojis in all communication unless asked.
> - Your output will be displayed on a command line interface. Your responses should be short and concise. You can use Github-flavored markdown for formatting, and will be rendered in a monospace font using the CommonMark specification.
> - Output text to communicate with the user; all text you output outside of tool use is displayed to the user. Only use tools to complete tasks. Never use tools like Bash or code comments as means to communicate with the user during the session.
> - NEVER create files unless they're absolutely necessary for achieving your goal. ALWAYS prefer editing an existing file to creating a new one. This includes markdown files.
> - Do not use a colon before tool calls. Your tool calls may not be shown directly in the output, so text like "Let me read the file:" followed by a read tool call should just be "Let me read the file." with a period.

Professional objectivity (verbatim, opening):

> Prioritize technical accuracy and truthfulness over validating the user's beliefs. Focus on facts and problem-solving, providing direct, objective technical info without any unnecessary superlatives, praise, or emotional validation. [...] Avoid using over-the-top validation or excessive praise when responding to users such as "You're absolutely right" or similar phrases.

Task Management (verbatim):

> You have access to the TodoWrite tools to help you manage and plan tasks. Use these tools VERY frequently to ensure that you are tracking your tasks and giving the user visibility into your progress.
> [...]
> It is critical that you mark todos as completed as soon as you are done with a task. Do not batch up multiple tasks before marking them as being completed.

The same discipline is repeated inside the TodoWrite tool description (per-tool placement), verbatim excerpts:

> - Mark tasks complete IMMEDIATELY after finishing (don't batch completions)
> - Exactly ONE task must be in_progress at any time (not less, not more)
> - ONLY mark a task as completed when you have FULLY accomplished it
> - If you encounter errors, blockers, or cannot finish, keep the task as in_progress

Doing tasks (verbatim excerpts — the prohibition block other harnesses copied):

> - NEVER propose changes to code you haven't read. If a user asks about or wants you to modify a file, read it first. Understand existing code before suggesting modifications.
> - Avoid over-engineering. Only make changes that are directly requested or clearly necessary. Keep solutions simple and focused.
>   - Don't add features, refactor code, or make "improvements" beyond what was asked. A bug fix doesn't need surrounding code cleaned up. A simple feature doesn't need extra configurability. Don't add docstrings, comments, or type annotations to code you didn't change. Only add comments where the logic isn't self-evident.
>   - Don't add error handling, fallbacks, or validation for scenarios that can't happen. Trust internal code and framework guarantees. Only validate at system boundaries (user input, external APIs). Don't use feature flags or backwards-compatibility shims when you can just change the code.

Tool usage policy (verbatim, parallelism + subagent routing):

> - You can call multiple tools in a single response. If you intend to call multiple tools and there are no dependencies between them, make all independent tool calls in parallel. Maximize use of parallel tool calls where possible to increase efficiency. However, if some tool calls depend on previous calls to inform dependent values, do NOT call these tools in parallel and instead run them sequentially. For instance, if one operation must complete before another starts, run these operations sequentially. Never use placeholders or guess missing parameters in tool calls.

Code references (verbatim):

> When referencing specific functions or pieces of code include the pattern `file_path:line_number` to allow the user to easily navigate to the source code location.

Verification discipline lives in the git/PR sections, e.g. "Run git status after the commit completes to verify success." and the PR body template's `## Test plan` section. Question handling: an AskUserQuestion tool exists, but there is no explicit question budget in the prompt; constraints appear only as "never include time estimates".

Notably absent: an explicit "keep going until done" stop rule and an assessment-vs-fix rule. Claude Code relies on the model's defaults plus tool-level nudges.

### OpenAI Codex CLI

Sources (fetched verbatim from the repo, per-model prompt variants): https://github.com/openai/codex/blob/main/codex-rs/core/gpt_5_codex_prompt.md and https://github.com/openai/codex/blob/main/codex-rs/core/gpt_5_1_prompt.md (the original `codex-rs/prompt.md` no longer exists; the repo now holds gpt_5_codex, gpt_5_1, gpt_5_2, gpt-5.1-codex-max and other variants — found via GitHub code search).

Placement: single prompt file per model family, selected at runtime; plan-tool discipline described both in the base prompt (`update_plan` section) and implicitly in the tool schema. The gpt_5_1 variant is the fullest contract layer found in any harness.

Autonomy and persistence (gpt_5_1, verbatim):

> Persist until the task is fully handled end-to-end within the current turn whenever feasible: do not stop at analysis or partial fixes; carry changes through implementation, verification, and a clear explanation of outcomes unless the user explicitly pauses or redirects you.
>
> Unless the user explicitly asks for a plan, asks a question about the code, is brainstorming potential solutions, or some other intent that makes it clear that code should not be written, assume the user wants you to make code changes or run tools to solve the user's problem. In these cases, it's bad to output your proposed solution in a message, you should go ahead and actually implement the change. If you encounter challenges or blockers, you should attempt to resolve them yourself.

Task execution stop rule (gpt_5_1, verbatim):

> You are a coding agent. You must keep going until the query or task is completely resolved, before ending your turn and yielding back to the user. Persist until the task is fully handled end-to-end within the current turn whenever feasible and persevere even when function calls fail. Only terminate your turn when you are sure that the problem is solved. Autonomously resolve the query to the best of your ability, using the tools available to you, before coming back to the user. Do NOT guess or make up an answer.

Final message rules (gpt_5_codex, "Presenting your work and final message", verbatim):

> - Default: be very concise; friendly coding teammate tone.
> - Ask only when needed; suggest ideas; mirror the user's style.
> - For substantial work, summarize clearly; follow final‑answer formatting.
> - Skip heavy formatting for simple confirmations.
> - Don't dump large files you've written; reference paths only.
> - No "save/copy this file" - User is on the same machine.
> - Offer logical next steps (tests, commits, build) briefly; add verify steps if you couldn't do something.
> - For code changes:
>   * Lead with a quick explanation of the change, and then give more details on the context covering where and why a change was made. Do not start this explanation with "summary", just jump right in.
> [...]
> - The user does not command execution outputs. When asked to show the output of a command (e.g. `git show`), relay the important details in your answer or summarize the key lines so the user understands the result.

Enforced verbosity tiers (gpt_5_1, "Verbosity", verbatim — the only quantified-by-task-size scheme found):

> - Tiny/small single-file change (≤ ~10 lines): 2–5 sentences or ≤3 bullets. No headings. 0–1 short snippet (≤3 lines) only if essential.
> - Medium change (single area or a few files): ≤6 bullets or 6–10 sentences. At most 1–2 short snippets total (≤8 lines each).
> - Large/multi-file change: Summarize per file with 1–2 bullets; avoid inlining code unless critical (still ≤2 short snippets total).
> - Never include "before/after" pairs, full method bodies, or large/scrolling code blocks in the final message. Prefer referencing file/symbol names instead.

Plan discipline (gpt_5_1, verbatim excerpts):

> Maintain statuses in the tool: exactly one item in_progress at a time; mark items complete when done; post timely status transitions. Do not jump an item from pending to completed: always set it to in_progress first. Do not batch-complete multiple items after the fact. Finish with all items completed or explicitly canceled/deferred before ending the turn.

gpt_5_codex adds usage gates: "Skip using the planning tool for straightforward tasks (roughly the easiest 25%)." and "Do not make single-step plans."

Review-mode contract (gpt_5_codex, verbatim):

> If the user asks for a "review", default to a code review mindset: prioritise identifying bugs, risks, behavioural regressions, and missing tests. Findings must be the primary focus of the response - keep summaries or overviews brief and only after enumerating the issues. Present findings first (ordered by severity with file/line references), follow with open questions or assumptions, and offer a change-summary only as a secondary detail.

Validation proactivity is made approval-mode-dependent (gpt_5_1, verbatim excerpts): "When running in the non-interactive approval mode **never**, you can proactively run tests, lint and do whatever you need" vs "When working in interactive approval modes like **untrusted**, or **on-request**, hold off on running tests or lint commands until the user is ready for you to finalize your output". Also: "Do not waste tokens by re-reading files after calling `apply_patch` on them. The tool call will fail if it didn't work."

### Gemini CLI (Google)

Source (fetched verbatim): https://github.com/google-gemini/gemini-cli/blob/main/packages/core/src/prompts/snippets.ts (open source; the prompt is composed at runtime by renderer functions — Preamble, CoreMandates, Workflows, OperationalGuidelines, Sandbox, GitRepo — with `interactive`/`topicUpdateNarration`/tool-availability options). This is the strongest precedent for a composable contract module.

Preamble switches on mode (verbatim, from `renderPreamble`):

> You are Gemini CLI, an interactive CLI agent specializing in software engineering tasks. [...] You are currently operating in **Default** mode.

("autonomous CLI agent" in the non-interactive branch; modes: Default / Plan / YOLO / Auto-Edit.)

Directives vs Inquiries — the most explicit assessment-vs-fix rule found (verbatim, from `renderCoreMandates`):

> Distinguish between **Directives** (unambiguous requests for action or implementation) and **Inquiries** (requests for analysis, advice, or observations, e.g., "Can you tell me how to"). Assume all requests are Inquiries unless they contain an explicit instruction to perform a task. For Inquiries, or whenever the user explicitly instructs you NOT to make changes just yet [...] your scope is strictly limited to research and analysis; you may propose a solution or strategy, but you MUST NOT modify files until a subsequent Directive is issued. Do not initiate implementation based on observations of bugs or statements of fact. Once an Inquiry is resolved, or while waiting for a Directive, stop and wait for the next user instruction.

Interactive vs non-interactive confirmation rule (verbatim, `mandateConfirm`):

> **Confirm Ambiguity/Expansion:** Do not take significant actions beyond the clear scope of the request without confirming with the user. If the user implies a change (e.g. reports a bug) without explicitly asking for a fix, **ask for confirmation first**. If asked *how* to do something, explain first, don't just do it.

Non-interactive variant (verbatim, `mandateContinueWork`):

> **Non-Interactive Environment:** You are running in a headless/CI environment and cannot interact with the user. Do not ask the user questions or request additional information, as the session will terminate. Use your best judgment to complete the task.

Anti-noise and brevity (verbatim, `renderOperationalGuidelines` "Tone and Style"):

> - **Minimal Output:** Aim for fewer than 3 lines of text output (excluding tool use/code generation) per response whenever practical.
> - **No Chitchat:** Avoid conversational filler, preambles ("Okay, I will now..."), or postambles ("I have finished the changes...") unless they are [...]
> - **No Repetition:** Once you have provided a final synthesis of your work, do not repeat yourself or provide additional summaries. For simple or direct requests, prioritize extreme brevity.

Turn-structure rules (verbatim, "Tool Usage"):

> 1. After receiving a `functionResponse`, you MUST ALWAYS execute one of the following two actions:
>    a) Call another tool to proceed with the task.
>    b) Provide a user-facing text response explaining the tool output, your analysis, and next steps.
> 2. You MUST NEVER return an empty response with no text and no tool calls.

and "Post-Edit Response Rules": after edit tools, "you MUST ALWAYS generate a user-facing text response summarizing: What changes were made to the file. Your verification plan or next steps".

Retry/confirmation discipline (verbatim): "If a tool call is declined or cancelled, respect the decision immediately. Do not re-attempt the action or 'negotiate' for the same tool call unless the user explicitly directs you to. Offer an alternative technical path if possible."

Vendor evidence that this wording is perf-sensitive — source comment above the Context Efficiency section (verbatim):

> ⚠️ IMPORTANT: the Context Efficiency changes strike a delicate balance that encourages the agent to minimize response sizes while also taking care to avoid extra turns. You must run the major benchmarks, such as SWEBench, prior to committing any changes to the Context Efficiency section to avoid regressing this behavior.

An older narration rule exists as an alternate leaf (`mandateExplainBeforeActing`, verbatim): "**Explain Before Acting:** Never call tools in silence. You MUST provide a concise, one-sentence explanation of your intent or strategy immediately before executing tool calls." — the current default swaps this for a structured topic-update tool, i.e. Gemini moved from free-text narration rules to a dedicated tool.

### OpenCode (SST)

Sources (fetched verbatim): https://github.com/sst/opencode/blob/main/packages/opencode/src/session/prompt/default.txt , .../prompt/plan.txt , .../prompt/plan-reminder-anthropic.txt .

Placement: per-model prompt files (`anthropic.txt`, `gemini.txt`, `gpt.txt`, `codex.txt`, `kimi.txt`, `meta.txt`, `copilot-gpt-5.txt`, `gpt-astra.txt`, `beast.txt` in `packages/opencode/src/session/prompt/`), selected by model; plus mode prompts (plan) injected as `<system-reminder>` at turn scope. `default.txt` is visibly a Claude Code derivative with a much more aggressive brevity contract.

Brevity contract (default.txt, verbatim):

> IMPORTANT: You should NOT answer with unnecessary preamble or postamble (such as explaining your code or summarizing your action), unless the user asks you to.
> [...]
> IMPORTANT: Keep your responses short, since they will be displayed on a command line interface. You MUST answer concisely with fewer than 4 lines (not including tool use or code generation), unless user asks for detail. Answer the user's question directly, without elaboration, explanation, or details. One word answers are best. Avoid introductions, conclusions, and explanations. You MUST avoid text before/after your response, such as "The answer is <answer>.", "Here is the content of the file..." or "Based on the information provided, the answer is..." or "Here is what I will do next...".

With worked examples, e.g. `user: what is 2+2?` / `assistant: 4`.

Proactiveness / assessment-vs-fix (default.txt, verbatim):

> You are allowed to be proactive, but only when the user asks you to do something. You should strive to strike a balance between:
> 1. Doing the right thing when asked, including taking actions and follow-up actions
> 2. Not surprising the user with actions you take without asking
> For example, if the user asks you how to approach something, you should do your best to answer their question first, and not immediately jump into taking actions.
> 3. Do not add additional code explanation summary unless requested by the user. After working on a file, just stop, rather than providing an explanation of what you did.

Verification discipline (default.txt, verbatim):

> - VERY IMPORTANT: When you have completed a task, you MUST run the lint and typecheck commands (e.g. npm run lint, npm run typecheck, ruff, etc.) with Bash if they were provided to you to ensure your code is correct. If you are unable to find the correct command, ask the user for the command to run and if they supply it, proactively suggest writing it to AGENTS.md so that you will know to run it next time.
> NEVER commit changes unless the user explicitly asks you to. It is VERY IMPORTANT to only commit when explicitly asked, otherwise the user will feel that you are being too proactive.

Turn-ending rule in plan mode (from `plan-reminder-anthropic.txt` — verbatim Claude Code reminder text shipped in OpenCode for Anthropic models; injected as `<system-reminder>`, not part of the system prompt):

> ### Phase 5: Call ExitPlanMode
> At the very end of your turn, once you have asked the user questions and are happy with your final plan file - you should always call ExitPlanMode to indicate to the user that you are done planning.
> This is critical - your turn should only end with either asking the user a question or calling ExitPlanMode. Do not stop unless it's for these 2 reasons.

### Cursor CLI

Source (leak capture, 2025-08-07): https://gist.github.com/gregce/9b45c563affa191caa748f699eeb9d95 (Cursor's prompt is not public; this capture matches the Codex-derived structure Cursor CLI uses). Earlier agent-prompt leak: https://gist.github.com/sshh12/25ad2e40529b269a88b80e7cf1c38084 .

Placement: single prompt, contract rules grouped into XML-style tags (`<communication>`, `<status_update_spec>`, `<summary_spec>`, `<flow>`, `<tool_calling>`, `<context_understanding>`, `<maximize_parallel_tool_calls>`) — the only harness found that tags contract sections explicitly.

Stop rule (verbatim):

> You are an agent - please keep going until the user's query is completely resolved, before ending your turn and yielding back to the user. Only terminate your turn when you are sure that the problem is solved. Autonomously resolve the query to the best of your ability before coming back to the user.

Communication tag (verbatim excerpts):

> - When communicating with the user, optimize your writing for clarity and skimmability giving the user option to read more or less.
> [...]
> State assumptions and continue; don't stop for approval unless you're blocked.

Status-update contract (verbatim):

> - Critical execution rule: If you say you're about to do something, actually do it in the same turn (run the tool call right after). Only pause if you truly cannot proceed without the user or a tool result.
> - Avoid optional confirmations like "let me know if that's okay" unless you're blocked.

Final-summary contract (`<summary_spec>`, verbatim):

> At the end of your turn, you should provide a summary.
> - Summarize any changes you made at a high-level and their impact. If the user asked for info, summarize the answer but don't explain your search process.
> [...]
> - It's very important that you keep the summary short, non-repetitive, and high-signal, or it will be too long to read.

Turn lifecycle (`<flow>`, verbatim): "1. Whenever a new goal is detected (by USER message), run a brief discovery pass [...] 2. Before logical groups of tool calls, write an extremely brief status update per <status_update_spec>. 3. When all tasks for the goal are done, give a brief summary per <summary_spec>." Also: "Bias towards not asking the user for help if you can find the answer yourself."

### Zed

Source (fetched verbatim — open source): https://github.com/zed-industries/zed/blob/main/crates/agent/src/templates/system_prompt.hbs . Placement: one Handlebars template with conditionals on tool availability (`{{#if (gt (len available_tools) 0)}}`), a no-tools fallback branch, and sandbox/model sections.

Task Execution — stop rule and question budget (verbatim):

> - Keep going until the user's task is completely resolved before ending your turn and yielding back to the user. Only terminate your turn when you are sure the problem is solved.
> - Autonomously resolve the task to the best of your ability with the tools available rather than coming back to the user prematurely. Ask the user only when the information you need is genuinely unavailable from the project, or when proceeding without clarification would be risky.
> - Do not guess or make up an answer.

Readability-over-brevity and detail matching (verbatim):

> - Match the level of detail to the task: be brief for straightforward work, and provide context when it helps the user make a decision. Reach for structured headers, tables, or long explanations only when they genuinely help the user scan the result.

Interim narration rule — opposite camp from Gemini/OpenCode (verbatim):

> - Before a group of related tool calls, send a brief one- to two-sentence preamble explaining what you're about to do, so the user can follow along. Skip the preamble for trivial single reads or when continuing a clearly described step.

Verification honesty (verbatim):

> - Do not claim validation passed unless you actually ran it and saw it pass.
> - If validation fails, report the failing command and the relevant error. Fix issues you caused when you can identify the root cause.

Final-message contract — the cleanest "Final Message" section found (verbatim):

> - When you finish a coding task, briefly summarize what changed, reference the relevant files, and state what validation you ran (or why you did not run any).
> - Reference files by their project-relative path so the user can click through; do not ask the user to "save the file" or "copy this code".
> - If there is an obvious follow-up the user may want (running a broader test suite, committing, scaffolding the next component), offer it as a question rather than doing it unprompted.

### Amp (Sourcegraph)

Source (leak collection, fetched verbatim): https://github.com/asgeirtj/system_prompts_leaks/blob/main/Misc/amp-code.md . Not official; the repo documents five mode-specific prompts (default `d_R`, autonomous agent `g_R`, pair `O_R`, orchestrator `o_R`, agent `x_R`). Placement: per-mode prompts with a shared contract vocabulary.

Response channels — explicit two-tier visibility model (verbatim):

> You have two ways of communicating with the users:
> - Intermediary updates in `commentary` channel.
> - Final responses in `final` channel.
>
> **`commentary` channel:** Intermediary updates. Short updates while you are working, NOT final answers. Keep updates to 1-2 sentences [...] Send an update only when it changes the user's understanding of the work: a meaningful discovery, a decision with tradeoffs, a blocker, a substantial plan, or the start of a non-trivial edit or verification step. Do not narrate routine searching, file reads, obvious next steps, or incremental confirmations.
>
> **`final` channel:** Your final response. Always favor conciseness. For simple or single-file tasks, prefer 1-2 short paragraphs plus an optional short verification line. Do not default to bullets. On simple tasks, prose is usually better than a list.
>
> On larger tasks, use at most 2-4 high-level sections when helpful. [...] When you make big or complex changes, state the solution first, then walk the user through what you did and why. If you weren't able to do something, for example run tests, tell the user.

Anti-openers and machine-access framing (verbatim):

> Do not begin responses with conversational interjections or meta commentary. Avoid openers such as acknowledgements ("Done --", "Got it", "Great question, ") or framing phrases.
> [...]
> The user does not see command execution outputs. When asked to show the output of a command (e.g. `git show`), relay the important details in your answer or summarize the key lines so the user understands the result.
> [...]
> Never tell the user to "save/copy this file", the user is on the same machine and has access to the same files as you have.

Assessment-vs-fix and question budget (g_R, verbatim):

> Unless the user is asking a question, brainstorming, or explicitly requesting a plan, assume they want you to solve the problem with code and tools rather than describing a proposed solution. If you hit blockers, try to resolve them yourself.
>
> Prefer making progress over stopping for clarification when the request is already clear enough to attempt. Use context and reasonable assumptions to move forward. Ask for clarification only when the missing information would materially change the answer or create meaningful risk, and keep any question narrow.

Retry discipline (g_R, verbatim — the most precise phrasing found):

> If an approach fails, diagnose why before switching tactics - read the error, check your assumptions, try a focused fix. Don't retry the identical action blindly, but don't abandon a viable approach after a single failure either.

Mid-turn user messages (g_R, verbatim): "New user messages during a turn refine the work; the newest message wins on conflict. Honor every non-conflicting request since your last turn, not just the latest one. A status request means: give the update, then keep working -- don't treat it as a stop."

### ZCode (firsthand)

The orchestrator running this research operates under a contract layer that includes (near-verbatim, labeled firsthand):

- Final-message visibility: "Text you write between tool calls may not be shown to the user. Everything the user needs from this turn — answers, summaries, findings, conclusions, deliverables — must be in the final text message of your turn, with no tool calls after it."
- Outcome-first: "Lead with the outcome. Your first sentence after finishing should answer 'what happened' or 'what did you find' — the thing the user would ask for if they said 'just give me the TLDR.'"
- Readability vs brevity: "Being readable and being concise are different things, and readable matters more... The way to keep output short is to be selective about what you include, not to compress the writing into fragments, abbreviations, arrow chains, or jargon." Plus: "Match the response to the question: a simple question gets a direct answer in prose, not headers and sections."
- Autonomy: "you are operating autonomously... asking 'Want me to…?' blocks the work. For reversible actions that follow from the original request, proceed without asking. Stop only for destructive actions or genuine scope changes".
- Pre-turn-end self-check: "Before ending your turn, check your last paragraph. If it is a plan, an analysis, a question, a list of next steps, or a promise about work you have not done ('I'll…'), do that work now with tool calls... That includes retrying after errors and gathering missing information yourself. End your turn only when the task is complete or you are blocked on input only the user can provide."
- Assessment-vs-fix exception: "when the user is describing a problem, asking a question, or thinking out loud rather than requesting a change, the deliverable is your assessment. Report your findings and stop. Don't apply a fix until they ask for one."
- Style: code comments "state constraints, never narrate changes"; "Write code that reads like the surrounding code."

This is the only contract found that makes the final-message visibility rule explicit for a UI that may hide interim text; Amp's commentary/final channels are the closest analogue.

## Contract taxonomy

Rule families observed across harnesses (harnesses listed have the rule in some form):

1. Final-message / visibility rules — everything the user needs must be in the last text message; interim text may not render; never end on tool output alone. (ZCode firsthand; Amp commentary/final channels; Cursor `<summary_spec>`; Gemini "You MUST NEVER return an empty response with no text and no tool calls"; Claude Code's weaker "Do not use a colon before tool calls... may not be shown".)
2. Outcome-first ordering — first sentence answers what happened/found; findings before summaries. (ZCode firsthand; Codex "Lead with a quick explanation of the change" and review-mode "Findings must be the primary focus... Present findings first"; Amp "state the solution first, then walk the user through"; Zed "briefly summarize what changed".)
3. Readability vs brevity — two camps: quantified caps (Gemini "<3 lines"; OpenCode "<4 lines... One word answers are best"; Codex enforced per-size tiers) vs unquantified match-detail-to-task (Zed "Match the level of detail to the task"; ZCode "readable matters more"; Amp "Do not default to bullets. On simple tasks, prose is usually better"; Claude Code "short and concise" only).
4. Stopping/continuing rules — keep going until resolved; end only when done or blocked; no promises about future work. (Codex, Cursor, Zed near-identical "keep going until... before ending your turn and yielding back to the user"; ZCode "check your last paragraph... do that work now"; OpenCode plan reminder "only end with either asking the user a question or calling ExitPlanMode"; Gemini "Once you have provided a final synthesis... do not repeat yourself".)
5. Autonomy vs confirmation — proceed on reversible in-scope actions; ask only for destructive/scope-expanding ones; non-interactive mode forbids asking. (ZCode firsthand; Codex "assume the user wants you to make code changes"; Amp identical; Cursor "State assumptions and continue"; Gemini mandateConfirm + non-interactive variant; Claude Code and OpenCode invert toward caution for git: "NEVER commit changes unless the user explicitly asks".)
6. Assessment-vs-fix mode — question/brainstorm/problem-report ⇒ analysis only, no edits until asked. (Gemini Directives vs Inquiries, most explicit; Codex and Amp "Unless the user explicitly asks for a plan, asks a question, is brainstorming..."; OpenCode "if the user asks you how to approach something... answer their question first"; ZCode firsthand exception clause. Absent from Claude Code and Cursor.)
7. Verification discipline — run tests/lint before claiming done; report validation state honestly; scale verification to risk; approval-mode-dependent proactivity. (Zed "Do not claim validation passed unless you actually ran it and saw it pass"; Amp "Verify your work before reporting it as done" + risk-scaled verification; OpenCode "you MUST run the lint and typecheck commands"; Codex approval-mode-dependent testing; Gemini empirical-reproduction mandate for bug fixes; Claude Code only inside git/PR workflows.)
8. Question budget — narrow, rare, high-threshold questions. (Amp "only when the missing information would materially change the answer... keep any question narrow"; Zed "only when the information you need is genuinely unavailable... or proceeding without clarification would be risky"; Codex "Ask only when needed"; Gemini "only clarify if critically underspecified"; Cursor "Bias towards not asking the user for help".)
9. Retry/self-recovery discipline — retry and self-resolve on errors; no blind retries. (ZCode firsthand "retrying after errors and gathering missing information yourself"; Codex "persevere even when function calls fail"; Amp "Don't retry the identical action blindly, but don't abandon a viable approach after a single failure either"; Gemini sandbox failure recovery procedure.)
10. Anti-filler / anti-openers — no acknowledgements, no preambles/postambles, no "save this file", no tool-as-communication. (Amp "Avoid openers such as acknowledgements"; Gemini "No Chitchat"; OpenCode "NOT answer with unnecessary preamble or postamble"; Codex/Claude Code/Zed "save/copy this file" bans; Claude Code "Never use tools like Bash or code comments as means to communicate".)
11. Progress narration — split camp. Pro-narration: Zed (1-2 sentence preambles before tool groups), Codex gpt_5_1 (User Updates Spec with examples), Cursor (`<status_update_spec>`), Claude Code (colon rule assumes interim text renders). Anti-narration: Gemini current ("mechanical tool-use narration" banned; narration moved into a dedicated `update_topic` tool), OpenCode ("After working on a file, just stop"), Amp (updates only when they change understanding).
12. Todo/plan-tool discipline — exactly one in_progress, no batch completion, no completion on failure, skip for trivial tasks. (Claude Code prompt + TodoWrite tool description; Codex update_plan rules; Gemini write_todos for complex tasks.)

## Evidence on effectiveness

No public controlled ablation of any specific contract clause was found; evidence is indirect or vendor-internal:

- Vendor-internal gating (direct): the Gemini CLI source comment quoted above requires "the major benchmarks, such as SWEBench" before changes to its Context Efficiency section — Google treats this prompt text as performance-sensitive code.
- Maintenance cost as evidence of model-specificity: OpenAI ships ≥5 per-model prompt files (gpt_5_codex, gpt_5_1, gpt_5_2, gpt-5.2-codex, gpt-5.1-codex-max); OpenCode ships per-model prompt files (anthropic.txt, gemini.txt, gpt.txt, kimi.txt, ...). One contract wording does not transfer cleanly across models.
- Behavioral analyses (secondary): https://danicat.dev/posts/gemini-cli-system-prompt/ documents the Gemini proactiveness mandates shaping behavior and walks through overriding them; https://lagindicator.com/dev-tools/same-model-different-cli/ compares same-model-different-prompt behavior across CLIs; https://blog.fsck.com/2025/06/26/system-prompts-for-cli-coding-agents/ notes Gemini CLI's prompt copied Claude Code's structure.
- Instruction-following literature (unverified, from model memory — URLs not fetched): FollowBench (arXiv 2310.20410), InFoBench (arXiv 2401.03601), and IFBench (2025) report monotonic compliance decline as constraint count grows; "lost in the middle" (Liu et al., 2023) reports positional effects in long prompts. This supports the rule-bloat pitfall but was not verified against the papers for this dossier.
- Widespread copying is weak evidence of effectiveness: OpenCode default.txt, Cursor CLI's prompt, and Gemini's older prompt are all visibly derived from Claude Code / Codex text, which indicates the text works well enough to imitate, but also propagates untested wording.

## Gaps and pitfalls

- Rule bloat vs compliance: every harness shows accretion (Codex gpt_5_1 is 24 KB; Claude Code capture 76 KB including tools; Zed 19.8 KB; Cursor 14 KB; OpenCode 8.5 KB; Gemini's rendered prompt is composed from a 70 KB TS source). Multi-constraint literature (unverified) says compliance decays with rule count; Gemini's SWEBench gate exists precisely because wording changes regress benchmarks.
- Quantified brevity rules conflict with substance rules: OpenCode's "fewer than 4 lines... One word answers are best" collides with its own "MUST run lint and typecheck and report" and with Amp/Codex final-message summary requirements. Codex resolves this with enforced per-task-size tiers — at the cost of a large rules block.
- Conflicts with customPrompt users: pi's customPrompt fully replaces the default; users shipping their own prompts already contain contract text. Force-appending pi's contract after customPrompt would create duplicate/contradicting instructions (e.g. a user wanting verbose output vs pi's conciseness). No surveyed harness injects contract text after a user-supplied full replacement (Gemini's GEMINI_SYSTEM_MD replaces; OpenCode per-model files replace; Codex experimental_instructions replace).
- Narration camp mismatch: a "no preamble" contract is wrong for a TUI that renders interim text helpfully; a "always narrate" contract is wrong for a harness whose UI hides interim text (ZCode's rule exists because its UI can hide it). pi's TUI does render assistant text between tool calls, so the ZCode-style visibility rule would be factually wrong for pi; Claude Code's colon rule or Zed's preamble rule match pi's actual rendering.
- Rules duplicating tool descriptions drift: Claude Code ships todo discipline in both the prompt ("mark todos as completed as soon as you are done") and the TodoWrite tool description ("Mark tasks complete IMMEDIATELY"). When they drift, compliance gets noisy. pi should keep each rule in exactly one place (tool description when a tool exists, prompt otherwise).
- Model-specific wording: "NEVER create files", "one word answers", and enforced formatting tiers are tuned for specific model families; OpenAI and OpenCode maintain per-model files because of this. pi is model-agnostic, so its contract should be model-neutral prose and short.
- Placement matters for decay: system-prompt rules lose force over long sessions; Claude Code and OpenCode reinforce with turn-scoped `<system-reminder>` injections (plan mode). A base-prompt-only contract is weakest exactly where it matters most (long agentic turns).
- Token cost is real but small if capped: even Codex's full contract is ~6K tokens; pi's entire default prompt renders at roughly 400 tokens. A 150-250 token contract section is proportionate.

## Design takeaways for pi

- Add a composable contract section inside the default prompt path only: a small function (in `packages/coding-agent/src/core/system-prompt.ts` or a sibling `contract.ts`) returning one labeled block (e.g. "Communication and turn rules") placed between the guidelines and the docs pointers. Gemini's renderer-composition (snippets.ts) and Zed's conditional template are the precedent, but pi needs only one function and one block to stay minimal. Target ≤ ~15 one-line rules / ≤ ~250 tokens.
- Keep customPrompt semantics unchanged: the contract is part of the default prompt and disappears when customPrompt replaces it; do not force-append. Export the contract string/builder so SDK users composing their own prompt can include it explicitly. appendSystemPrompt remains the user's additive hook, appended last (de-facto override-by-position, as in every surveyed harness).
- Encode only cross-harness consensus rules: outcome-first lead; stop rule (end turn only when complete or blocked on user input; no closing promises about future work); retry/self-recover before giving up; assessment-vs-fix (question/problem description ⇒ analysis, no edits until asked); verification-before-done with honest reporting ("say what you ran; don't claim untested code works"); no filler openers/closers; file paths (with line numbers for specific locations) in results.
- Match visibility rules to pi's TUI: pi renders interim text, so do not copy ZCode's "may not be shown" rule; use Claude Code's cheaper variant (no colon before tool calls; short lead-ins fine) and Zed's "skip preamble for trivial steps" calibration. If pi grows a headless/non-interactive mode, swap in the Gemini non-interactive variant (never ask; proceed on best judgment) behind an `interactive` option on BuildSystemPromptOptions.
- Do not quantify brevity: no "<N lines" rules (the most-copied and most-criticized clause family). Prefer Zed/ZCode-style "match detail to the task; readable over compressed" and Amp's "prose over bullets for simple results".
- Skip rules for tools pi does not ship: no todo/plan-tool discipline, no subagent routing rules, no review-mode contract until the corresponding feature exists; put tool-coupled rules in tool descriptions when the tools arrive, not in the prompt (single source of truth).
- Keep promptGuidelines and the contract separate: promptGuidelines stays a user-facing bullet list merged into Guidelines; the contract is a harness-owned block. This keeps users from having to reverse-engineer which bullets are theirs, and lets a future `contract: false` (or similar) option disable the block without touching guideline merging.
- Leave reinforcement out of v1: turn-scoped reminders (the Claude Code/OpenCode `<system-reminder>` pattern) can be added later without touching the base prompt if long-session decay shows up; the base contract should be designed so a one-line reminder version of the stop rule and final-message rule can be extracted verbatim from it.

## Sources

- Claude Code prompt capture (gist): https://gist.github.com/chigkim/1f37bb2be98d97c952fd79cbb3efb1c6
- Claude Code extracted prompts (npm): https://github.com/Piebald-AI/claude-code-system-prompts
- Leak collection: https://github.com/x1xhlol/system-prompts-and-models-of-ai-tools
- Codex CLI gpt_5_codex prompt: https://github.com/openai/codex/blob/main/codex-rs/core/gpt_5_codex_prompt.md
- Codex CLI gpt_5_1 prompt: https://github.com/openai/codex/blob/main/codex-rs/core/gpt_5_1_prompt.md
- Codex repo (prompt variants listing): https://github.com/openai/codex
- Gemini CLI prompt source: https://github.com/google-gemini/gemini-cli/blob/main/packages/core/src/prompts/snippets.ts
- Gemini CLI repo: https://github.com/google-gemini/gemini-cli
- OpenCode default prompt: https://github.com/sst/opencode/blob/main/packages/opencode/src/session/prompt/default.txt
- OpenCode plan prompt: https://github.com/sst/opencode/blob/main/packages/opencode/src/session/prompt/plan.txt
- OpenCode plan reminder (Claude Code-derived): https://github.com/sst/opencode/blob/main/packages/opencode/src/session/prompt/plan-reminder-anthropic.txt
- Cursor CLI prompt capture (gist): https://gist.github.com/gregce/9b45c563affa191caa748f699eeb9d95
- Cursor agent prompt capture (gist, 2025-03): https://gist.github.com/sshh12/25ad2e40529b269a88b80e7cf1c38084
- Zed agent system prompt template: https://github.com/zed-industries/zed/blob/main/crates/agent/src/templates/system_prompt.hbs
- Amp prompt leak collection: https://github.com/asgeirtj/system_prompts_leaks/blob/main/Misc/amp-code.md
- Gemini CLI prompt analysis: https://danicat.dev/posts/gemini-cli-system-prompt/
- Same model, different CLI comparison: https://lagindicator.com/dev-tools/same-model-different-cli/
- CLI coding-agent prompt comparison: https://blog.fsck.com/2025/06/26/system-prompts-for-cli-coding-agents/
- OpenCode vs Codex prompt-location notes: https://www.morphllm.com/comparisons/opencode-vs-codex
