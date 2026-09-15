# Yupi Fullscreen Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development for the
> isolated integration task; the primary agent owns presentation and validation.

**Goal:** Deliver a Crush-inspired Yupi fullscreen interface as the default,
while retaining regular mode and Yupi's agent behavior.

**Architecture:** Compose a new presentation around the existing chat viewport.
Keep the existing interactive leaf containers and state subscriptions. Add an
optional renderer background without changing unconfigured TUI consumers.

**Tech Stack:** TypeScript, pi-tui, Vitest, node:test, tmux.

**Spec:** `docs/superpowers/specs/2026-09-14-yupi-fullscreen-design.md`

## Global constraints

- No dependency changes, paid API calls, branch switches, or commits. The user
  explicitly approved `npm run build` after source verification.
- Preserve other sessions' changes. Read files before editing.
- Top-level imports, erasable TypeScript, configurable keybindings.
- Run modified tests, then full `npm run check`.

### Task 1: Responsive presentation (primary agent)

Create `packages/coding-agent/src/modes/interactive/fullscreen-shell.ts` and
`packages/coding-agent/test/fullscreen-shell.test.ts`.

The factory interface is:

```ts
createFullscreenShell(options: ChatViewportOptions & {
  getState: () => FullscreenShellState;
  showWelcome?: () => boolean;
}): ChatViewport;
```

`FullscreenShellState` supplies cwd, optional sessionName/model/provider/
thinkingLevel/branch, optional nullable contextPercent/contextTokens,
optional contextWindow, isWorking, and hasMessages. The shell consumes existing
leaf components and returns the existing transcript ScrollView plus its root.

- [x] Write failing layout tests using real `renderLayoutFrame` and `Text`
  components: sidebar appears at 140x40, disappears at 80x24, editor stays
  pinned while transcript scrolls, narrow lines fit, state changes update.
- [x] Build the header, sidebar and welcome with theme functions, width-safe
  strings and HStack/VStack. Reuse createChatViewport for the dock.
- [x] Run `node ../../node_modules/vitest/dist/cli.js --run test/fullscreen-shell.test.ts`
  from packages/coding-agent until passing.
- [x] Update the existing dark palette with charcoal backgrounds and violet
  accents; retain theme token names and explicit user theme selection.

### Task 2: Interactive and renderer integration (integration worker)

Own interactive-mode.ts, tui-renderer.ts, tui-alt-screen.ts, and their focused
tests. Read all edited files in full first.

- [x] Integrate Task 1's factory with live getters, preserving leaf containers
  and transcript ScrollView ownership. Hide only the built-in startup banner
  in fullscreen; preserve extension headers and loaded-resource diagnostics.
- [x] Add optional `background?: (text: string) => string` to TuiAltScreenOptions.
  Use applyBackgroundToLine for viewport rows and preserve images and explicit
  component/selection backgrounds. Leave unconfigured renderers unchanged.
- [x] Wire the coding-agent renderer background to theme.customMessageBg.
- [x] Write and run focused background tests, including explicit nested
  backgrounds and terminal resize. Run relevant interactive TUI tests.

### Task 3: Defaults, documentation, verification (primary agent)

Own settings-manager.ts, settings-manager.test.ts, CLI help, documentation,
and the coding-agent Unreleased changelog.

- [x] Change the existing default assertion to fullscreen and observe failure.
  Preserve coverage of explicit regular mode and persistence.
- [x] Implement the fallback as:

```ts
return this.settings.tuiMode === "regular" ? "regular" : "fullscreen";
```

- [x] Update CLI/help documentation to describe fullscreen as default and
  regular as available through `--tui-mode regular` and `/settings`.
- [x] Run relevant offline tests, `npm run check`, and tmux UI checks at wide,
  narrow and short terminal sizes, including selectors and mode switching.
- [x] Review the resulting diff and confirm other sessions' edits are intact.
  Request an independent review of the new presentation and integration.

## Verification result

- `npm run check` passed, including formatting, type checks, dependency/entry
  checks, generated lock metadata checks, and the browser import smoke check.
- Seven focused coding-agent test files passed (165 tests); the alternate-screen
  renderer suite passed (62 tests). No full test suite or paid provider calls ran.
- Live source TUI verified at 140x40, 80x24, and 30x10. The sidebar hides when
  space is constrained, input survives resizing, `/settings` switches in both
  directions, and Bash execution changes the header from Working back to Ready.
- Independent review identified quiet-startup spacing and Bash activity state;
  both were fixed. Nested background resets are covered with actual terminal
  cell assertions, including RGB payloads containing zeroes and resizing.
- Existing unrelated branding, provider, and resource-discovery edits remain
  untouched. No commits were created.

After explicit user approval, `npm run build` passed and refreshed the bundle
used by `/Users/tmpjolley/.local/bin/yupi`. The installed command's help reports
fullscreen as default, and an isolated tmux launch displays the new header,
sidebar, and composer. A local Bash command completes inside the installed TUI.
The installed `--tui-mode regular` override also opens the regular interface.
The build produced no additional tracked source changes.
