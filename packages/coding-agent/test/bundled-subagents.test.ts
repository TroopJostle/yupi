import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

const temporaryDirectories: string[] = [];

afterEach(() => {
	vi.unstubAllEnvs();
	for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("bundled subagents", () => {
	it.each([false, true])("loads the shipped tools and command (trust bootstrap: %s)", async (bootstrap) => {
		const cwd = mkdtempSync(join(tmpdir(), "yupi-subagents-test-"));
		temporaryDirectories.push(cwd);
		const agentDir = join(cwd, "user");
		vi.stubEnv("YUPI_CODING_AGENT_DIR", agentDir);
		const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager: SettingsManager.inMemory() });
		await loader.reload(bootstrap ? { resolveProjectTrust: async () => false } : undefined);
		const result = loader.getExtensions();
		expect(result.errors).toEqual([]);
		const subagents = result.extensions.filter((extension) => extension.tools.has("Agent"));
		expect(subagents).toHaveLength(1);
		expect([...subagents[0].tools.keys()]).toEqual(
			expect.arrayContaining(["Agent", "get_subagent_result", "steer_subagent", "SubagentWorkflow"]),
		);
		expect(subagents[0].commands.has("agents")).toBe(true);
		result.runtime.invalidate();
	});

	it("respects noExtensions", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "yupi-subagents-test-"));
		temporaryDirectories.push(cwd);
		const loader = new DefaultResourceLoader({
			cwd,
			agentDir: join(cwd, "user"),
			settingsManager: SettingsManager.inMemory(),
			noExtensions: true,
		});
		await loader.reload();
		expect(loader.getExtensions().extensions).toEqual([]);
	});
});
