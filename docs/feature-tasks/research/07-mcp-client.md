# Research dossier 07: MCP client support in coding-agent harnesses

Scope: how harnesses configure/spawn MCP servers (stdio + HTTP), discover tools/resources/prompts, and map them into a native tool registry. Consumer: implementation spec for pi MCP client support. pi today has no MCP support; its extensibility is the TypeScript extension system (`packages/coding-agent/src/core/extensions/types.ts` — `ToolDefinition` with TypeBox `TSchema` params, `registerTool`, event lifecycle, `project_trust`, settings with `SettingsScope = "global" | "project"` in `settings-manager.ts`).

## Summary

Every harness surveyed (Claude Code, Codex CLI, Gemini CLI, OpenCode) implements MCP with the same skeleton: a declarative server list in config (command/args/env for stdio, url/headers for Streamable HTTP), spawn-or-connect at startup with per-server startup/tool timeouts, `initialize` handshake + `tools/list` discovery, and registration of each remote tool as a native tool under a server-prefixed name with a plain JSON-Schema parameter definition. The MCP spec is in flux: the latest revision (2026-07-28) removes the initialize handshake and sessions entirely (stateless, `_meta`-carried version/capabilities), while most deployed servers still speak the 2025-06-18 handshake flow, so a client must pick (or negotiate) a protocol version deliberately. The official TypeScript SDK now ships as v2 (`@modelcontextprotocol/client`, spec 2026-07-28, Node >= 20) alongside v1 (`@modelcontextprotocol/sdk` 1.30.0, handshake-based, Node >= 18 but heavy deps: express, hono, cors, ajv); a minimal hand-rolled JSON-RPC client for stdio + HTTP POST is small enough (~600-900 lines) that it is a credible option for pi given its exact-pinned-dep and shrinkwrap-review constraints.

## MCP protocol essentials

