# Feature 07: MCP Client Support

pi currently extends only through TypeScript extensions written against its own ExtensionAPI. This feature adds a Model Context Protocol (MCP) client so pi can connect to external MCP servers — local processes speaking JSON-RPC over stdio, or remote endpoints speaking Streamable HTTP — discover their tools at session start, and register each one in pi's native tool registry under a namespaced `mcp__<server>__<tool>` ToolDefinition. MCP is an open protocol for connecting LLM tools to external servers; JSON-RPC 2.0 is a simple request/response/notification message format; "stdio transport" means the server is a child process exchanging one JSON message per line over stdin/stdout; "Streamable HTTP" means every message is an HTTP POST whose response is either a plain JSON body or a Server-Sent Events (SSE) stream. The client is minimal and hand-rolled (zero new runtime dependencies), configured via an `mcpServers` map in existing pi settings, opt-in by config presence, and degrades gracefully on server failure. Jargon is defined inline; every referenced symbol exists in the repo today.

## Metadata

- Priority: medium
- Effort: L
- Risk: High — spawns arbitrary configured processes, parses a wire protocol the project does not control, and injects third-party text (tool descriptions/results) into the model context.
- Depends on: none strictly. Touches the extension system (`packages/coding-agent/src/core/extensions/`), settings (`core/settings-manager.ts`), and resource loading (`core/resource-loader.ts`).
- Research: feature-tasks/research/07-mcp-client.md

## Problem

Every pi integration today must be written as a pi-specific TypeScript extension (`ToolDefinition` with TypeBox schemas, registered via `registerTool`). The MCP server ecosystem — hundreds of existing servers for browsers, databases, design tools, documentation — is unreachable without writing a bespoke adapter per server per user. pi has no code for: declaring external tool servers in config, speaking the MCP wire protocol, or mapping foreign tool schemas into its TypeBox-based tool registry. The result is that pi users cannot reuse any MCP tooling that Claude Code, Codex CLI, Gemini CLI, and OpenCode users get out of the box, and MCP-server authors must target four harnesses but not pi.

## Prior art

All four surveyed harnesses share one skeleton: declarative server list in config (command/args/env for stdio; url/headers for HTTP), spawn-or-connect at startup with per-server timeouts, `initialize` handshake + `tools/list` discovery, and registration of each remote tool as a native tool under a server-prefixed name with a plain JSON-Schema parameter definition.

### Spec essentials (from the dossier)

