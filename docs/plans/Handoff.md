# Handoff: bundling pi-subagents into Yupi

Task: vendor [tintinweb/pi-subagents](https://github.com/tintinweb/pi-subagents) into Yupi as an extension that loads by default (source + license shipped in the package, no runtime download).

Status: complete except commit.

## Done

- Vendored source at `packages/coding-agent/vendor/pi-subagents/` (`src/`, `LICENSE` MIT, `README.md` with upstream revision `e955e29c51b7a6cce37e1108cd2d6c57a77e151c`, 0.19.0). `package.json` `files` now includes `vendor`. Added vendor runtime deps `croner@10.0.1`, `nanoid@5.1.16`; regenerated `package-lock.json`, `packages/coding-agent/npm-shrinkwrap.json`, `packages/coding-agent/install-lock/package-lock.json` (verified by `npm run check`).
- Default loading: `src/core/resource-loader.ts` merges `join(getPackageDir(), "vendor", "pi-subagents", "src", "index.ts")` into extension paths in both `reload()` and `getExtensions()` flows, unless `noExtensions` (`--no-extensions`).
- Local adaptations (documented in `vendor/pi-subagents/README.md`):
  - Yupi config/env paths; no implicit Pi/shared dir discovery (`configCwd`).
  - Model policy: explicit model selections (agent file frontmatter or per-call `model`) fail hard when unavailable (`Model not found or unavailable: ...`), no silent provider/model substitution; `model: inherit` keeps parent model; per-call override beats agent-file model; parent model never changed.
  - Error signaling: tools throw instead of returning `isError: true` (host contract, `docs/extensions.md` line ~2023: returned values never set the error flag). Fixed in `index.ts` (Agent tool model resolution), `nested-tools.ts` (`textResult(text, isError)` now throws), `structured-output.ts` (schema mismatch), `mention-clone.ts` (double-spawn guard).
  - `typebox` host import, `.ts` relative imports, static imports only.
- Tests:
  - NEW `test/bundled-subagents.test.ts`: extension loads (trust bootstrap true/false), registers `Agent`, `get_subagent_result`, `steer_subagent`, `SubagentWorkflow` tools + `/agents` command; `noExtensions` opt-out works.
  - NEW `test/suite/bundled-subagents.test.ts` (harness + faux provider): child runs agent-file model, per-call override, `inherit`; unavailable model in agent file and in per-call override each produce an `isError` tool result; parent model unchanged; `.pi`/`.agents` dirs ignored (uses `.yupi/agents`); both `extensions: false/true` inheritance modes.
  - UPDATED `test/resource-loader.test.ts`: expectations include `bundledSubagentsPath` (ordering, dedupe, `/agents` command excluded from conflict assertions).
  - UPDATED `test/default-tools-setting.test.ts`: tool lists/active names include the 4 bundled tools (`tools: [...]` allowlist still filters them out; `noTools: "all"` still yields empty).
  - UPDATED `test/suite/regressions/3592-no-builtin-tools-keeps-extension-tools.test.ts`: bundled tools stay active with `noTools: "builtin"`; system prompt lists them instead of `(none)`.
  - UPDATED `test/suite/regressions/6260-inline-extension-naming.test.ts`: filters the bundled extension path out of `getExtensions()` (suite only asserts inline factory naming).
- Changelog entry under `## [Unreleased]` → `### Added` in `packages/coding-agent/CHANGELOG.md`.
- `npm run check` passes fully (biome, pinned deps, runtime deps, ts imports, entry graphs, shrinkwrap, install-lock, tsgo, browser smoke).
- Full-suite verification (`./scripts/test.sh`, log `/tmp/yupi-test-final.log`): 47 failures, all accounted for:
  - 43 identical to the clean-HEAD baseline failures (fork-rename artifacts: "valid pi session" vs "yupi session", `.pi` config-dir paths, `package-command-paths`, etc.).
  - 4 ours-only in that run, all verified as pre-existing flakes, NOT regressions: `interactive-tui` "styles fullscreen viewport rows" fails identically on clean HEAD in isolation; 3 `experimental-remote-runtime` tests pass in isolation on our tree (file has 13-14 baseline failures of its own and flips run-to-run — one baseline failure passed in our run).
  - Baseline worktree removed after verification.

## Left to do

1. Open question: settings-level opt-out for the bundled extension (currently only `--no-extensions`). Decide if wanted.
2. Commit when asked. Files: `packages/coding-agent/package.json`, lockfiles (pre-commit needs `PI_ALLOW_LOCKFILE_CHANGE=1`), `src/core/resource-loader.ts`, `test/resource-loader.test.ts`, `vendor/` (untracked), `test/bundled-subagents.test.ts`, `test/suite/bundled-subagents.test.ts`, `test/default-tools-setting.test.ts`, `test/suite/regressions/3592-no-builtin-tools-keeps-extension-tools.test.ts`, `test/suite/regressions/6260-inline-extension-naming.test.ts`, `CHANGELOG.md`. Suggested message: `feat(coding-agent): bundle pi-subagents extension and load it by default`.