Spec versions (newest first): **2026-07-28 (current latest)**, 2025-11-25, 2025-06-18, 2025-03-26, 2024-11-05 (https://modelcontextprotocol.io/llms.txt). Two client generations matter:

### 2025-06-18 .. 2025-11-25 (handshake-based; what most deployed servers speak)

Source: https://modelcontextprotocol.io/specification/2025-06-18/basic/lifecycle , .../basic/transports , .../server/tools

- Wire format: JSON-RPC 2.0, UTF-8. Messages on stdio are newline-delimited and MUST NOT contain embedded newlines.
- Lifecycle: client sends `initialize` request with `params.protocolVersion`, `params.capabilities` (client: `roots`, `sampling`, `elicitation`, `experimental`), and `params.clientInfo {name, title, version}`; server replies with its `capabilities` (server: `tools {listChanged}`, `resources {subscribe, listChanged}`, `prompts {listChanged}`, `logging`, `completions`), `serverInfo`, and optional `instructions` (server-wide guidance text for the LLM — Codex surfaces this into the model context, see below). Client then sends `notifications/initialized`.
- Version negotiation: client sends the latest version it supports; if unsupported, server responds with a version it supports; if the client cannot accept that, it SHOULD disconnect.
- Discovery: `tools/list` (paginated via `params.cursor` / `result.nextCursor`) returns `tools[]` with `name`, `title`, `description`, `inputSchema` (JSON Schema object, defaults to 2020-12 dialect in later revisions), optional `outputSchema`, `annotations` (`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint` — treated as untrusted hints). `resources/list` + `resources/read`, `prompts/list` + `prompts/get` are analogous capabilities.
- Invocation: `tools/call` with `params.name` and `params.arguments`; result carries `content[]` (types: `text`, `image` (base64 + mimeType), `audio`, `resource_link`, embedded `resource`), optional `structuredContent` (JSON value conforming to `outputSchema`), and `isError` (tool-execution error the model can self-correct from; distinct from JSON-RPC protocol errors).
- Change notification: server MAY emit `notifications/tools/list_changed` if it declared `listChanged`; client re-issues `tools/list`.
- Timeouts: implementations SHOULD set per-request timeouts and then send a cancellation notification (`notifications/cancelled`); MAY reset the clock on progress notifications (`notifications/progress`).
- stdio transport: client spawns the server as a subprocess; JSON-RPC on stdin/stdout; stderr is for logs (client MAY capture/forward/ignore). Shutdown: close stdin → wait → SIGTERM → wait → SIGKILL.
- Streamable HTTP transport: single MCP endpoint (e.g. `https://example.com/mcp`); every JSON-RPC message is an HTTP POST with `Accept: application/json, text/event-stream`; the server answers either a single JSON body or an SSE stream (client MUST support both); optional GET SSE stream for server-initiated messages (server MAY instead return 405). Session management: server MAY return `Mcp-Session-Id` on the initialize response; the client MUST echo it on all subsequent requests; on 404 the client MUST re-initialize; client SHOULD DELETE the endpoint to terminate the session. Client MUST send `MCP-Protocol-Version: <version>` on subsequent requests (server assumes `2025-03-26` if absent). SSE resumability via `Last-Event-ID` is optional (MAY).
- Backwards compatibility fallback to the deprecated 2024-11-05 HTTP+SSE transport: POST initialize; on 4xx, GET expecting an `endpoint` event, then use the old transport.

### 2026-07-28 (current latest; stateless rewrite)

Source: https://modelcontextprotocol.io/specification/latest/changelog (renders the 2026-07-28 changelog)

Major breaks a new client should know about, even if it targets an older version for compatibility:

1. Removes protocol-level sessions and `Mcp-Session-Id`; state is expressed via server-minted handles passed as ordinary tool arguments.
2. Removes the `initialize`/`notifications/initialized` handshake. Every request carries protocol version and client capabilities in `_meta` (`io.modelcontextprotocol/protocolVersion`, `.../clientCapabilities`, `.../clientInfo`); servers identify themselves in each result's `_meta`.
3. Adds `server/discover`: servers MUST implement it; clients MAY use it as an up-front version probe or compat check.
4. Replaces HTTP GET SSE + `resources/subscribe` with `subscriptions/listen` (single long-lived POST-response stream; opt-in per notification type).
5. Removes `ping`, `logging/setLevel`, `notifications/roots/list_changed`.
6. Multi Round-Trip Requests (MRTR): servers return `InputRequiredResult` (`resultType: "input_required"` with `inputRequests`, e.g. `elicitation/create`); client retries the original request with `inputResponses`. All results carry `resultType: "complete" | "input_required"`.
7. Removes SSE resumability/`Last-Event-ID`; a broken stream loses the request; the client re-issues with a new JSON-RPC id.
8. Roots, Sampling, and Logging features are formally **deprecated** for new implementations (SEP-2577). DCR (RFC 7591) is deprecated in favor of Client ID Metadata Documents.
9. Tool naming guidance: names SHOULD be 1-128 chars, `[A-Za-z0-9_.-]`, case-sensitive, unique per server. Uniqueness is per-server, so aggregating clients "SHOULD implement a disambiguation strategy such as prefixing tool names with a server identifier"; `serverInfo.name` is not guaranteed unique and SHOULD NOT be relied on. (https://modelcontextprotocol.io/specification/2026-07-28/server/tools)
10. Optional `ttlMs`/`cacheScope` caching hints on list results; servers SHOULD return tools deterministically to improve client caching and LLM prompt-cache hit rates.

### Tool-count scaling guidance (official client best practices)

Source: https://modelcontextprotocol.io/docs/2026-07-28/develop/clients/client-best-practices

- Naive hosts that inject every tool definition into context can burn ~150,000 tokens on definitions alone; recommended switch threshold to "progressive discovery" (search_tools → get_tool_details → execute meta-tools) is 1-5% of the context window.
- Cache tool definitions host-side; re-index on `list_changed`; group tools by server.
- Prompt-cache interaction: mutating the `tools` array mid-conversation invalidates provider prompt caches; append after cache breakpoints or route through a stable `call_tool({name, args})` meta-tool.

## Findings by harness

### Claude Code (Anthropic)

Sources: https://code.claude.com/docs/en/mcp , https://code.claude.com/docs/en/permissions , https://code.claude.com/docs/en/settings

- Commands: `claude mcp add --transport http <name> <url>` (e.g. `claude mcp add --transport http notion https://mcp.notion.com/mcp`); stdio via `claude mcp add --env AIRTABLE_API_KEY=YOUR_KEY --transport stdio airtable -- npx -y airtable-mcp-server` (the `--` separator keeps server flags away from the CLI). `--transport` accepts `stdio | http | sse` (sse deprecated: HTTP tried first with fallback). Also `claude mcp add-json`, `claude mcp list`, `claude mcp get`, `claude mcp login <name>`, `claude mcp logout <name>`, `claude mcp reset-project-choices`.
- Scopes: `--scope local` (default; per-project, private, stored in `~/.claude.json` under the project path), `--scope project` (checked-in `.mcp.json` at repo root), `--scope user` (all projects, `~/.claude.json`). Precedence local > project > user > plugins > claude.ai connectors; whole winning entry used, no field merging. Project-scope servers prompt for approval at startup in interactive sessions.
- `.mcp.json` verbatim example:
  ```json
  {
    "mcpServers": {
      "shared-server": {
        "type": "http",
        "url": "https://example.com/mcp"
      }
    }
  }
  ```
  Stdio entries use `command` / `args` / `env` (e.g. `"command": "npx", "args": ["-y", "@example/mcp-server"]`); remote entries `type` (`"http"`, alias `"streamable-http"`, `"sse"`, `"ws"`), `url`, `headers` (e.g. `"Authorization": "Bearer ${API_KEY}"`), optional `oauth` object (`clientId`, `callbackPort`, `authServerMetadataUrl`, `scopes`), `timeout`, `headersHelper`. `${VAR}` and `${VAR:-default}` expansion in command/args/env/url/headers. A `url` entry without `type` is treated as stdio and skipped (config error).
- OAuth: servers returning 401/403 are flagged as needing auth; sign-in via `/mcp` in-session (browser flow) or `claude mcp login`; `--no-browser` for headless; tokens stored securely and auto-refreshed (on 401: refresh, reconnect, retry once). Non-DCR servers: `--client-id`, `--client-secret`, `--callback-port` (loopback redirect `http://localhost:PORT/callback`).
- `/mcp` in-session: server health (connected / failed / cached / needs authentication), tool counts, OAuth sign-in, Reconnect, Clear auth, toggle server off without removing.
- Namespacing: MCP tools are exposed to the model/permissions as `mcp__<server>__<tool>`. Verbatim permission-rule examples: `"mcp__*"` (deny every MCP tool), `"mcp__puppeteer"` and `"mcp__puppeteer__*"` (all tools of a server), `"mcp__puppeteer__puppeteer_navigate"` (one tool), `"mcp__github__get_*"` (glob after a literal `mcp__<server>__` prefix only). Deny rules remove matched tools from the model context entirely.

### OpenAI Codex CLI

Sources: https://learn.chatgpt.com/docs/extend/mcp?surface=cli (canonical MCP page; developers.openai.com/codex/* 308-redirects there), https://learn.chatgpt.com/docs/config-file/config-reference . The in-repo `docs/config.md` on github.com/openai/codex now only links out to these pages.

- Config: `~/.codex/config.toml` (global) or `.codex/config.toml` (project, trusted projects only); shared by CLI, IDE extension, and ChatGPT desktop app. Servers under `[mcp_servers.<name>]`.
- stdio verbatim example:
  ```toml
  [mcp_servers.context7]
  command = "npx"
  args = ["-y", "@upstash/context7-mcp"]
  env_vars = ["LOCAL_TOKEN"]

  [mcp_servers.context7.env]
  MY_ENV_VAR = "MY_ENV_VALUE"
  ```
- HTTP verbatim examples:
  ```toml
  [mcp_servers.figma]
  url = "https://mcp.figma.com/mcp"
  bearer_token_env_var = "FIGMA_OAUTH_TOKEN"
  http_headers = { "X-Figma-Region" = "us-east-1" }

  [mcp_servers.chrome_devtools]
  url = "http://localhost:3000/mcp"
  enabled_tools = ["open", "screenshot"]
  disabled_tools = ["screenshot"] # applied after enabled_tools
  default_tools_approval_mode = "prompt"
  startup_timeout_sec = 20
  tool_timeout_sec = 45
  enabled = true

  [mcp_servers.chrome_devtools.tools.open]
  approval_mode = "approve"
  output_token_limit = 30000
  ```
- Per-server options: `command`/`args`/`env`/`cwd`/`env_vars` (allowlist forwarding; `{ name, source = "local"|"remote" }`) for stdio; `url`, `bearer_token_env_var`, `http_headers`, `env_http_headers`, `http_headers_helper` (local command printing a JSON header map; cached, refreshed once after same-origin 401/403), `auth = oauth|chatgpt` for HTTP. Shared: `startup_timeout_sec` (default 10; `startup_timeout_ms` alias), `tool_timeout_sec` (default 60), `enabled` (default true), `required` (fail startup if the server cannot initialize), `enabled_tools`/`disabled_tools` allow/deny lists, `default_tools_approval_mode` (`auto | prompt | writes | approve`; `writes` prompts for non-read-only tools), per-tool `tools.<tool>.approval_mode` and `tools.<tool>.output_token_limit` (per-tool output token budget before a standard 20% serialization allowance). Global `mcp_optional_startup_grace_ms` (default 1000) bounds the wait for optional servers while building the initial tool catalog.
- Lifecycle: servers spawn/connect at session startup; TUI `/mcp` shows active servers; `codex mcp add <name> --env VAR=VAL -- <cmd>` and `codex mcp login <name>` for OAuth. `--oauth-client-registration cimd|dcr` (auto default): CIMD (Client ID Metadata Documents) chosen when the server advertises `client_id_metadata_document_supported: true` etc., otherwise DCR; validates `iss` on responses; `mcp_oauth_callback_port` / `mcp_oauth_callback_url` global overrides.
- Server `instructions` from initialize are surfaced to the model; guidance says keep the first 512 chars self-contained.
- Plugin-provided MCP servers exist (plugin manifests bundle servers; user config controls enable/tool policy under `plugins.<plugin>.mcp_servers.<server>`) — the closest thing to "MCP apps" in current docs.
- Tool naming to the model: not documented verbatim on these pages (unverified; historically Codex exposed server tools under a `server__tool`-style qualified name — treat as unverified).

### Gemini CLI (google-gemini/gemini-cli)

Source: https://raw.githubusercontent.com/google-gemini/gemini-cli/main/docs/tools/mcp-server.md

- Config: `mcpServers` map in `~/.gemini/settings.json` (user) or `.gemini/settings.json` (project); one of `command` (stdio), `url` (SSE), or `httpUrl` (streaming HTTP) required. Env expansion `$VAR`/`${VAR}` (and `%VAR%` on Windows). `timeout` is the request timeout in ms, default 600,000 (10 min).
- Trust/confirmation: every MCP tool call shows a Y/N-style dialog ("Proceed once", "Always allow this tool", "Always allow this server", "Cancel") unless `"trust": true` for the server bypasses all confirmations. Allow-lists persisted at server and `serverName.toolName` granularity. `includeTools` allowlist / `excludeTools` denylist (exclude wins).
- Namespacing: fully-qualified tool names are `mcp_{serverName}_{toolName}` (sanitized; >63 chars truncated); documented pitfall: avoid underscores in server names — the permission parser splits FQNs on the first underscore after `mcp_`, so `my_server` breaks wildcard/security rules.
- OAuth: `authProviderType` (`google_credentials`, `service_account_impersonation` + `targetAudience`/`targetServiceAccount`, `dynamic_discovery` default) or an `oauth` object (`issuer`, `enabled`, `clientId`, `authorizationUrl`, `tokenUrl`, `scopes`, `redirectUri`); also `.gemini/mcp.json` and `mcp_config.json` for standard-MCP-client interop.
- `/mcp` shows status (CONNECTED / CONNECTING / DISCONNECTED), config summaries (redacted), per-server tool lists; `/mcp auth <name>`, `/mcp enable|disable <name>` (session-scoped). Shell: `gemini mcp add|list|remove|enable|disable` with `-t/--transport`, `-e/--env`, `-H/--header`, `--trust`, `--include-tools`, `--exclude-tools`. Startup errors are quiet by default with a "Run /mcp list" hint.

### OpenCode (sst/opencode)

Source: https://opencode.ai/docs/mcp-servers/

- Config: top-level `mcp` key in `opencode.json`/`opencode.jsonc`. Local (stdio) verbatim example keys: `"type": "local"`, `"command": ["npx", "-y", "my-mcp-command"]`, `"enabled": true`, `"environment": { "MY_ENV_VAR": "my_env_var_value" }`; plus `cwd`, `timeout` (ms for tool fetching, default 5000). Remote verbatim keys: `"type": "remote"`, `"url": "https://my-mcp-server.com"`, `"enabled": true`, `"headers": { "Authorization": "Bearer MY_API_KEY" }`; headers support `{env:MY_API_KEY}` interpolation; remote also supports `oauth` (object or `false`).
- Namespacing: "MCP server tools are registered with server name as prefix, so to disable all tools for a server simply use `"mymcpservername_*": false`" — i.e. `servername_toolname` with glob permission keys under the global `tools` map and per-agent `tools` overrides (`*` and `?` globs).
- OAuth: automatic on 401 — Dynamic Client Registration (RFC 7591), tokens stored in `~/.local/share/opencode/mcp-auth.json`; pre-registered clients via `oauth.clientId`/`clientSecret`/`scope`; `"oauth": false` disables. CLI: `opencode mcp auth|list|logout|debug <name>`.
- MCP prompts are surfaced by name ("use sentry", "use context7"). Orgs can push default server configs via a `.well-known/opencode` endpoint (local config must opt in with `enabled: true`).

### ZCode (firsthand, observed surface only)

- MCP server tools appear to the model as native tools named `mcp__<server>__<tool>` (e.g. `mcp__computer-use__screenshot`, `mcp__web_reader__webReader`, `mcp__node_repl__js`), each with a full JSON-schema parameter definition and a long usage-contract description — same convention as Claude Code. Official plugins (browser-use, computer-use, document-skills) ship as bundles combining MCP tools + skills. (firsthand)

## SDK/build options for pi

### Option A: official SDK v1 — `@modelcontextprotocol/sdk`

- Latest 1.30.0, MIT license, Node >= 18 (npm registry, https://www.npmjs.com/package/@modelcontextprotocol/sdk). Implements the handshake-based protocol (2025-11-25-era with compat).
- Client API: `Client` class with `listTools`, `callTool`, `listPrompts`, `getPrompt`, `listResources`, `readResource`; transports `StdioClientTransport` (spawn: `{command, args, env, cwd, stderr}`; `connect()` calls `transport.start()`, spawning the child) and `StreamableHTTPClientTransport`, plus deprecated `SSEClientTransport` with a documented fallback pattern (try Streamable HTTP, fall back to SSE on 4xx). Source: https://github.com/modelcontextprotocol/typescript-sdk/blob/v1.x/docs/client.md .
- Dependency footprint is large for a client-only consumer: ajv, ajv-formats, zod (3.25 || 4), cors, hono, express 5, raw-body, jose, cross-spawn, eventsource, content-type, pkce-challenge, json-schema-typed, eventsource-parser, express-rate-limit, zod-to-json-schema, @hono/node-server — because server and client ship in one package. v1.x is in maintenance ("fixes for at least 6 months after v2's release" per README on main).
- Some parts (JWT client auth via jose) rely on `globalThis.crypto`.

### Option B: official SDK v2 — `@modelcontextprotocol/client`

- 2.0.0 (stable), MIT, Node >= 20, tied to the 2026-07-28 stateless spec. Deps: `zod ^4.2.0`, `jose`, `cross-spawn`, `eventsource`, `pkce-challenge`, `eventsource-parser`, and `@modelcontextprotocol/core` (npm registry, https://www.npmjs.com/package/@modelcontextprotocol/client). Schemas use "Standard Schema" (Zod v4 / Valibot / ArkType), not Zod exclusively. Significantly slimmer than v1, but targets the newest spec generation; interop with the large installed base of handshake servers depends on the core's compat handling — verify against real servers before committing (unverified).

### Option C: hand-rolled minimal client

- For 2025-06-18 stdio: spawn child, newline-delimited JSON-RPC 2.0 over stdin/stdout (readline), a pending-request map keyed by numeric id, `initialize` → `notifications/initialized` → `tools/list` (with cursor pagination loop) → `tools/call`. Shutdown = stdin.end() → SIGTERM → SIGKILL per spec.
- For Streamable HTTP: fetch POST per message with `Accept: application/json, text/event-stream`; parse either a JSON body or an SSE stream (server-sent events can be parsed with a small state machine; `eventsource-parser` is the one dep worth pinning); echo `Mcp-Session-Id` and `MCP-Protocol-Version` headers; DELETE to terminate.
- Estimated ~600-900 lines including OAuth-less auth via static headers. Matches pi constraints: no new heavy deps, full control of timeouts/cancellation, nothing that emits non-erasable TS (deps ship prebuilt JS so pi's erasable-syntax rule applies only to pi's own `src/`, but every direct dep must still be exact-pinned and pass shrinkwrap review — see AGENTS.md: lifecycle-script allowlist in `scripts/generate-coding-agent-shrinkwrap.mjs`).
- Cost: pi owns protocol-version negotiation, cancellation notifications, progress notifications, `list_changed` handling, and OAuth if ever needed (PKCE + DCR is the expensive part; static `Authorization` headers from env vars cover most stdio/header-auth servers and are what Gemini/OpenCode minimal paths do).

### pi-specific constraints

- Erasable TS only in `packages/*/src` (no enums/namespaces/parameter-properties) — relevant only if vendoring/porting SDK code; importing an npm dep is unaffected.
- Top-level imports only (no `await import()`), so transports must be statically imported or selected via a factory function.
- Tool params in pi are TypeBox `TSchema`, which is JSON Schema — an MCP `inputSchema` (plain JSON Schema 2020-12) can be wrapped as-is (`Type.Unsafe`/cast) but validation should use a JSON-Schema validator or Value.Check with care: MCP allows keywords ($ref, composition) that TypeBox's Value module may not fully handle; safest is to pass the schema through and validate arguments with the same JSON-Schema machinery pi uses for provider-side constrained sampling, or skip local re-validation and let the server reject (Codex/Gemini do client-side light validation only).

## Gaps and pitfalls

- **Spec churn / version skew**: 2026-07-28 removes the initialize handshake and sessions; most servers in the wild still expect the handshake. A client built only against the latest stateless flow may fail against older servers (and vice versa). The v1 SDK's fallback discipline (probe, then fall back) is the pattern to copy.
- **Server crash loops**: stdio children die (npx flakiness, OOM, panics). Spec covers clean shutdown but not restart; harnesses add their own startup timeouts (Codex: 10 s default, `required` flag to fail fast vs degrade) and health surfacing (Claude Code `/mcp` states: connected/failed/cached/needs auth). A pi implementation needs a no-restart-or-bounded-restart policy so a crashing server can't pin CPU or spam stderr.
- **Tool-count context bloat**: official best-practices doc quantifies ~150k tokens of definitions for large server sets; recommended mitigation is progressive discovery with a 1-5% context-window threshold, plus `ttlMs`/deterministic-order caching. Also: mutating the tools array mid-conversation breaks provider prompt caches.
- **Schema collisions**: tool names are only unique per server; two servers exposing `search` collide; `serverInfo.name` is not guaranteed unique either. Prefixing (`mcp__<server>__<tool>`) is the norm (Claude Code, ZCode firsthand); Gemini's single-underscore variant creates a documented parsing pitfall with underscores in server names — prefer the double-underscore convention.
- **Prompt injection from server-controlled text**: tool `description`s, `annotations`, and result content are untrusted; the spec warns clients MUST treat annotations as untrusted and SHOULD validate/sanitize results before passing to the LLM. "Rug pull" attacks (benign definitions at review time, malicious behavior after trust) are a documented class (mitigations: re-consent on definition change, integrity pinning — see https://modelcontextprotocol.io/docs/2026-07-28/tutorials/security/security_best_practices and ETDI, https://arxiv.org/html/2506.01333v1).
- **OAuth/client security surface**: confused deputy (proxy servers with static client IDs + consent cookies), token passthrough (forbidden), SSRF via OAuth metadata URLs (clients SHOULD enforce HTTPS, block private/link-local ranges, mind DNS TOCTOU), `javascript:` authorization URLs, localhost redirect impersonation, mix-up attacks (validate `iss`). If pi's first cut only supports static headers/env-var tokens, most of this is deferred but should be an explicit non-goal in the spec.
- **Local stdio servers execute arbitrary code**: security best practices require showing the exact command before first run and consent (Claude Code prompts for project-scope `.mcp.json` servers; pi already has a `project_trust` extension event that maps directly onto this).
- **Sync vs async tool calls**: `tools/call` is a single JSON-RPC request-response; "async" appears only as (a) SSE-streamed responses with interleaved `notifications/progress` before the result, (b) MRTR `input_required` round-trips (2026-07-28), and (c) tasks extension. pi's `ToolDefinition.execute` returning a Promise maps cleanly onto a plain request with a timeout; progress notifications could feed pi's `onUpdate` streaming callback, and AbortSignal maps to `notifications/cancelled`.
- **list_changed invalidation**: servers may change tools mid-session (declared via `listChanged`); clients must re-list and reconcile registered tools — including unregistering tools that disappeared, which pi's tool registry supports via reload but not (yet) incremental removal (extensions register at load; `refreshTools` exists in `ExtensionActions`).
- **Deprecated client features**: roots/sampling/logging are deprecated as of 2026-07-28 — a new client should not invest in them (elicitation survives via MRTR).

## Design takeaways for pi

- Map each MCP tool to a `ToolDefinition` wrapper: `name = mcp__<server>__<tool>` (Claude Code/ZCode convention), `parameters` = the server's `inputSchema` passed through as a JSON-Schema `TSchema`, `description` = server description, `execute` = `tools/call` with result `content[]` flattened to pi `TextContent`/`ImageContent` and `isError` mapped to an error result. TypeBox emits JSON Schema, so no schema translation is needed in the common direction.
- Implement as an extension or extension-backed feature: `registerTool` per discovered tool, `/mcp`-style command + status via `ctx.ui.setStatus`, `session_shutdown` for child cleanup, `tool_call`/`tool_result` events already give approval hooks. A per-server "trust" prompt on first use can reuse the `project_trust` pattern, especially for `.mcp.json`-style project-scoped config.
- Config surface mirroring peers: a `mcpServers` map in pi settings (global + project scopes already exist) with `command`/`args`/`env` (stdio) and `url`/`headers` (Streamable HTTP), plus per-server `startupTimeoutMs`, `toolTimeoutMs`, `enabled`, `includeTools`/`excludeTools`, and `${ENV}` expansion — the field names with the widest cross-harness overlap.
- Prefer a hand-rolled minimal 2025-06-18 client (stdio + HTTP POST/SSE) behind a small internal transport interface, or `@modelcontextprotocol/client` v2 only after interop verification; both avoid v1's express/hono footprint. Keep the protocol version a constant so bumping to 2026-07-28 (or negotiating) is one change site.
- Make it an opt-in feature: servers connect only when configured; startup failures degrade to a visible warning (Codex/Gemini pattern) with `required`-style opt-out; respect `mcp_optional_startup_grace`-like behavior so slow servers don't block the session.
- Address context bloat from day one: cap per-server tool count, honor a total token/percentage threshold, and expose per-server disable; the `search_tools`/lazy-load pattern is the documented escape hatch if thresholds are exceeded.
- Treat server-provided text (descriptions, results, `instructions`) as untrusted content; never auto-execute project-configured server commands without an explicit first-run consent showing the exact command; surface `readOnlyHint`-style annotations as hints only.
- Skip resources/prompts/sampling/roots in v1 (deprecated or secondary); tools are the only surface every surveyed harness gates into the native registry on first, and prompts/resources can map onto pi's existing prompt-templates/skills later.

## Sources

- https://modelcontextprotocol.io/llms.txt (spec version index)
- https://modelcontextprotocol.io/specification/2025-06-18/basic/lifecycle
- https://modelcontextprotocol.io/specification/2025-06-18/basic/transports
- https://modelcontextprotocol.io/specification/2025-06-18/server/tools
- https://modelcontextprotocol.io/specification/latest/changelog (2026-07-28 changes)
- https://modelcontextprotocol.io/specification/2026-07-28/server/tools (naming, MRTR, x-mcp-header, stateful-tool guidance)
- https://modelcontextprotocol.io/docs/2026-07-28/learn/client-concepts
- https://modelcontextprotocol.io/docs/2026-07-28/develop/clients/client-best-practices
- https://modelcontextprotocol.io/docs/2026-07-28/tutorials/security/security_best_practices
- https://arxiv.org/html/2506.01333v1 (ETDI: rug pull / tool squatting mitigations)
- https://github.com/modelcontextprotocol/typescript-sdk (main README: v2 packages, license)
- https://github.com/modelcontextprotocol/typescript-sdk/blob/v1.x/docs/client.md (v1 Client/transports)
- https://www.npmjs.com/package/@modelcontextprotocol/sdk (v1 1.30.0 deps/engines)
- https://www.npmjs.com/package/@modelcontextprotocol/client (v2 2.0.0 deps/engines)
- https://code.claude.com/docs/en/mcp
- https://code.claude.com/docs/en/permissions
- https://code.claude.com/docs/en/settings
- https://learn.chatgpt.com/docs/extend/mcp?surface=cli (Codex MCP, redirected from developers.openai.com/codex/mcp)
- https://learn.chatgpt.com/docs/config-file/config-reference (Codex mcp_servers reference)
- https://github.com/openai/codex — docs/config.md (now links out to developers.openai.com/learn.chatgpt.com)
- https://raw.githubusercontent.com/google-gemini/gemini-cli/main/docs/tools/mcp-server.md
- https://opencode.ai/docs/mcp-servers/
- ZCode firsthand observation (labeled "firsthand" above)
