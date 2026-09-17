# Pidor

Pi source fork with the `pidor` command and `.pidor` configuration directory.
The fork retains Pi's capabilities. This installation's `pidor` command uses
`~/.local/share/pidor/pidor-no-context` to supply a one-space system prompt,
disable automatic context/extension/skill/template loading, and explicitly load
a trace observer. Tools remain enabled. See [Local launch defaults](README.md#local-launch-defaults)
for the reasons, paths, selected-skill examples, and instructions for changing or
restoring defaults.

Global configuration and sessions live in `~/.pidor/agent`. Project configuration
lives in `.pidor`. Existing `pi` installations and `~/.pi` settings are separate.

Build from this repository with `npm ci --ignore-scripts`,
`npm run hydrate:model-data`, and `npm run build:offline`. Point the `pidor`
command at `packages/coding-agent/dist/bundle/cli.js`, directly for normal fork
discovery or through the documented launcher for the local minimal setup.

The fork also handles the Google SDK's `TOO_MANY_TOOL_CALLS` finish reason as an
error, matching the raw string finish-reason handling and restoring compilation.
