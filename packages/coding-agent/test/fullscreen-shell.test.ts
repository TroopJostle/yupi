import { Container, stripTerminalSequences, Text, visibleWidth } from "@earendil-works/pi-tui";
import { beforeEach, describe, expect, it } from "vitest";
import { renderLayoutFrame } from "../../tui/src/layout.ts";
import { createFullscreenShell, type FullscreenShellState } from "../src/modes/interactive/fullscreen-shell.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

function createFixture(overrides: Partial<FullscreenShellState> = {}, showWelcome?: () => boolean) {
	const state: FullscreenShellState = {
		cwd: "/work/yupi",
		sessionName: "Refine the terminal",
		model: "test-model",
		provider: "test-provider",
		thinkingLevel: "high",
		contextPercent: 25,
		contextTokens: 32000,
		contextWindow: 128000,
		branch: "main",
		isWorking: false,
		hasMessages: true,
		...overrides,
	};
	const document = new Text(Array.from({ length: 80 }, (_, index) => `Message ${index}`).join("\n"), 0, 0);
	const shell = createFullscreenShell({
		document,
		pendingMessages: new Container(),
		status: new Container(),
		editor: new Text("EDITOR\ninput\nend editor", 0, 0),
		footer: new Text("CUSTOM FOOTER", 0, 0),
		widgetsAbove: new Text("ABOVE WIDGET", 0, 0),
		widgetsBelow: new Text("BELOW WIDGET", 0, 0),
		scrollbar: "hidden",
		getState: () => state,
		showWelcome,
	});
	const render = (width = 140, height = 40) => {
		const frame = renderLayoutFrame(shell.root, width, height, () => {});
		expect(frame.lines.every((line) => visibleWidth(line) <= width)).toBe(true);
		return frame.lines.map(stripTerminalSequences);
	};
	return { state, document, shell, render };
}

describe("fullscreen shell", () => {
	beforeEach(() => initTheme("dark"));

	it("shows session details beside a wide transcript and keeps custom widgets", () => {
		const { render } = createFixture();
		const lines = render();
		const screen = lines.join("\n");
		expect(screen).toContain("YUPI");
		expect(screen).toContain("SESSION");
		expect(screen).toContain("Refine the terminal");
		expect(screen).toContain("test-provider");
		expect(screen).toContain("25%");
		expect(lines.findIndex((line) => line.includes("ABOVE WIDGET"))).toBeLessThan(
			lines.findIndex((line) => line.includes("EDITOR")),
		);
		expect(screen).toContain("BELOW WIDGET");
		expect(screen).toContain("CUSTOM FOOTER");
	});

	it.each([
		[80, 24],
		[109, 30],
		[140, 23],
		[30, 10],
		[12, 6],
	])("hides the sidebar at %i x %i and keeps the composer visible", (width, height) => {
		const screen = createFixture().render(width, height).join("\n");
		expect(screen).not.toContain("SESSION");
		expect(screen).toContain("EDITOR");
	});

	it("keeps the composer pinned while scrolling older messages and resizing", () => {
		const { shell, render } = createFixture();
		const initial = render();
		const editorRow = initial.findIndex((line) => line.includes("EDITOR"));
		expect(initial.join("\n")).toContain("Message 79");
		shell.transcript.scrollToStart();
		const scrolled = render();
		expect(scrolled.join("\n")).toContain("Message 0");
		expect(scrolled.findIndex((line) => line.includes("EDITOR"))).toBe(editorRow);
		expect(render(80, 24).join("\n")).toContain("Message 0");
	});

	it("updates session state on the next render and represents unknown context honestly", () => {
		const { state, render } = createFixture();
		render();
		state.model = "another-model";
		state.isWorking = true;
		state.contextPercent = null;
		state.contextTokens = null;
		const screen = render().join("\n");
		expect(screen).toContain("another-model");
		expect(screen).toContain("Working");
		expect(screen).toContain("Unknown");
		expect(screen).not.toContain("25%");
	});

	it("shows the welcome only for an empty conversation without hiding diagnostics", () => {
		const { state, document, render } = createFixture({ hasMessages: false });
		document.setText("A startup diagnostic");
		let screen = render().join("\n");
		expect(screen).toContain("What are we building?");
		expect(screen).toContain("A startup diagnostic");
		state.hasMessages = true;
		screen = render().join("\n");
		expect(screen).not.toContain("What are we building?");
		expect(screen).toContain("A startup diagnostic");
	});

	it("respects quiet startup while retaining session chrome and diagnostics", () => {
		const { document, render } = createFixture({ hasMessages: false }, () => false);
		document.setText("A startup diagnostic");
		const screen = render().join("\n");
		expect(screen).not.toContain("What are we building?");
		expect(screen).toContain("A startup diagnostic");
		expect(screen).toContain("SESSION");
	});
});
