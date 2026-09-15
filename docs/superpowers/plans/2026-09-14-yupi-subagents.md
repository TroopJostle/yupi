# Default subagents in Yupi

**Goal:** Ship the fork of tintinweb/pi-subagents with Yupi, including independent model selection for each child.

**Approved design:** The user approved bundling subagents by default. Keep the upstream extension as a vendored, attributed source snapshot so installation does not fetch executable code at startup. Load it through Yupi's existing extension loader and respect `--no-extensions`. Use `.yupi` project configuration and `getAgentDir()` for user configuration. Explicit model choices must resolve to an available model or return an actionable error, never silently select a different provider or the parent model.

**Constraints:** Do not commit. Preserve existing work. Pin new dependencies, install with scripts disabled, and regenerate distribution locks. Do not run the build or full test suite. Test with local faux providers, then run `npm run check`.

## Implementation

1. Vendor the fork at a recorded revision with its MIT license and add the runtime dependencies required by the extension. Adapt configuration discovery to Yupi and remove dynamic imports from the shipped source.
2. Add the shipped extension path to default resource loading, including the trust bootstrap path. Keep the normal extension opt-out and deduplication behavior. Include the vendor directory in package assets.
3. Make configured and per-call model selection deterministic. An omitted model or `inherit` uses the parent. A provider-qualified model must stay on that provider; invalid choices fail before inference.
4. Add focused tests that load the default extension, verify opt-out and Yupi configuration discovery, and execute children with distinct faux models while leaving the parent unchanged.
5. Document `/agents`, agent files, model precedence, and provenance. Run focused tests and `npm run check`; inspect the final diff and leave changes uncommitted.
