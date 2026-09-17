import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

// Observation only: no tool registration, prompt changes, payload changes,
// model-visible messages, or return values from event handlers.
export default function debugTrace(pi) {
  const root = resolve(process.env.PI_DEBUG_LOG_DIR || join(homedir(), ".pi/agent/debug/pidor"));
  const launcher = process.env.PI_DEBUG_LAUNCHER || "./pi-debug";
  let directory;
  let requests = 0;
  let calls = 0;
  let failuresReported = false;

  function initialize() {
    if (directory) return;
    mkdirSync(root, { recursive: true, mode: 0o700 });
    directory = mkdtempSync(join(root, `${new Date().toISOString().replace(/[:.]/g, "-")}-`));
    writeFileSync(join(root, "latest"), `${join(directory, "trace.log")}\n`, { mode: 0o600 });
  }

  function record(event, data, summary, ctx) {
    try {
      initialize();
      const timestamp = new Date().toISOString();
      appendFileSync(join(directory, "events.jsonl"), `${JSON.stringify({ timestamp, ...data, event })}\n`, { mode: 0o600 });
      if (summary) {
        appendFileSync(join(directory, "trace.log"), `${timestamp} ${summary}\n`, { mode: 0o600 });
      }
    } catch (error) {
      if (!failuresReported) {
        failuresReported = true;
        const message = `Debug trace could not write its log: ${error.message}`;
        if (ctx.hasUI) ctx.ui.notify(message, "error");
        else process.stderr.write(`${message}\n`);
      }
    }
  }

  function status(ctx, text) {
    if (ctx.hasUI) ctx.ui.setStatus("pi-debug", `trace: ${text}`);
  }

  pi.on("session_start", (event, ctx) => {
    record("session_start", {
      reason: event.reason, cwd: ctx.cwd,
      sessionFile: ctx.sessionManager.getSessionFile(),
      model: ctx.model?.id, provider: ctx.model?.provider,
      activeTools: pi.getActiveTools(),
    }, `START ${ctx.model?.provider}/${ctx.model?.id}; tools=${pi.getActiveTools().join(",") || "none"}`, ctx);
    if (directory) {
      const message = `Debug trace: ${directory}\nUse /trace for the path; ${launcher} --follow shows live activity.`;
      if (ctx.hasUI) ctx.ui.notify(message, "info");
      else process.stderr.write(`${message}\n`);
    }
    status(ctx, "ready");
  });

  pi.on("before_agent_start", (event, ctx) => {
    const files = event.systemPromptOptions?.contextFiles?.map(file => file.path) || [];
    record("before_agent_start", {
      prompt: event.prompt, systemPrompt: event.systemPrompt,
      systemPromptOptions: event.systemPromptOptions,
    }, `PROMPT; automatically loaded context files=${files.length}${files.length ? ` ${JSON.stringify(files)}` : ""}`, ctx);
    status(ctx, `${files.length} context files; preparing request`);
  });

  pi.on("before_provider_request", (event, ctx) => {
    requests += 1;
    const filename = `request-${String(requests).padStart(4, "0")}.json`;
    record("before_provider_request", {
      request: requests, file: filename, model: ctx.model?.id,
      provider: ctx.model?.provider, activeTools: pi.getActiveTools(),
    }, `REQUEST ${requests} -> ${ctx.model?.provider}/${ctx.model?.id}; full body: ${filename}`, ctx);
    try {
      initialize();
      writeFileSync(join(directory, filename), JSON.stringify(event.payload, null, 2), { mode: 0o600 });
    } catch (error) {
      record("trace_error", { message: error.message }, `ERROR saving request: ${error.message}`, ctx);
    }
    status(ctx, `request ${requests}; waiting for model`);
  });

  pi.on("after_provider_response", (event, ctx) => {
    // Authentication and response headers are deliberately not logged.
    record("after_provider_response", { status: event.status }, `RESPONSE HTTP ${event.status}`, ctx);
    status(ctx, `request ${requests}; receiving response`);
  });

  pi.on("tool_call", (event, ctx) => {
    calls += 1;
    record("tool_call", event, `TOOL ${event.toolName} ${JSON.stringify(event.input)}`, ctx);
    status(ctx, `${event.toolName} ${String(event.input?.path || event.input?.command || "").replace(/\s+/g, " ").slice(0, 100)}`);
  });

  pi.on("tool_execution_update", (event, ctx) => {
    record("tool_execution_update", event, `PROGRESS ${event.toolName}; partial result in events.jsonl`, ctx);
  });

  pi.on("tool_result", (event, ctx) => {
    record("tool_result", event, `RESULT ${event.toolName} ${event.isError ? "ERROR" : "OK"}; full result in events.jsonl`, ctx);
  });

  pi.on("message_end", (event, ctx) => {
    record("message_end", event, event.message?.role === "assistant" ? `ASSISTANT ${event.message.stopReason || "message complete"}` : undefined, ctx);
  });

  pi.on("agent_settled", (_event, ctx) => {
    record("agent_settled", { requests, toolCalls: calls }, `IDLE; total requests=${requests}; tool calls=${calls}`, ctx);
    status(ctx, `idle; ${requests} requests; ${calls} tool calls`);
  });

  pi.on("session_shutdown", (_event, ctx) => {
    record("session_shutdown", {}, "SESSION CLOSED", ctx);
  });

  pi.registerCommand("trace", {
    description: "Show the local debug trace location",
    handler: async (_args, ctx) => {
      ctx.ui.notify(directory || "No trace created yet.", "info");
    },
  });
}