- Spec versions (newest first): 2026-07-28, 2025-11-25, 2025-06-18, 2025-03-26, 2024-11-05 (https://modelcontextprotocol.io/llms.txt).
- 2025-06-18 (handshake generation, what most deployed servers speak): client sends `initialize` with `params.protocolVersion`, `params.capabilities`, `params.clientInfo {name, title, version}`; server replies with its capabilities (`tools {listChanged}` among them) and `serverInfo`; client then sends `notifications/initialized`. Discovery via `tools/list` (paginated: `params.cursor` / `result.nextCursor`) returning `tools[]` with `name`, `description`, `inputSchema` (plain JSON Schema). Invocation via `tools/call` with `params.name`/`params.arguments`; result carries `content[]` (`text`, `image`, `audio`, `resource_link`, embedded `resource`), optional `structuredContent`, and `isError` (a tool-level error the model can self-correct from, distinct from JSON-RPC protocol errors). Servers may emit `notifications/tools/list_changed` if they declared `listChanged`. stdio: newline-delimited JSON-RPC on stdin/stdout, no embedded newlines; shutdown = close stdin → wait → SIGTERM → wait → SIGKILL. Streamable HTTP: every message is a POST with `Accept: application/json, text/event-stream`; response is a JSON body or SSE stream; server may return `Mcp-Session-Id` on initialize which the client must echo; client must send `MCP-Protocol-Version` on subsequent requests; on 404 the client must re-initialize; DELETE terminates the session. Sources: https://modelcontextprotocol.io/specification/2025-06-18/basic/lifecycle , .../basic/transports , .../server/tools
- 2026-07-28 (stateless rewrite): removes `initialize`/sessions/`Mcp-Session-Id` entirely (version/capabilities move into `_meta` on every request), removes `ping`, deprecates roots/sampling/logging. Sources: https://modelcontextprotocol.io/specification/latest/changelog , https://modelcontextprotocol.io/specification/2026-07-28/server/tools . A client built only for this generation fails against the installed base of handshake servers.
- Tool names are unique per server only; aggregating clients "SHOULD implement a disambiguation strategy such as prefixing tool names with a server identifier" (2026-07-28 spec, server/tools).
- Context bloat: naive injection of every tool definition can cost ~150k tokens; official guidance is caching plus a switch to progressive discovery at 1–5% of the context window. https://modelcontextprotocol.io/docs/2026-07-28/develop/clients/client-best-practices
- Security: server-provided text (descriptions, annotations, results) is untrusted; local stdio servers execute arbitrary code and deserve first-run consent showing the exact command. https://modelcontextprotocol.io/docs/2026-07-28/tutorials/security/security_best_practices

### Harness config formats (verbatim from the dossier)

Claude Code — `.mcp.json` at repo root (project scope), `~/.claude.json` (local/user scope):

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

Stdio entries use `"command": "npx", "args": ["-y", "@example/mcp-server"]`, `env`, `headers` with `${API_KEY}` expansion. Tools are exposed as `mcp__<server>__<tool>`; permission rules like `"mcp__puppeteer__*"` and `"mcp__github__get_*"`. Sources: https://code.claude.com/docs/en/mcp , .../permissions , .../settings

OpenAI Codex CLI — `~/.codex/config.toml`:

```toml
[mcp_servers.context7]
command = "npx"
args = ["-y", "@upstash/context7-mcp"]
env_vars = ["LOCAL_TOKEN"]

[mcp_servers.context7.env]
MY_ENV_VAR = "MY_ENV_VALUE"
```

```toml
[mcp_servers.chrome_devtools]
url = "http://localhost:3000/mcp"
enabled_tools = ["open", "screenshot"]
disabled_tools = ["screenshot"] # applied after enabled_tools
startup_timeout_sec = 20
tool_timeout_sec = 45
enabled = true
```

Per-server: `startup_timeout_sec` (default 10), `tool_timeout_sec` (default 60), `enabled`, `required` (fail startup vs degrade), `enabled_tools`/`disabled_tools`. Source: https://learn.chatgpt.com/docs/config-file/config-reference

Gemini CLI — `mcpServers` map in `~/.gemini/settings.json` or `.gemini/settings.json`; one of `command` (stdio), `url` (SSE), or `httpUrl` (streaming HTTP); `timeout` default 600000 ms; `includeTools`/`excludeTools` (exclude wins); `"trust": true` bypasses per-call confirmation. Namespacing `mcp_{serverName}_{toolName}` with a documented pitfall: underscores in server names break their single-underscore permission parser — the double-underscore convention avoids this class of bug. Source: https://raw.githubusercontent.com/google-gemini/gemini-cli/main/docs/tools/mcp-server.md

OpenCode — top-level `mcp` key in `opencode.json`; local: `"type": "local"`, `"command": ["npx", "-y", "my-mcp-command"]`, `"enabled": true`, `"environment": {...}`; remote: `"type": "remote"`, `"url": "..."`, `"headers": { "Authorization": "Bearer MY_API_KEY" }` with `{env:VAR}` interpolation. Tools registered as `servername_toolname`, disable via `"mymcpservername_*": false`. Source: https://opencode.ai/docs/mcp-servers/

## Proposed design

### Target spec version

Target the **2025-06-18 handshake generation**. Rationale (dossier "Design takeaways" and "SDK/build options"): most deployed servers speak the handshake flow; the 2026-07-28 stateless rewrite is not yet broadly deployed and its interop story is unverified. Keep the version in one constant (`MCP_PROTOCOL_VERSION = "2025-06-18"` in `mcp/types.ts`) and implement spec negotiation minimally: send our version in `initialize`; if the server responds with a different version, accept and remember it (and echo it in the HTTP `MCP-Protocol-Version` header); if the server rejects with a JSON-RPC error, fail the server with a clear message. Bumping to 2026-07-28 later is then a one-site change plus a compat decision.

### Client scope (hand-rolled, zero new runtime dependencies)

Implement only: `initialize` → `notifications/initialized`, `tools/list` (cursor-pagination loop), `tools/call`, handling of `notifications/tools/list_changed`, and sending `notifications/cancelled` on abort. Not implemented: `ping`, logging, completions, resources, prompts, sampling, roots, elicitation, OAuth, MRTR.

Dependency justification (dossier Option C): the official SDK v1 (`@modelcontextprotocol/sdk`) drags in express/hono/cors/ajv/zod because client and server ship together; v2 (`@modelcontextprotocol/client`) targets the 2026-07-28 stateless spec with unverified interop against handshake servers. A minimal stdio + HTTP-POST client is ~600–900 lines. pi's constraints (root AGENTS.md) exact-pin every direct dependency and require lifecycle-script allowlist review in `scripts/generate-coding-agent-shrinkwrap.mjs` for shrinkwrap regeneration; adding zero dependencies avoids that entire review surface. Everything needed already exists: `node:child_process` (spawn), `cross-spawn` 7.0.6 (already a direct dep, for Windows `npx`/`.cmd` resolution), `node:readline` (line framing), global `fetch` (Node >= 22.19 per `engines` in `packages/coding-agent/package.json`; the app already configures a global undici dispatcher honoring `httpProxy`/`httpIdleTimeoutMs` settings via `configureHttpDispatcher`/`applyHttpProxySettings` in `core/http-dispatcher.ts`, called from `src/main.ts` lines 583–584 and 850–851 — MCP HTTP requests inherit proxy and timeout settings for free), and `typebox` 1.3.27 (types only).

### Module layout

New directory `packages/coding-agent/src/core/mcp/`:

- `types.ts` — `McpServerConfig`, `McpToolDescriptor`, `McpCallToolResult`, `McpTransport` interface, `MCP_PROTOCOL_VERSION`, defaults (`DEFAULT_STARTUP_TIMEOUT_MS = 10_000`, `DEFAULT_TOOL_TIMEOUT_MS = 60_000`, `MAX_TOOLS_PER_SERVER = 50`, `MAX_TOTAL_MCP_TOOLS = 200`).
- `json-rpc.ts` — JSON-RPC 2.0 message shapes, request-id allocation, pending-request map (id → `{resolve, reject, timer}`), notification fan-out.
- `stdio-transport.ts` — `createStdioTransport(config, name)` spawning the child and implementing `McpTransport`.
- `http-transport.ts` — `createHttpTransport(config, name)` implementing `McpTransport` over fetch POST with a minimal SSE line-parser state machine (~60 lines: buffer bytes, split on `\n\n`, parse `event:`/`data:` lines, emit each `data:` JSON message).
- `client.ts` — `McpClient` class: `connect()`, `listTools()` (pagination loop), `callTool(name, args, signal)`, `onListChanged(handler)`, `close()`.
- `tool-mapping.ts` — name mangling, `ToolDefinition` construction, result mapping.
- `extension.ts` — `createMcpExtension(settingsManager)`: the inline extension factory that owns server lifecycle.

`McpTransport` interface (shared by both transports; top-level imports only, erasable syntax only):

```ts
export interface McpTransport {
	send(message: unknown): Promise<void>;
	onMessage(handler: (message: unknown) => void): void;
	onClose(handler: (error: Error | undefined) => void): void;
	close(): Promise<void>;
}
```

### stdio transport

- Spawn with `cross-spawn`'s `spawn(command, args, { cwd, env: { ...process.env, ...expandedEnv }, stdio: ["pipe", "pipe", "pipe"] })` (precedent: `core/tools/bash.ts` spawns via `node:child_process`; `cross-spawn` is already a runtime dep).
- Framing: write `JSON.stringify(message) + "\n"` to stdin (`JSON.stringify` never emits raw newlines, satisfying the no-embedded-newlines rule); read stdout via `readline.createInterface({ input: child.stdout })`, `JSON.parse` each line, skip empty lines; non-JSON lines are ignored and counted for diagnostics.
- stderr: keep a rolling last-8KB ring buffer for `/mcp` diagnostics display; never forwarded to the model.
- Shutdown ladder (MCP spec order): `child.stdin.end()` → wait up to 2000 ms for exit → `child.kill("SIGTERM")` (Windows: proceed directly to tree kill) → wait up to 5000 ms → `killProcessTree(child.pid)` from `src/core/utils/shell.ts` (line 216; taskkill `/F /T` on Windows, `process.kill(-pid, "SIGKILL")` on Unix — this exact helper is the bash tool's abort path). Children are spawned non-detached, so they die with pi on normal signals; a `process.on("exit")` safety hook in `extension.ts` force-kills any still-alive children via `killProcessTree`.

### Streamable HTTP transport

- Every message: `fetch(url, { method: "POST", headers, body: JSON.stringify(message), signal })` with `Content-Type: application/json`, `Accept: application/json, text/event-stream`, plus configured headers resolved through `resolveHeaders` from `core/resolve-config-value.ts` (supports `$VAR`, `${VAR}`, `!command` — same mechanism as provider headers), plus `Mcp-Session-Id` (echoed from the initialize response once received) and `MCP-Protocol-Version` (the negotiated version) on post-initialize requests.
- Response handling: `Content-Type: application/json` → parse one JSON-RPC message; `text/event-stream` → feed bytes into the SSE parser; each `data:` message is dispatched immediately (this is how server notifications such as `list_changed` arrive mid-stream on the POST response). The GET SSE stream (server-initiated messages outside a request) is not opened in v1; a server returning 405 to GET is spec-compliant anyway, and `list_changed` arriving on any POST-response stream is honored.
- 404 with a session id → re-initialize once, then retry the original request. 401/403 → surface "server requires authentication; pi v1 supports static headers only" (OAuth is an explicit non-goal). Close: best-effort `DELETE` to the endpoint with the session headers when a session id exists.
- Per-request timeout: combine the tool `AbortSignal` with `AbortSignal.timeout(toolTimeoutMs)` via `AbortSignal.any`.

### Tool mapping into pi's registry

Each discovered MCP tool becomes a `ToolDefinition` (interface in `core/extensions/types.ts` lines 451–500) registered through `pi.registerTool`:

- **Name**: `mcp__<server>__<tool>` (Claude Code / ZCode convention; dossier recommends the double-underscore form because Gemini's single-underscore variant has a documented parser ambiguity). Config validation rejects server keys containing `__`, empty strings, or characters outside `[A-Za-z0-9_-]` — with that rule, `mcp__<server>__<tool>` is unambiguously splittable even when server or tool names contain single underscores. On collision with an existing tool name, the later registration is skipped and a warning is surfaced (pi has no per-tool override here; `registerTool` would overwrite the `extension.tools` map entry, so check `pi.getAllTools()` first).
- **Parameters**: pass the server's `inputSchema` through as `parameters: descriptor.inputSchema as TSchema` — no wrapper. Two verified reasons: (1) `registerTool` in `core/extensions/loader.ts` (lines 287–299) only checks that `parameters` is a non-null, non-array object; (2) pi's argument validation (`validateToolArguments` in `packages/ai/src/utils/validation.ts`, called from `packages/agent/src/agent-loop.ts` line 625) has a dedicated branch at line 323 for schemas **without** the TypeBox Kind symbol — it applies JSON-Schema-style coercion and validates with TypeBox `Compile`. Wrapping in `Type.Unsafe` would set the Kind symbol and route around that branch; the raw cast engages the path pi already maintains for plain JSON Schema. Provider serialization also works unchanged because TypeBox schemas are JSON Schema.
- **Description**: `descriptor.description ?? descriptor.name`, truncated at 4096 characters. Server text is untrusted prompt-injection surface — pass it through (the model must see tool semantics) but never splice annotations, `serverInfo`, or server `instructions` into it. Server `instructions` from initialize are ignored entirely in v1.
- **`constrainedSampling: false`** — strict provider-side constrained sampling with arbitrary third-party schemas can violate provider strict modes (e.g. required-all-keys); pi's built-ins enable it (`core/tools/read.ts` line 77) but passthrough schemas should not.
- No `promptSnippet`, no `promptGuidelines`: keeps MCP tools out of the system prompt's "Available tools" list and Guidelines section (behavior verified by `test/agent-session-dynamic-tools.test.ts`: tools without `promptSnippet` stay callable but are omitted from the prompt). Context cost is then limited to the tool schema the provider requires anyway.
- **execute** (async, matching `ToolDefinition.execute(toolCallId, params, signal, onUpdate, ctx): Promise<AgentToolResult<TDetails>>`): send `tools/call` with the params object as `arguments`; per-call timeout `toolTimeoutMs`; `signal?.aborted` / abort listener → send `notifications/cancelled` and reject. `notifications/progress` arriving mid-call → `onUpdate?.({ content: [{ type: "text", text: progress message }] , details: {} })` (cheap, optional).
- **Result mapping**: `content[]` entries: `text` → `{ type: "text", text }`; `image` → `{ type: "image", data, mimeType }` if the mimeType is one pi's `ImageContent` supports, else a text note; `audio`/`resource_link`/embedded `resource` → pretty-printed JSON text block. If `content` is empty and `structuredContent` exists, append it as a pretty-printed JSON text block. Text is truncated with `truncateTail` from `core/tools/truncate.ts` (same `DEFAULT_MAX_BYTES` budget as bash output).
- **Error mapping**: JSON-RPC protocol error → `throw new Error(...)` (pi's agent loop converts thrown tool errors into model-visible error tool results via `createErrorToolResult`, `packages/agent/src/agent-loop.ts` line 767). MCP `isError: true` → throw an `Error` whose message is the flattened result text — the model sees the server's self-correction hint as an error result. `details` (for UI/logs): `{ server, tool, isError, annotations?, structuredContent? }`. `annotations.readOnlyHint` etc. are recorded in `details` as hints only — never used for gating.

### Config surface

`mcpServers` map added to `Settings` (`core/settings-manager.ts` line 106 `Settings` interface), available in both scopes (global `~/.yupi/agent/settings.json`, project `<cwd>/.yupi/settings.json`; `APP_NAME`/`CONFIG_DIR_NAME` come from `src/config.ts` and this fork resolves to `yupi`/`.yupi`). The existing `deepMergeSettings` (line 184) already merges nested maps per key, so a project entry `enabled: false` disables a globally-defined server, and per-field overrides compose. Project-scope servers are invisible when the project is untrusted because `loadFromStorage` (line 405) returns `{}` for untrusted projects — trust gating comes free.

```jsonc
{
	"mcpServers": {
		"context7": {
			"command": "npx",
			"args": ["-y", "@upstash/context7-mcp"],
			"env": { "MY_VAR": "${MY_VAR}" },
			"cwd": "~/tools/context7",
			"enabled": true,
			"required": false,
			"startupTimeoutMs": 10000,
			"toolTimeoutMs": 60000,
			"includeTools": [],
			"excludeTools": []
		},
		"figma": {
			"url": "https://mcp.figma.com/mcp",
			"headers": { "Authorization": "Bearer ${FIGMA_TOKEN}" }
		}
	}
}
```

Rules: exactly one of `command` (stdio) or `url` (Streamable HTTP) per entry — an entry with both is a config error. Field names chosen for widest cross-harness overlap (dossier): `command`/`args`/`env`/`url`/`headers`/`enabled`/`includeTools`/`excludeTools` match Claude Code/Gemini/OpenCode vocabulary; timeouts use pi's `*Ms` suffix convention (`httpIdleTimeoutMs` precedent). `env` values and `headers` values expand via `resolveConfigValue`/`resolveHeaders` from `core/resolve-config-value.ts`. Optional `enableMcp?: boolean` setting (default true) is a kill switch. Invalid entries (bad name, both transports, non-integer timeouts) are skipped with a startup warning, never a crash — surfaced through the extension via `ctx.ui.notify` and in `/mcp`, mirroring how `settings-diagnostics.ts` treats malformed settings.

### Opt-in gating and consent

- **Opt-in by config presence**: the extension is inert unless at least one `mcpServers` entry exists (a user who configures nothing gets zero new behavior, zero processes, zero context cost — same posture as the extensions/skills settings). No `PI_EXPERIMENTAL` gate (`core/experimental.ts`) for the config-gated core; the `enableMcp: false` kill switch plus `--no-extensions` (which unloads inline factories, see below) provide the flags.
- **stdio consent (project scope only)**: a checked-in project settings file can name any executable. The existing project-trust prompt (`core/project-trust.ts` `resolveProjectTrusted`, text from `formatProjectTrustPrompt`: "This allows yupi to load .yupi settings and resources, install missing project packages, and execute project extensions") already covers loading project settings, but it does not show the exact command. Reuse the pattern, not the prompt: on first encounter of a project-scope stdio server, show a `ctx.ui.confirm` dialog listing the exact `command args` and server name; persist the decision in `~/.yupi/agent/mcp-consent.json` keyed by `cwd + server name + hash(command+args)` (format follows `trust-manager.ts`'s simple JSON record style). Changed command → re-consent (dossier's "rug pull" mitigation). In non-interactive modes (`print`/`json`/`rpc`), or when consent is declined, the server is skipped with a warning. Global-scope stdio servers run without extra consent: the user authored `~/.yupi/agent/settings.json` themselves, the same trust level as user-installed extensions. HTTP servers need no consent (no local code execution).
- **Permission classification**: MCP tools are ordinary custom tools. They flow through the existing `tool_call` / `tool_result` extension events (`CustomToolCallEvent`, types.ts lines 934–937 — any extension can block them), the `--tools`/`allowedToolNames`/`excludedToolNames` filters (agent-session `_refreshToolRegistry` `isAllowedTool`, line 2699), and `defaultTools` settings. No separate MCP permission grammar in v1; `readOnlyHint` is a hint, not a gate.

### Context-budget guard

- Per-server: `includeTools`/`excludeTools` filters (exclude wins, Gemini/Codex convention). Hard cap `MAX_TOOLS_PER_SERVER = 50` and total cap `MAX_TOTAL_MCP_TOOLS = 200` across servers; exceeding a cap registers tools in stable server-listed order until the cap and emits a warning naming the server and the count held back, visible via `/mcp`. (Rationale, dossier: tool definitions alone can reach ~150k tokens; caps are the cheap first line of defense.)
- Progressive discovery (search/get-details meta-tools) and `ttlMs` caching are explicitly deferred — documented escape hatch, not v1.
- Because registrations happen once at session start (and only mutate on `list_changed`), the tools array stays stable mid-conversation, preserving provider prompt caches (dossier best-practices note).

### Server lifecycle, crash and restart policy

- Connect all enabled servers concurrently at `session_start` (any reason: `startup`, `reload`, `new`, `resume`, `fork` — the extension re-establishes connections after `session_shutdown` closed them), each bounded by `startupTimeoutMs` (default 10 s) measured through initialize + first `tools/list`. `Promise.allSettled`; total connect phase additionally capped so one slow server cannot block the session (skip and warn, Codex `mcp_optional_startup_grace` pattern).
- Failure policy: default degrade — failed server produces one `ctx.ui.notify` warning and a `ctx.ui.setStatus("mcp", ...)` marker; nothing throws. `required: true` on a server makes its failure a session-start error instead (Codex `required` semantics).
- **No automatic restart in v1.** A crashed stdio child or a broken HTTP session marks the server `failed`; its registered tools remain (removing them mid-conversation would break prompt caches and the model's expectations) but each `execute` returns a clear error: "MCP server <name> is not connected. Run /mcp to reconnect." A single `/mcp reconnect <name>` command (or `/mcp reconnect` for all) re-runs connect + re-list + reconcile. Rationale (dossier pitfall): automatic restart of a crashing `npx -y` server can pin CPU and spam stderr; bounded, manual restart keeps failure visible and cheap. This decision can be revisited with exponential backoff later.
- `list_changed` handling: re-issue `tools/list`; register new tools via `pi.registerTool`; for removed tools call the new `pi.unregisterTool(name)` (small ExtensionAPI addition, implementation plan step 6) — pi's registry currently has no removal path (`Extension.tools` is only ever added to; `refreshTools` rebuilds from it). Reconciled names are reported once via `ctx.ui.notify`.
- Cleanup: `session_shutdown` (all reasons incl. `quit`) closes every transport via the shutdown ladder; `process.on("exit")` is the last-resort kill hook.

### Out of scope for v1

Resources, prompts, sampling, roots, logging/setLevel, completions, elicitation, MRTR, OAuth (static `Authorization` headers only), the deprecated 2024-11-05 HTTP+SSE fallback transport, the 2026-07-28 stateless protocol, the GET SSE stream, automatic restart, progressive discovery meta-tools, and exposing server `instructions` to the model.

## Implementation plan

Ordered; all paths under `packages/coding-agent/`. Every snippet is erasable-TypeScript only (no `enum`, `namespace`, parameter properties, `import =`); top-level imports only; zero new runtime dependencies, so `package.json` `dependencies` and `npm-shrinkwrap.json` are untouched — if an implementer ever adds a dep instead, root AGENTS.md requires exact pinning, `npm install --ignore-scripts`, lockfile refresh, and lifecycle-script allowlist review in `scripts/generate-coding-agent-shrinkwrap.mjs`; the hand-rolled design exists to make that unnecessary.

1. **`src/core/mcp/types.ts` (new)** — config and wire types plus constants:

   ```ts
   import type { TSchema } from "typebox";

   export const MCP_PROTOCOL_VERSION = "2025-06-18";
   export const DEFAULT_STARTUP_TIMEOUT_MS = 10_000;
   export const DEFAULT_TOOL_TIMEOUT_MS = 60_000;
   export const MAX_TOOLS_PER_SERVER = 50;
   export const MAX_TOTAL_MCP_TOOLS = 200;

   export interface StdioServerConfig {
   	command: string;
   	args?: string[];
   	env?: Record<string, string>;
   	cwd?: string;
   }

   export interface HttpServerConfig {
   	url: string;
   	headers?: Record<string, string>;
   }

   export interface McpServerConfig {
   	enabled?: boolean; // default true
   	required?: boolean; // default false: degrade to warning on failure
   	startupTimeoutMs?: number;
   	toolTimeoutMs?: number;
   	includeTools?: string[];
   	excludeTools?: string[];
   }

   export interface McpServerEntry extends McpServerConfig {
   	name: string;
   	transport: StdioServerConfig | HttpServerConfig; // exactly one, validated
   	scope: "global" | "project"; // origin scope, for consent rules
   }

   export interface McpToolDescriptor {
   	name: string;
   	description?: string;
   	inputSchema: TSchema;
   	annotations?: Record<string, unknown>;
   }

   export interface McpCallToolResult {
   	content: Array<Record<string, unknown>>;
   	structuredContent?: unknown;
   	isError?: boolean;
   }
   ```

   Plus `validateMcpServers(raw: unknown): { entries: McpServerEntry[]; errors: string[] }` — checks server-key charset (`[A-Za-z0-9_-]+`, no `__`), exactly-one-transport, integer timeouts, and drops invalid entries with messages. Union types (`StdioServerConfig | HttpServerConfig`) instead of enums; no parameter properties.

2. **`src/core/mcp/json-rpc.ts` (new)** — `JsonRpcMessage` parse/validate helpers and a `JsonRpcPending` map: `nextId()` (monotonic number), `request(method, params)` returning a promise wired to id, timeout timer, and rejection on close. Keep transport-agnostic; both transports feed parsed messages into `handleMessage(message)` which resolves pending ids and dispatches notifications (`method` present without `id`) to registered handlers.

3. **`src/core/mcp/stdio-transport.ts` (new)** — `createStdioTransport(entry: McpServerEntry): McpTransport` per the stdio design above. Imports: `spawn` from `cross-spawn`, `createInterface` from `node:readline`, `killProcessTree` from `../utils/shell.ts`. Implement the shutdown ladder (`stdin.end()` → 2 s → SIGTERM → 5 s → `killProcessTree`) as an async `close()` with timers; expose the stderr ring buffer via a `recentStderr()` accessor for `/mcp`.

4. **`src/core/mcp/http-transport.ts` (new)** — `createHttpTransport(entry: McpServerEntry): McpTransport` per the Streamable HTTP design above, with the SSE parser as a private function (`parseSseChunk(buffer: string): { events: Array<{ event?: string; data: string }>; rest: string }`). Resolve headers once at construction via `resolveHeaders` from `../resolve-config-value.ts`. Use global `fetch`; no undici import needed (dispatcher is configured app-wide by `configureHttpDispatcher`).

5. **`src/core/mcp/client.ts` (new)** — `McpClient` wrapping a transport + `json-rpc.ts`: `connect()` sends `initialize` (`clientInfo: { name: PACKAGE_NAME, version: VERSION }` from `../../config.ts`, capabilities `{}` — we support none of roots/sampling/elicitation), then `notifications/initialized`, then one `listTools()` for the connect budget; `listTools()` loops `tools/list` with `params.cursor` until `nextCursor` is absent; `callTool(name, args, signal)` with timeout + `notifications/cancelled` on abort; subscription for `notifications/tools/list_changed`; graceful `close()`. Store negotiated `protocolVersion` and, for HTTP, the `Mcp-Session-Id` response header (read back through a transport-provided `lastResponseMeta()` hook or by having http-transport expose `setSessionIdGetter` — simplest: `HttpServerConfig` transport exposes `sessionHeaders()` the client populates after initialize).

6. **Extension API addition — `src/core/extensions/types.ts` + `src/core/extensions/loader.ts`**: add `unregisterTool(name: string): void` to `ExtensionAPI` (types.ts, next to `registerTool` at line 1308). Implement in `createExtensionAPI` in loader.ts next to the existing `registerTool` (lines 287–299): `extension.tools.delete(name); runtime.refreshTools();` with `assertActive()`. This is required for `list_changed` removals (the registry rebuild in `agent-session.ts` `_refreshToolRegistry` line 2694 reads `extension.tools`, so deletion + refresh is sufficient; no other file changes needed). Re-export nothing new from `core/index.ts` beyond what tests need.

7. **`src/core/mcp/tool-mapping.ts` (new)** — `mcpToolName(server: string, tool: string): string`, `splitMcpToolName(name: string)` (inverse, for `/mcp` display), and:

   ```ts
   import type { TextContent, ImageContent } from "@earendil-works/pi-ai";
   import type { ToolDefinition } from "../extensions/types.ts";
   import { truncateTail } from "../tools/truncate.ts";
   import type { McpClient, McpToolDescriptor, McpServerEntry } from "./types.ts";

   export function createMcpToolDefinition(
   	entry: McpServerEntry,
   	descriptor: McpToolDescriptor,
   	client: McpClient,
   ): ToolDefinition<any, McpToolDetails> {
   	return {
   		name: mcpToolName(entry.name, descriptor.name),
   		label: `${entry.name}/${descriptor.name}`,
   		description: truncateDescription(descriptor),
   		parameters: descriptor.inputSchema as any,
   		constrainedSampling: false,
   		async execute(_toolCallId, params, signal, onUpdate) {
   			// tools/call with timeout; abort -> notifications/cancelled;
   			// result mapping: text/image passthrough, other content JSON-dumped,
   			// structuredContent appended when content is empty, truncateTail on text,
   			// isError -> throw new Error(flattenedText)
   		},
   	};
   }
   ```

   Complete the body per the mapping design; `McpToolDetails` interface (`{ server: string; tool: string; isError: boolean; annotations?: Record<string, unknown>; structuredContent?: unknown }`) lives in `types.ts`.

8. **`src/core/mcp/extension.ts` (new)** — `createMcpExtension(settingsManager: SettingsManager): InlineExtension` returning `{ name: "mcp", factory, hidden: false }`. The factory:

   ```ts
   const factory = (pi: ExtensionAPI): void => {
   	const state = new McpManager(pi, settingsManager);
   	pi.on("session_start", (event, ctx) => state.start(event.reason, ctx));
   	pi.on("session_shutdown", (event) => void state.stop(event.reason));
   	pi.registerCommand("mcp", {
   		description: "Show MCP server status; /mcp reconnect [name]",
   		handler: (args, ctx) => state.showStatus(args, ctx),
   	});
   };
   ```

   `McpManager` (same file, plain class with explicit fields): reads `settingsManager.getMcpServers()` (getter added in step 9; returns the already deep-merged global+project map) and the per-server origin scopes via `settingsManager.getGlobalSettings().mcpServers` / `getProjectSettings().mcpServers` (both exist today), runs `validateMcpServers`, applies consent for project-scope stdio entries (`ctx.ui.confirm` + `agentDir/mcp-consent.json` via `getAgentDir()` from `../../config.ts`; skip with warning in non-interactive `ctx.mode` or when declined), connects concurrently with `Promise.allSettled`, applies include/exclude + caps, registers definitions via `pi.registerTool` (checking `pi.getAllTools()` for collisions), reconciles on `list_changed` (register new / `pi.unregisterTool` removed, one notify), and on `stop()` closes all transports and clears state (connections are re-established on the next `session_start`, which `AgentSession.reload()` at line 2841 always emits after `session_shutdown`). Register the `process.on("exit")` force-kill hook once at module scope with a module-level child registry.

9. **`src/core/settings-manager.ts` (edit)** — define the raw settings shape in `src/core/mcp/types.ts` as `McpServerSettings = Omit<StdioServerConfig, never> & Omit<HttpServerConfig, never> & McpServerConfig` (all fields optional pre-validation; the union-of-both-transports is resolved by `validateMcpServers`); add to the `Settings` interface (line 106 area): `mcpServers?: Record<string, McpServerSettings>` and `enableMcp?: boolean`. Add `getMcpServers(): Record<string, McpServerSettings>` reading `this.settings.mcpServers` (already deep-merged global+project by `deepMergeSettings`) and `getEnableMcp(): boolean` (default true), following the getter style of `getEnableSkillCommands()` (line 1164). No persistence setters needed in v1 (users edit settings.json directly).

10. **`src/core/resource-loader.ts` (edit)** — register the built-in inline extension. In `DefaultResourceLoaderOptions` nothing changes; in the constructor (line ~269) do not touch `extensionFactories`; instead in `loadExtensionFactories` (line 950) prepend the built-in factory when `!this.noExtensions`:

    ```ts
    import { createMcpExtension } from "./mcp/extension.ts";
    // inside loadExtensionFactories, before the loop:
    const factories: InlineExtension[] = this.noExtensions ? [] : [createMcpExtension(this.settingsManager)];
    factories.push(...this.extensionFactories);
    ```

    and iterate `factories`. The named-inline path gives it the `<inline:mcp>` source path (verified in `loadExtensionFactories`, line 962), and `--no-extensions` (which sets `noExtensions`) unloads it, matching the bundled-subagents gating pattern (lines 452–457). Precedent for built-ins: `vendor/pi-subagents` is merged into every extension path list at lines 455/562; an inline factory is the in-tree equivalent that works identically in source, dist, and bundled-binary modes because it is compiled into the bundle rather than loaded from disk.

11. **Docs** — new `docs/mcp.md` (config reference, consent model, `/mcp` command, security notes); add an `mcpServers` subsection under "### Tools" in `docs/settings.md`; add the page to `docs/docs.json` navigation.

12. **`CHANGELOG.md` (edit)** — entries under `## [Unreleased]` (see Changelog section below).

13. **Run `npm run check`** from the repo root and fix all errors/warnings/infos (root AGENTS.md). Run the new tests via `./scripts/test.sh` from the repo root, or targeted: `node "$(git rev-parse --show-toplevel)/node_modules/vitest/dist/cli.js" --run test/mcp-client.test.ts` from the package root.

## Testing plan

All tests are local-only: stdio fixture servers are Node child processes spawned from fixture files; HTTP tests bind an ephemeral localhost port with `node:http`. No real providers, keys, or network (root AGENTS.md rule for `test/suite/`; applied to all MCP tests too).

Fixture — **`test/fixtures/mcp-stdio-server.mjs` (new)**: a plain Node script speaking minimal JSON-RPC over stdio. Behavior selected by argv flags: responds to `initialize` (echoes a configurable protocol version) and `notifications/initialized`; `tools/list` returns a configurable tool set, honoring `cursor` pagination when run with `--paginate`; `tools/call` echoes arguments as text content (`--iserror` makes it return `isError: true` with the text); `--hang` makes `tools/call` never answer (timeout/abort tests); `--crash` exits the process on first `tools/call`; `--list-changed` emits `notifications/tools/list_changed` when it receives a `tools/call` with `arguments.triggerRefresh`; logs a marker line to stderr when it receives `notifications/cancelled` (abort test asserts this marker by having the fixture write it to a file path passed via `--cancelled-marker <path>`).

Fixture — **`test/fixtures/mcp-http-server.mjs` (new)**: `node:http` server implementing: initialize returning `Mcp-Session-Id`; JSON-body mode (`--json`) and SSE mode (`--sse`) for responses; 404 for requests with an unknown session id until re-initialized; records DELETE on close.

1. **`test/mcp-client.test.ts` (new, vitest)** — client-level tests using the fixtures plus an in-memory `McpTransport` fake (a class with the same `send/onMessage/onClose/close` interface, no process):
   - handshake: initialize → initialized ordering (fake transport asserts message sequence); version negotiation accepts a server-returned different version; server error on initialize rejects with a clear message.
   - `tools/list` pagination via fake transport (two pages + cursor assert).
   - `tools/call` round-trip via stdio fixture: text result mapped to `TextContent`; `--iserror` throws with flattened text; image content maps to `ImageContent`; unknown content type becomes JSON text.
   - timeout: `--hang` fixture with `toolTimeoutMs: 200` rejects promptly.
   - abort: execute with an aborted/aborting signal sends `notifications/cancelled` (assert via marker file) and rejects.
   - crash: `--crash` fixture rejects the in-flight call and marks transport closed; subsequent calls fail fast with "not connected".
   - stdio kill ladder: spawn a fixture that ignores SIGTERM (`--ignore-sigterm`), call `close()`, assert the process is gone within the SIGKILL window (`process.kill(pid, 0)` throws).
   - `list_changed`: fake transport pushes the notification; registered handler fires.
2. **`test/mcp-http-transport.test.ts` (new)** — against the localhost HTTP fixture: initialize + session-id echo on subsequent requests; SSE-mode response delivers result and an interleaved `list_changed`; 404 triggers one re-initialize + retry; 401 surfaces the auth-not-supported message; DELETE is sent on close; `${ENV}` header expansion resolved from a temp env.
3. **`test/mcp-tool-mapping.test.ts` (new)** — pure unit tests: name mangling round-trip (`mcp__a__b_c` → server `a`, tool `b_c`), server-key validation rejects `__`/empty/invalid chars, description truncation at 4096, result mapping table (text/image/audio/structuredContent/empty), `isError` → thrown Error, text truncation via `truncateTail`.
4. **`test/mcp-settings.test.ts` (new)** — `SettingsManager.inMemory` (exists, line 398) with global + project `mcpServers`: deep merge composes per server; project `enabled: false` disables a global server; untrusted project (`SettingsManager.fromStorage` with `projectTrusted: false`) yields no project servers; invalid entries dropped with errors by `validateMcpServers`.
5. **`test/mcp-registration.test.ts` (new)** — registry integration, modeled on `test/agent-session-dynamic-tools.test.ts`: `DefaultResourceLoader` with real settings + the built-in MCP extension pointed at the stdio fixture; `createAgentSession` from `src/core/sdk.ts`; assert after `bindExtensions` that `session.getAllTools()` contains `mcp__fixture__echo` with the passthrough schema, `getActiveToolNames()` includes it, system prompt does not mention it (no promptSnippet); disabled server (`enabled: false`) registers nothing; `unregisterTool` path: trigger `--list-changed` fixture behavior, assert the tool disappears from `getAllTools()`.
6. **`test/suite/mcp-tools.test.ts` (new)** — agent-level via `test/suite/harness.ts` `createHarness` and the faux provider (`registerFauxProvider` / `FauxResponseStep` from `@earendil-works/pi-ai/compat`; the faux provider emits `{ type: "toolCall", ... }` steps, verified in `packages/ai/src/providers/faux.ts`): queue a response whose step is a tool call to `mcp__fixture__echo`; run a turn; assert the tool result message content contains the fixture's echo and the turn completes; negative scenario: server configured but `enabled: false` → faux tool call to `mcp__fixture__echo` yields a "Tool ... not found" error result.
7. Run everything through `./scripts/test.sh` (repo root) — the AGENTS.md-sanctioned non-e2e runner — and iterate until green.

## Changelog

Draft entries for `packages/coding-agent/CHANGELOG.md`, appended to the existing `## [Unreleased]` sections (do not duplicate headers; current file already has `### Added` with three entries and `### Changed`/`### Fixed`):

```markdown
### Added

- Added MCP client support: configure MCP servers under `mcpServers` in settings (stdio `command`/`args`/`env` and Streamable HTTP `url`/`headers` with `${ENV}` expansion). Tools are discovered at session start and registered as `mcp__<server>__<tool>`. Per-server `enabled`, `required`, `startupTimeoutMs`, `toolTimeoutMs`, `includeTools`/`excludeTools`; project-scope stdio servers require first-run consent showing the exact command. `/mcp` shows status and reconnects. No new dependencies.
- Added `pi.unregisterTool(name)` to the extension API so extensions can remove previously registered tools (used for MCP `list_changed` reconciliation).
```

## Risks and open questions

- **Spec churn**: the 2026-07-28 revision removes the handshake this client implements. Servers migrating to the stateless generation will start failing `initialize`. Mitigation: the protocol version is a single constant; a future change can probe with `initialize` and fall back. Open: when to dual-stack — decide after the stateless generation sees real adoption.
- **Prompt injection via server-controlled text**: descriptions, annotations, and results are untrusted and land in model context. v1 mitigations: length caps, no annotation/instructions splicing, results truncated. Not mitigated: a malicious description can still instruct the model. Open: whether pi wants an opt-in "MCP descriptions are untrusted" system-prompt guideline.
- **Security review burden**: this feature executes arbitrary configured commands and parses foreign protocols. Consent covers project scope only; a user's global config is trusted by fiat. The `npx -y server` pattern also implies supply-chain trust in whatever npm serves. Flag for maintainer security review before release.
- **TypeBox vs full JSON Schema**: pi's `validateToolArguments` handles Kind-less schemas via coercion + `Compile`, but exotic keywords (`$ref` to external documents, `if/then/else`) may validate loosely or fail. Mitigation: on registration, if `Compile` throws (probe in a try/catch during mapping), fall back to wrapping the schema as `Type.Object({}, { additionalProperties: true })`-style permissive parameters so the tool remains callable and the server does its own validation.
- **Orphaned children**: if pi itself crashes (not clean shutdown), stdio children survive. The `process.on("exit")` hook covers normal exits only. Same exposure as the bash tool's background processes; acceptable.
- **Open questions**: (1) is the GET SSE stream needed in practice for timely `list_changed` on HTTP servers, or is reconnect-on-demand enough? (2) should `unregisterTool` be documented as public extension API or kept internal-ish? (3) exact consent-store filename/format (`mcp-consent.json` proposed); (4) whether the `/mcp` command should also offer disable-per-session (currently settings-only).

## Acceptance criteria

- [ ] A stdio MCP server configured in settings (`command`/`args`) is spawned at session start, completes the 2025-06-18 handshake, and its tools appear in `session.getAllTools()` as `mcp__<server>__<tool>` with the server's JSON Schema passed through as `parameters`.
- [ ] A Streamable HTTP server (`url`, optional `headers` with `${ENV}` expansion) connects over POST with `Accept: application/json, text/event-stream`, parses both JSON and SSE responses, echoes `Mcp-Session-Id` and `MCP-Protocol-Version`, and re-initializes once on 404.
- [ ] Calling a mapped tool round-trips: model tool call → `tools/call` → `content[]` mapped to pi `TextContent`/`ImageContent` (other types JSON-dumped; `structuredContent` appended when content is empty); `isError: true` surfaces as a model-visible error result.
- [ ] `tools/list` pagination (cursor loop) is exercised by tests; `list_changed` re-lists and reconciles: new tools registered, removed tools unregistered via the new `pi.unregisterTool`.
- [ ] Per-call timeout (`toolTimeoutMs`) and abort (signal → `notifications/cancelled`) both reject promptly; a crashed server marks itself failed, subsequent calls fail fast with a reconnect hint, and no automatic restart loop occurs.
- [ ] `enabled: false`, `includeTools`/`excludeTools`, per-server and total tool caps all reduce what is registered; disabled/misconfigured servers never crash the session and produce a visible warning.
- [ ] Project-scope stdio servers prompt for first-run consent showing the exact command in interactive mode, persist the decision under the agent dir, re-prompt when the command changes, and are skipped with a warning headless or when declined; global-scope stdio and all HTTP servers connect without the extra prompt.
- [ ] Zero MCP behavior when no `mcpServers` is configured; `--no-extensions` and `enableMcp: false` fully disable the feature; all stdio children are killed on `session_shutdown` (stdin-close → SIGTERM → SIGKILL ladder).
- [ ] No new runtime dependencies: `packages/coding-agent/package.json` `dependencies` and `npm-shrinkwrap.json` are unchanged in the diff.
- [ ] All new code uses erasable TypeScript syntax only (no enums, namespaces, parameter properties, or import-equals) and top-level imports only; `npm run check` is clean.
- [ ] Tests from the testing plan pass via `./scripts/test.sh` (or targeted vitest runs), using only local fixture processes and localhost HTTP; no real providers or network.
