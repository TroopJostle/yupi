import { homedir } from "node:os";
import { basename } from "node:path";
import {
	Box,
	type Component,
	Container,
	HStack,
	ScrollView,
	stripTerminalSequences,
	truncateToWidth,
	VStack,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { APP_NAME } from "../../config.ts";
import { type ChatViewport, type ChatViewportOptions, createChatViewport } from "./chat-viewport.ts";
import { formatCwdForFooter, formatTokens } from "./components/footer.ts";
import { keyHint } from "./components/keybinding-hints.ts";
import { theme } from "./theme/theme.ts";

/** Presentation data only. The interactive host owns sessions, tools and subscriptions. */
export interface FullscreenShellState {
	cwd: string;
	sessionName?: string;
	model?: string;
	provider?: string;
	thinkingLevel?: string;
	contextPercent?: number | null;
	contextTokens?: number | null;
	contextWindow?: number;
	isWorking: boolean;
	hasMessages: boolean;
	branch?: string | null;
}

function singleLine(text: string): string {
	return stripTerminalSequences(text).replace(/\s+/g, " ").trim();
}

/** A responsive frame around the existing chat and input components. */
export function createFullscreenShell(
	options: ChatViewportOptions & { getState: () => FullscreenShellState; showWelcome?: () => boolean },
): ChatViewport {
	const header: Component = {
		invalidate() {},
		render(width) {
			const state = options.getState();
			const name = theme.bold(theme.fg("accent", APP_NAME.toUpperCase()));
			const project = theme.fg("muted", singleLine(basename(state.cwd) || state.cwd));
			const left = ` ${name} ${theme.fg("borderMuted", "╱")} ${project}`;
			const activity = theme.fg(state.isWorking ? "accent" : "success", state.isWorking ? "Working" : "Ready");
			const model = state.model ? `${theme.fg("muted", singleLine(state.model))}  ` : "";
			const right = `${model}${activity} `;
			const gap = width - visibleWidth(left) - visibleWidth(right);
			const line = gap >= 2 ? left + " ".repeat(gap) + right : `${left}  ${activity}`;
			return [truncateToWidth(line, width), theme.fg("borderMuted", "─".repeat(width))];
		},
	};
	const sidebar: Component = {
		invalidate() {},
		render(width) {
			const state = options.getState();
			const contentWidth = Math.max(1, width - 4);
			const row = (text: string) => theme.fg("borderMuted", "│ ") + truncateToWidth(` ${text}`, width - 2);
			const section = (text: string) => theme.fg("muted", text);
			const value = (text: string) => theme.fg("text", singleLine(text));
			const percent = state.contextPercent;
			const known = typeof percent === "number" && Number.isFinite(percent);
			const contextColor = known && percent >= 90 ? "error" : known && percent >= 70 ? "warning" : "accent";
			const barWidth = Math.min(20, contentWidth);
			const filled = known ? Math.round((Math.max(0, Math.min(100, percent)) / 100) * barWidth) : 0;
			const contextLabel = known ? `${Math.round(percent)}% used` : "Unknown";
			const tokenLabel = `${state.contextTokens == null ? "?" : formatTokens(state.contextTokens)} / ${
				state.contextWindow ? formatTokens(state.contextWindow) : "?"
			} tokens`;
			const cwd = singleLine(formatCwdForFooter(state.cwd, homedir()));
			const lines = [
				"",
				theme.fg("accent", "█ █ █ █ █▀█ █"),
				theme.fg("borderAccent", "▀█▀ █ █ █▀▀ █"),
				theme.fg("border", " ▀  ▀▀▀ ▀   ▀"),
				"",
				section("SESSION"),
				value(state.sessionName || "New session"),
				"",
				section("WORKSPACE"),
				value(cwd),
				...(state.branch ? [theme.fg("muted", `⑂ ${singleLine(state.branch)}`)] : []),
				"",
				section("MODEL"),
				value(state.model || "Select with /model"),
				...(state.provider ? [theme.fg("muted", singleLine(state.provider))] : []),
				...(state.thinkingLevel ? [theme.fg("muted", `Thinking ${singleLine(state.thinkingLevel)}`)] : []),
				"",
				section("CONTEXT"),
				theme.fg(contextColor, contextLabel),
				theme.fg(contextColor, "━".repeat(filled)) + theme.fg("borderMuted", "─".repeat(barWidth - filled)),
				theme.fg("muted", tokenLabel),
				"",
				theme.fg("dim", "/model     change model"),
				theme.fg("dim", "/resume    open a session"),
				theme.fg("dim", "/settings  preferences"),
			];
			return lines.map(row);
		},
	};
	const welcome: Component = {
		invalidate() {},
		render(width) {
			if (options.getState().hasMessages || options.showWelcome?.() === false) return [];
			return [
				"",
				` ${theme.bold(theme.fg("text", "What are we building?"))}`,
				` ${theme.fg("muted", "Ask a question, describe a change, or explore this project.")}`,
				"",
				` ${theme.fg("accent", "/model")} ${theme.fg("dim", "choose a model")}   ${theme.fg("accent", "/resume")} ${theme.fg("dim", "pick up a session")}`,
				"",
			].map((line) => truncateToWidth(line, width));
		},
	};
	const document = new Container();
	document.addChild(welcome);
	document.addChild(options.document);
	const composer = new Box(0, 0, (text) => theme.bg("userMessageBg", text));
	composer.addChild(options.editor);
	const footer = new Container();
	footer.addChild(options.footer);
	footer.addChild({
		invalidate() {},
		render: (width) => [
			truncateToWidth(
				` ${keyHint("tui.input.submit", "send")}  ${keyHint("tui.input.newLine", "newline")}  ${theme.fg("dim", "/ commands")}`,
				width,
			),
		],
	});
	const viewport = createChatViewport({ ...options, document, editor: composer, footer });
	return {
		transcript: viewport.transcript,
		root: new VStack([
			{ component: header, basis: 2, shrink: 1, minSize: 0, visible: ({ height }) => height >= 10 },
			{
				component: new HStack([
					{ component: viewport.root, basis: 0, grow: 1, minSize: 1 },
					{
						component: new ScrollView(sidebar, { overscroll: "contain", scrollbar: "hidden" }),
						basis: 30,
						shrink: 0,
						visible: ({ width, height }) => width >= 110 && height >= 24,
					},
				]),
				basis: 0,
				grow: 1,
				minSize: 1,
			},
		]),
	};
}
