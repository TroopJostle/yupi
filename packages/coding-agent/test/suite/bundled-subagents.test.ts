import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { DefaultResourceLoader } from "../../src/core/resource-loader.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";
import { createHarness, getMessageText } from "./harness.ts";

describe("Yupi subagent model selection", () => {
	it.each([false, true])("selects child models independently (inherit extensions: %s)", async (inheritExtensions) => {
		const directory = mkdtempSync(join(tmpdir(), "yupi-models-"));
		const agentDir = join(directory, "user");
		vi.stubEnv("YUPI_CODING_AGENT_DIR", agentDir);
		const loader = new DefaultResourceLoader({
			cwd: directory,
			agentDir,
			settingsManager: SettingsManager.inMemory(),
		});
		await loader.reload();
		expect(loader.getExtensions().errors).toEqual([]);
		const harness = await createHarness({
			resourceLoader: loader,
			models: [{ id: "parent" }, { id: "fast-child" }, { id: "deep-child" }],
		});
		try {
			const provider = harness.getModel().provider;
			const agentsDir = join(harness.tempDir, ".yupi", "agents");
			mkdirSync(agentsDir, { recursive: true });
			writeFileSync(
				join(agentsDir, "worker.md"),
				`---\nname: worker\ndescription: Test worker\nmodel: ${provider}/fast-child\ntools: none\nextensions: ${inheritExtensions}\npersist_session: false\noutput_transcript: false\n---\nComplete the assigned task.`,
			);
			for (const configDir of [".pi", ".agents"]) {
				const otherAgents = join(harness.tempDir, configDir, "agents");
				mkdirSync(otherAgents, { recursive: true });
				writeFileSync(
					join(otherAgents, "worker.md"),
					`---\nmodel: ${provider}/deep-child\n---\nWrong configuration directory.`,
				);
			}
			writeFileSync(
				join(agentsDir, "invalid.md"),
				`---\nmodel: unavailable-provider/fast-child\n---\nMust not run.`,
			);
			await harness.session.bindExtensions({});
			const observedModels: string[] = [];
			const childResponse = (_context: unknown, _options: unknown, _state: unknown, model: { id: string }) => {
				observedModels.push(model.id);
				return fauxAssistantMessage(`Handled by ${model.id}`);
			};
			harness.setResponses([
				fauxAssistantMessage(
					fauxToolCall("Agent", {
						subagent_type: "worker",
						description: "configured",
						prompt: "first",
						run_in_background: false,
					}),
					{ stopReason: "toolUse" },
				),
				childResponse,
				fauxAssistantMessage(
					fauxToolCall("Agent", {
						subagent_type: "worker",
						description: "override",
						prompt: "second",
						model: `${provider}/deep-child`,
						run_in_background: false,
					}),
					{ stopReason: "toolUse" },
				),
				childResponse,
				fauxAssistantMessage(
					fauxToolCall("Agent", {
						subagent_type: "worker",
						description: "inherit",
						prompt: "third",
						model: "inherit",
						run_in_background: false,
					}),
					{ stopReason: "toolUse" },
				),
				childResponse,
				fauxAssistantMessage(
					fauxToolCall("Agent", {
						subagent_type: "invalid",
						description: "invalid config",
						prompt: "must fail",
						run_in_background: false,
					}),
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage(
					fauxToolCall("Agent", {
						subagent_type: "worker",
						description: "invalid override",
						prompt: "must fail",
						model: "unavailable-provider/fast-child",
						run_in_background: false,
					}),
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage("done"),
			]);
			await harness.session.prompt("Delegate both tasks");
			const results = harness.session.messages
				.filter((message) => message.role === "toolResult")
				.map(getMessageText);
			expect(results.join("\n")).toContain("Handled by fast-child");
			expect(results.join("\n")).toContain("Handled by deep-child");
			expect(observedModels).toEqual(["fast-child", "deep-child", "parent"]);
			expect(
				results
					.slice(-2)
					.every((result) => result.includes('Model not found or unavailable: "unavailable-provider/fast-child"')),
			).toBe(true);
			expect(
				harness.session.messages.filter((message) => message.role === "toolResult" && message.isError),
			).toHaveLength(2);
			expect(harness.session.model?.id).toBe("parent");
			expect(harness.getPendingResponseCount()).toBe(0);
		} finally {
			await harness.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
			harness.cleanup();
			loader.getExtensions().runtime.invalidate();
			vi.unstubAllEnvs();
			rmSync(directory, { recursive: true, force: true });
		}
	});
});
