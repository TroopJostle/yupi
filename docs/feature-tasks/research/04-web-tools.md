# Research: Web tools (web fetch + web search) in production coding-agent harnesses

## Summary

All major harnesses ship the same two-tool shape — a URL→cleaned-content "fetch" tool and a query→results "search" tool — but split into two architectures: local fetch pipelines with HTML→markdown conversion (Claude Code, Gemini CLI fallback mode, OpenCode) versus provider-hosted server-side tools (Claude Code WebSearch, Codex `web_search`, Gemini grounding/`urlContext`). Search is the hard part for a provider-agnostic harness: Claude Code and Codex get it "free" from their first-party APIs (unavailable on Bedrock/Vertex), while OpenCode delegates to remote MCP search providers (Exa, Parallel.ai) with API keys. Safety patterns converge on SSRF guards (private-IP/localhost blocking), per-URL caching (Claude Code: 15 min), size caps with truncation, cross-host-redirect surfacing, and prompt-injection mitigations (wrapper markers or a small "utility" model that summarizes fetched content before it reaches the main context).

## Findings by harness

### Claude Code (Anthropic)

Tools: `WebFetch(url, prompt)` and `WebSearch(query, allowed_domains[], blocked_domains[])`. Both require permission; both are built in.

**WebFetch — local pipeline, verified via runtime inspection** ([mikhail.io deep-dive](https://mikhail.io/2025/10/claude-code-web-tools/), Oct 2025):

1. URL validation/normalization: ~2000-char cap, HTTP upgraded to HTTPS, credentials stripped.
2. Domain safety preflight: backend call to `https://claude.ai/api/web/domain_info?domain=<hostname>` returning e.g. `{"domain":"mikhail.io","can_fetch":true}` ("The exact rules are opaque"). A Claude Code setting `skipWebFetchPreflight` exists: "Skip the WebFetch hostname check when Anthropic is unreachable" ([settings reference](https://code.claude.com/docs/en/settings-reference)).
3. Fetch with redirect policy: same-host redirects followed automatically; **cross-host redirects are NOT followed** — redirect metadata is returned and the agent must re-call the tool (trust-the-new-host gate). ~10 MB cap at fetch time.
4. HTML→markdown via the **Turndown** library; plain-text content types pass through unconverted.
5. Truncation to 100 KB of text (with warning) after conversion.
6. Summarization: a small fast model (observed: Haiku 3.5) with an empty system prompt answers the `prompt` parameter against the converted content, under safety rules (125-char quote cap, exact language in quotation marks, no lyrics). The main model sees only that answer — official docs confirm: WebFetch "converts the response to Markdown when the server returns HTML, and runs the prompt against the content using a small, fast model… This makes WebFetch lossy by design" ([tools reference](https://code.claude.com/docs/en/tools-reference)).
7. Cache: each URL cached with a **15-minute TTL**, not user-tunable.

Verbatim tool description (concise variant, leaked prompt archive v2.1.268, [Piebald-AI/claude-code-system-prompts](https://raw.githubusercontent.com/Piebald-AI/claude-code-system-prompts/main/system-prompts/tool-description-webfetch-concise.md)): "Fetches a URL, converts the page to markdown, and answers `prompt` against it using a small fast model. Fails on authenticated/private URLs." — "HTTP is upgraded to HTTPS." — "Cross-host redirects are returned to you rather than followed" — cache TTL is a template variable (`WEBFETCH_CACHE_TTL_FN()`), i.e. configurable build-time, not per-user. The description also says: fails on localhost and dotless hostnames (use curl/Bash for local servers); prefers MCP-provided fetch tools or `gh` for authenticated URLs; claude.ai artifact links are fetchable via the user's login when enabled. A leaked full system prompt (v2.0) corroborates: `url` (required, max 2000 chars), `prompt` (required), and a rule that the model "must instruct model to fetch its own URLs"-style guidance plus "self-cleaning 15-minute cache" ([x1xhlol leak archive](https://raw.githubusercontent.com/x1xhlol/system-prompts-and-models-of-ai-tools/main/Anthropic/Claude%20Code%202.0.txt)).

**WebSearch — Anthropic server-side tool** ([mikhail.io](https://mikhail.io/2025/10/claude-code-web-tools/)): Claude Code declares the Messages-API server tool (`web_search_20250305` and successors) and passes `allowed_domains`/`blocked_domains` through per call. The API returns results with `url`, `title`, `page_age`, `encrypted_content`, but Claude Code "only extracts title and url from the results" — the model must WebFetch pages it wants content from. Verbatim description (concise variant, v2.1.173, [Piebald-AI](https://raw.githubusercontent.com/Piebald-AI/claude-code-system-prompts/main/system-prompts/tool-description-websearch-concise.md)): "Search the web. Returns result blocks with titles and URLs. US-only." — "The current month is ${CURRENT_MONTH_YEAR} — use this when searching for recent information." — "`allowed_domains` / `blocked_domains` filter results." — "After answering from results, end with a 'Sources:' list of the URLs you used as markdown links."

Underlying API surface ([platform.claude.com web search tool docs](https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-search-tool)): server tool types `web_search_20250305` / `web_search_20260209` (dynamic filtering via auto-provisioned code execution) / `web_search_20260318` (`response_inclusion`); config params `max_uses`, `allowed_domains` XOR `blocked_domains` (bare domains, optional path), `user_location` (approximate: city/region/country/timezone); pricing **$10 per 1,000 searches** plus token costs; results are `server_tool_use` + `web_search_tool_result` blocks; multi-turn requires echoing back `encrypted_content`. The companion API [web fetch tool](https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-fetch-tool) (`web_fetch_20250910`+; `web_fetch_20260309` adds `use_cache` bypass) is server-side, takes only `url`, supports `max_uses`, `max_content_tokens`, domain filters, citations; "no additional charges beyond standard token costs"; does not support JS-rendered sites; fetches only URLs previously seen in user messages/tool results (anti-exfiltration).

**Permission/config surface**: permission rules `WebFetch(domain:example.com)` (domain specifier) and `WebSearch` (whole-tool only) ([tools reference](https://code.claude.com/docs/en/tools-reference)). WebSearch is hidden entirely on Bedrock/Vertex because the server tool isn't supported there ([mikhail.io](https://mikhail.io/2025/10/claude-code-web-tools/), [Anthropic Vertex docs](https://platform.claude.com/docs/en/build-with-claude/claude-on-vertex-ai)); third-party proxies such as LiteLLM add `websearch_interception` to execute Claude Code's `web_search` calls against Bedrock/Vertex or other backends ([LiteLLM tutorial](https://docs.litellm.ai/docs/tutorials/claude_code_websearch)). MCP-hosted search servers surface as `mcp__<server>__<tool>` tools and are the documented fallback pattern for non-first-party providers (naming convention per MCP integration docs; "(unverified)" for the exact `mcp__web-search` server name).

### ZCode (firsthand, authoritative for this project's contract)

ZCode (the orchestrator of this research session) implements both tools with semantics essentially identical to Claude Code's concise descriptions (clearly the lineage): `WebFetch(url, prompt)` fetches, converts page to markdown, answers `prompt` via a small fast model; HTTP→HTTPS upgrade; cross-host redirects returned to caller for re-call; 15-minute per-URL cache; fails on authenticated/private URLs. `WebSearch(query, allowed_domains[], blocked_domains[])` returns result blocks with titles and URLs; US-only; contract requires answers built from results to end with a "Sources:" markdown link list. (Firsthand tool-contract notes supplied by the orchestrator.)

### OpenAI Codex CLI

**Search only — no built-in fetch tool** (code search for `web_fetch` in openai/codex returns nothing; fetching is left to shell/sandbox networking).

`web_search` is a **hosted Responses-API tool**, not a function call. Source (all from the openai/codex repo):

- `codex-rs/tools/src/tool_spec.rs`: `ToolSpec::WebSearch` serializes as `{"type": "web_search", external_web_access, indexed_web_access, filters: {allowed_domains}, user_location, search_context_size, search_content_types}` — source comments link the OpenAI Responses web-search guide and explain: "`external_web_access` distinguishes cached from live-capable search, while `indexed_web_access` restricts live fetches to indexed URLs."
- `codex-rs/core/src/tools/hosted_spec.rs`: tool is only created for modes `Cached | Indexed | Live`; `Disabled` returns `None` (tool hidden).
- `codex-rs/protocol/src/config_types.rs`: `WebSearchMode { Disabled, Cached (default), Indexed, Live }`; `WebSearchToolConfig { context_size: low|medium|high, allowed_domains: Vec<String>, location {country, region, city, timezone} }`; merged config → `WebSearchConfig { filters, user_location, search_context_size }`.
- `codex-rs/config/src/config_toml.rs`: top-level `web_search = "<mode>"` ("Controls the web search tool mode: disabled, cached, indexed, or live") plus `[tools.web_search]` accepting either a legacy bool (`web_search = true`, added Aug 2025, [issue #2760](https://github.com/openai/codex/issues/2760)) or the config table (context_size, allowed_domains, location). `--search` CLI flag exists for the TUI (same issue).

Takeaways: the model emits no search query parameters itself beyond the implicit query; domain allowlists and locale are **config-level, not per-call**; "cached vs live" search is a cost/latency tier exposed to users; provider capability gating (`supports_search_tool` in model metadata, `codex-rs/protocol/src/openai_models.rs`) hides the tool for models that lack it.

### Gemini CLI (google-gemni/gemini-cli)

Two tools in `packages/core/src/tools/`: `web-search.ts` (`google_web_search`) and `web-fetch.ts` (`web_fetch`). Both delegate to **server-side Gemini API tools via "utility model" aliases**, both marked `Kind.Search` / `Kind.Fetch` for permission categorization, both output-markdown.

**Model aliases** (`packages/core/src/config/defaultModelConfigs.ts`): `'web-search'` = `gemini-3-flash-base` + `tools: [{ googleSearch: {} }]` (Search grounding); `'web-fetch'` = `gemini-3-flash-base` + `tools: [{ urlContext: {} }]`; `'web-fetch-fallback'` = plain flash model. So the "small fast model" is a current flash model with a server tool attached, invoked as `LlmRole.UTILITY_TOOL`.

`google_web_search` — params: `query` (required, only param). Sends the query as a plain generateContent request; returns a **synthesized, grounded summary** (not raw SERPs), post-processed to insert `[n]` citation markers at UTF-8 byte offsets from `groundingSupports` and append a `Sources:\n[1] title (uri)` list built from `groundingChunks` (`web-search.ts`). Verbatim description (`packages/core/src/tools/definitions/model-family-sets/default-legacy.ts`): "Performs a web search using Google Search (via the Gemini API) and returns the results. This tool is useful for finding information on the internet based on a query." Docs: "Returns a generated summary based on search results. Includes source URIs and titles for factual grounding" ([geminicli.com/tools/web-search](https://geminicli.com/docs/tools/web-search/)). No allow/block domain parameters.

`web_fetch` — default mode params: single `prompt` string containing **up to 20 URLs + instructions** (URLs parsed out with a `://` token heuristic; http/https only). Primary path: server-side urlContext model answers with citation markers and Sources list; output wrapped with `wrapUntrusted(...)`. **Fallback path** (API failure or blocked) is a full local pipeline (`web-fetch.ts`):

- Blocked hosts: `localhost`, `127.0.0.1`, `*.localhost`, `*.local`, `*.internal`, plus `isPrivateIp()` (RFC 1918) — SSRF guard.
- Rate limit: **10 requests/min/hostname** (LURC-timestamp history).
- GitHub blob→raw.githubusercontent.com URL rewriting before fetch.
- Fetch: 10 s timeout, streaming body reader with **10 MB hard cap** (`readResponseWithLimit`), custom User-Agent `Mozilla/5.0 (compatible; Google-Gemini-CLI/1.0; +https://github.com/google-gemini/gemini-cli)`, retry with backoff.
- Content-type dispatch: HTML → `html-to-text` `convert()` (NOT markdown; links dropped in fallback, kept in direct mode); text/plain, markdown, JSON pass through raw; images/video/PDF returned as base64 `inlineData` attachments.
- Budget: **250,000 chars total** across URLs with a water-filling allocation (smallest content first gets fair share; truncated with `... [Content truncated due to size limit] ...`); HTTP ≥400 responses return status + headers + 10 KB of body.
- Fetched content goes through the plain flash model with `<user_instructions>` + `<content>` XML wrapping, output again `wrapUntrusted`.

"Direct/experimental" mode (`getDirectWebFetch()` config) swaps the schema to `{url}` only ("Fetch content from a URL directly. Send multiple requests for this tool if multiple URL fetches are needed") and returns converted content straight to the main model — no summarizer. Confirmation: info dialog listing parsed URLs before any fetch; in plan mode always requires `ask_user` ([geminicli.com/docs/tools/web-fetch](https://geminicli.com/docs/tools/web-fetch/)). That docs page also documents the SSRF posture: resolved IPs screened to "restrict access to private, reserved, loopback, and internal networks", "transport connections are pinned to the resolved destination IP address" (anti-DNS-rebinding). Verbatim description (default-legacy.ts): "Processes content from URL(s)… Include up to 20 URLs and instructions (e.g., summarize, extract specific data) directly in the 'prompt' parameter." (Note drift: the description claims localhost/private addresses work, but the code blocks them.)

### OpenCode (sst/opencode)

Both tools built in (`packages/opencode/src/tool/webfetch.ts`, `websearch.ts`) — verified from source.

`webfetch` — direct local fetch, **no summarizer model** (full content returned to the main model):

- Params: `url` (required), `format` = `markdown` (default) | `text` | `html`, `timeout` seconds (default 30, max 120).
- Permission: `ctx.ask({ permission: "webfetch", patterns: [url], always: ["*"] })` — URL-pattern-scoped permission prompt.
- Sends browser User-Agent (Chrome 143) + format-weighted `Accept` header; **on Cloudflare challenge (403 + `cf-mitigated: challenge` header) retries once with honest User-Agent `opencode`** (TLS-fingerprint mismatch workaround).
- 5 MB response cap (content-length check + buffer check). Images detected by MIME → base64 attachment.
- HTML→markdown via **Turndown** configured `{headingStyle: "atx", hr: "---", bulletListMarker: "-", codeBlockStyle: "fenced", emDelimiter: "*"}` with `turndownService.remove(["script", "style", "meta", "link"])`. `text` format uses an htmlparser2 streaming extractor that skips `script/style/noscript/iframe/object/embed` trees.
- Description file (`webfetch.txt`): "Fetches content from a specified URL… converts to requested format (markdown by default)… HTTP URLs will be automatically upgraded to HTTPS" (description claim; the code shown only enforces the http/https scheme check), "Results may be summarized if the content is very large" (no summarizer in code — description drift).
- Notably **no SSRF/private-IP blocking and no cache** in this implementation.

`websearch` — **no first-party search engine; delegates to remote MCP search providers** (`mcp-websearch.ts`): Exa (`https://mcp.exa.ai/mcp`, auth via `EXA_API_KEY` env) and Parallel (`https://search.parallel.ai/mcp`). Calls are raw JSON-RPC `tools/call` POSTs with 25 s timeout, parsing either JSON or SSE responses. Provider selection: `OPENCODE_WEBSEARCH_PROVIDER` env override, runtime flags, else **per-session 50/50 A/B split** via `checksum(sessionID) % 2`. Params: `query`, `numResults` (default 8), `livecrawl` = fallback|preferred, `type` = auto|fast|deep, `contextMaxCharacters` (default 10000) — all Exa-MCP-shaped. Permission: `ctx.ask({ permission: "websearch", patterns: [query], ... })`. Description injects the current year: "The current year is {{year}}. You MUST use this year when searching for recent information or current events" (mirrors Claude Code's `CURRENT_MONTH_YEAR`).

## Fetch-pipeline landscape

**HTML→markdown/extraction libraries:**

- [Turndown](https://github.com/domchristie/turndown) — DOM-based HTML→markdown converter; the de-facto choice (Claude Code per [mikhail.io](https://mikhail.io/2025/10/claude-code-web-tools/), OpenCode per source above). Needs a DOM (browser, jsdom, linkedom, cheerio's domhandler). Simple, deterministic, keeps structure (links, code, tables via plugin) but keeps *all* content — boilerplate/nav included unless you `remove()` selectors.
- [html-to-text](https://github.com/html-to-text/node-html-to-text) — HTML→plain text with selector options (used by Gemini CLI). Cheaper signal, loses links/structure by default.
- [Mozilla Readability](https://github.com/mozilla/readability) — article-extraction (Firefox Reader View): scores text density to keep only main content, returns cleaned HTML + title/byline. Needs jsdom/linkedom; convert to markdown after with Turndown. Best for prose pages, can over-trim on docs/tables.
- [Defuddle](https://github.com/kepano/defuddle) — newer extractor by Obsidian's founder ("created for the browser extension Obsidian Web Clipper"); "cleans up web pages by removing clutter" (comments, sidebars, nav, ads, hidden elements, low-scoring blocks); positioned as a Readability replacement: "more forgiving, removes fewer uncertain elements", "uses a page's mobile styles to guess at unnecessary elements", extracts schema.org metadata, and the Node bundle outputs **markdown directly** (`Defuddle(doc, url, { markdown: true })`). MIT, zero-dep core.
- Hosted readers exist as an ops-free alternative (e.g. [Jina Reader](https://jina.ai/reader/) `r.jina.ai`, [Firecrawl](https://www.firecrawl.dev/)) — external dependency/cost, out of scope for a built-in tool but relevant as fallback design (Gemini CLI's server-first/local-fallback pattern is the in-tree analog).

**Script stripping:** every pipeline removes `script`/`style` at minimum; OpenCode also strips `meta`/`link` elements and `noscript/iframe/object/embed` subtrees; Gemini CLI drops images in fallback mode. None of the reviewed implementations execute JS.

**Robots/ToS:** none of the four reviewed implementations checks robots.txt or rate-limit headers (observation from reviewed sources; "(unverified)" as a general claim beyond them). Search backends (Google via grounding, Brave, Exa) handle ToS on their side; a local fetcher that identifies as a browser UA (OpenCode) is in a grayer area than an honest product UA (Gemini CLI).

**Caching patterns:** per-URL TTL cache in-process (Claude Code: 15 min, keyed by URL, not tunable; ZCode firsthand: same). Anthropic's hosted web fetch caches server-side with explicit `use_cache: false` bypass ([docs](https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-fetch-tool)). Gemini CLI/OpenCode: no cache, but Gemini adds per-host rate limiting (10/min) which partially covers the same abuse case.

**Truncation/token budgets:** byte cap at fetch (10 MB Claude/Gemini, 5 MB OpenCode) then post-conversion truncation (Claude: 100 KB; Gemini: 250 k chars total with water-filling across multiple URLs; OpenCode: none — relies on the model's own context). Gemini's water-filling is the only multi-URL budget allocator seen.

## Gaps and pitfalls

- **Auth walls**: every harness's fetch fails on authenticated/private URLs by design; the standard escape hatch is an authenticated MCP tool or `gh` (Claude Code says this in its tool description; ZCode firsthand ditto).
- **JS-rendered pages**: Anthropic's hosted fetch explicitly "does not support websites dynamically rendered with JavaScript" ([docs](https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-fetch-tool)); local fetchers get SPA shells. OpenCode's Cloudflare `cf-mitigated` retry is a narrow band-aid. Full fix needs a headless browser (separate tool; Claude Code suggests its browser-use tool).
- **SSRF/local network**: Gemini CLI's guard list (localhost, `.local`, `.internal`, RFC 1918, DNS-resolution pinning) is the most complete; OpenCode has none. Cross-host-redirect *surfacing* (Claude Code, ZCode) prevents the "public URL redirects to intranet" trick but only if private-host checks still run on the re-called URL.
- **Prompt injection via fetched content**: fetched pages can contain instructions. Mitigations observed: route through a pinned utility model (Claude Haiku gate; Gemini flash wrapper), wrap output in untrusted markers (Gemini `wrapUntrusted`), and Anthropic's URL-provenance rule (server fetch only follows URLs already seen in user messages/prior results, with a documented data-exfiltration warning). OpenCode returns raw content with no wrapper — weakest posture.
- **Search costs and keys**: Anthropic server search is $10/1k searches; Gemini grounding is free-tier-available but Google-account-bound; Exa/Parallel (OpenCode) need `EXA_API_KEY` or a hosted MCP. A provider-agnostic harness must treat the search backend as a pluggable, keyed dependency.
- **Provider availability gaps**: Claude Code's WebSearch disappears on Bedrock/Vertex; Codex gates on model metadata (`supports_search_tool`); any pi design that relies on provider-native search tools needs a capability check plus fallback.
- **Locale/staleness**: search results are US-only in Claude Code/ZCode; the 15-min fetch cache can serve stale data for frequently-changing endpoints (a documented user complaint — "[microservices.io on migrating off WebFetch](https://microservices.io/post/deployment-pipeline/2026/07/17/from-webfetch-to-circleci-cli-lessons-learned.html)").
- **Lossiness**: summarize-then-answer fetch tools can miss content the prompt didn't ask about ("WebFetch is lossy by design", [Claude Code tools reference](https://code.claude.com/docs/en/tools-reference)); the fix pattern is a "raw content" mode (Gemini directWebFetch, OpenCode default) or `curl` via bash.

## Design takeaways for pi

- **Two tools, fetch-first**: implement `web_fetch(url, prompt)` as a local pipeline pi fully owns (undici + Turndown or Defuddle; script/style stripping; content-type passthrough for markdown/plain/JSON), with the `prompt` answered by a small/cheap model routed through `packages/ai` — this keeps it provider-agnostic (works with Zhipu/GLM as the utility model) and mirrors the Claude Code/ZCode contract the models are already trained on (HTTPS upgrade, cross-host redirect returned to caller, authenticated-URL failure).
- **Search needs a pluggable backend**: pi has no first-party search API. Options in increasing effort: (1) provider-native server tools when the active provider supports them (Anthropic `web_search_*`, OpenAI Responses `web_search`, Gemini `googleSearch`) behind a capability flag in `packages/ai`; (2) a keyed HTTP search API (Brave/Exa/Tavily) as the default cross-provider backend — OpenCode's pattern of provider selection + `OPENCODE_WEBSEARCH_PROVIDER`-style override + env key is proven and small; (3) remote MCP search servers as an extension-level backend rather than core.
- **Keep the search output contract model-friendly**: return title+URL blocks (not full page content), keep `allowed_domains`/`blocked_domains` as per-call params (Claude Code) and optionally config-level allowlists (Codex `[tools.web_search]`), and keep the "end with Sources: markdown links" instruction — it is part of the prompt contract all these models already know.
- **Safety checklist for fetch**: SSRF guard (localhost, dotless hosts, `.local`/`.internal`, RFC 1918 resolution check), per-host rate limit (Gemini's 10/min is a sane default), byte cap at fetch + post-conversion truncation (e.g. 5 MB / 100–250 KB), GitHub blob→raw rewriting, and wrap untrusted content (Gemini's `wrapUntrusted`-style marker) even when a utility model summarizes.
- **Caching**: per-URL in-memory TTL cache (15 min default) keyed on normalized URL; expose TTL and a bypass (Anthropic's `use_cache: false` analog) since API-endpoint fetching is a real use case that staleness breaks.
- **Permission classification**: treat both as network/read-only tools that require a permission prompt. Fetch maps naturally to pi's pattern rules with a `domain:` specifier (Claude Code's `WebFetch(domain:example.com)`); search is whole-tool (optionally query-pattern like OpenCode). Gemini's `Kind.Fetch`/`Kind.Search` categories are the same idea.
- **Config surface**: keys for search provider + API key (env), cache TTL, max bytes/chars, default domain filters, optional direct/raw fetch mode (skip the summarizer — Gemini's `directWebFetch` and OpenCode's whole design show raw content is often preferable for coding tasks), and a `CURRENT_MONTH_YEAR`-style date injection in the search tool description (Claude Code and OpenCode both do this to fix stale-date queries).
- **Injection defense in depth**: prefer the utility-model gate for `prompt`-based fetches, but when returning raw content, mark it untrusted in the tool result and document that pi's agent prompt should treat fetched web content as data, not instructions.

## Sources

- https://mikhail.io/2025/10/claude-code-web-tools/ (Claude Code WebFetch/WebSearch runtime internals)
- https://code.claude.com/docs/en/tools-reference (official Claude Code tools reference)
- https://code.claude.com/docs/en/settings-reference (skipWebFetchPreflight)
- https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-search-tool (Anthropic web search server tool)
- https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-fetch-tool (Anthropic web fetch server tool)
- https://platform.claude.com/docs/en/build-with-claude/claude-on-vertex-ai (server tools unavailable on Vertex/Bedrock)
- https://raw.githubusercontent.com/Piebald-AI/claude-code-system-prompts/main/system-prompts/tool-description-webfetch-concise.md (verbatim WebFetch description v2.1.268)
- https://raw.githubusercontent.com/Piebald-AI/claude-code-system-prompts/main/system-prompts/tool-description-websearch-concise.md (verbatim WebSearch description v2.1.173)
- https://raw.githubusercontent.com/x1xhlol/system-prompts-and-models-of-ai-tools/main/Anthropic/Claude%20Code%202.0.txt (leaked Claude Code system prompt with tool schemas)
- https://docs.litellm.ai/docs/tutorials/claude_code_websearch (websearch_interception proxy pattern)
- https://github.com/openai/codex/issues/2760 (web_search = true config key history)
- https://github.com/openai/codex — codex-rs/tools/src/tool_spec.rs, codex-rs/core/src/tools/hosted_spec.rs, codex-rs/protocol/src/config_types.rs, codex-rs/protocol/src/openai_models.rs, codex-rs/config/src/config_toml.rs (source-verified via GitHub contents API)
- https://geminicli.com/docs/tools/web-search/ (google_web_search reference)
- https://geminicli.com/docs/tools/web-fetch/ (web_fetch reference)
- https://geminicli.com/docs/cli/tutorials/web-tools/ (web tools tutorial)
- https://ai.google.dev/gemini-api/docs/url-context (Gemini URL context API)
- https://github.com/google-gemini/gemini-cli — packages/core/src/tools/web-fetch.ts, packages/core/src/tools/web-search.ts, packages/core/src/tools/definitions/model-family-sets/default-legacy.ts, packages/core/src/config/defaultModelConfigs.ts (source-verified via GitHub contents API)
- https://github.com/sst/opencode — packages/opencode/src/tool/webfetch.ts, webfetch.txt, websearch.ts, websearch.txt, mcp-websearch.ts (source-verified via GitHub contents API)
- https://github.com/domchristie/turndown (Turndown)
- https://github.com/html-to-text/node-html-to-text (html-to-text)
- https://github.com/mozilla/readability (Mozilla Readability)
- https://github.com/kepano/defuddle (Defuddle)
- https://microservices.io/post/deployment-pipeline/2026/07/17/from-webfetch-to-circleci-cli-lessons-learned.html (15-min cache staleness complaint)
- https://www.firecrawl.dev/blog/claude-web-fetch-vs-firecrawl (15-min cache not tunable; comparison)
