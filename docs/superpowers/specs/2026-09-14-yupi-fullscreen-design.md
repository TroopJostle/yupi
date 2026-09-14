# Yupi fullscreen presentation

The user approved retaining Yupi's agent behavior, adopting Crush's visual style,
and making fullscreen the default while retaining regular mode.

## Presentation

- Use the existing TypeScript TUI and agent/session implementation.
- Use charcoal surfaces, violet and magenta accents, readable muted text, and
  restrained tool-result backgrounds. Keep light and custom themes usable.
- Keep the transcript independently scrollable above the existing input dock.
- Add a compact fixed header and a 30-column session/model/context sidebar.
  Hide the sidebar below 110 columns or 24 rows; keep essential model/status
  information in the header/footer at smaller sizes.
- Preserve extension headers, editors, footers, widgets, commands, paste,
  selection, working indicators, and exit transcript behavior.
- Replace the large default startup banner visually in fullscreen; retain it in
  regular mode. Show an empty-session welcome with useful existing commands.
- Read sidebar state at render time. Do not add provider calls or filesystem
  polling to rendering. Display unavailable context usage as unknown.

## Defaults and validation

Fullscreen is the fallback when no valid mode is configured. An explicit
`regular` setting or `--tui-mode regular` continues to select regular mode.
Existing custom theme choices remain respected.

Verify default/override settings, wide and narrow layout, constrained height,
scrolling with a fixed composer, live sidebar values, and background rendering.
Use offline tests and tmux with isolated settings; no paid provider requests.
Run `npm run check`; do not run `npm run build`, `npm test`, or commit.

## Workspace decision

Work in the current checkout with explicit file ownership. Existing uncommitted
Yupi branding, provider, and trust changes belong to another session and must
be preserved. Do not switch branches or create commits.
