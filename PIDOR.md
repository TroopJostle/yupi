# Pidor

Pi source fork with the `pidor` command and `.pidor` configuration directory.
Normal Pi capabilities are enabled. No launcher flags disable tools, extensions,
skills, context files, or prompt templates.

Global configuration and sessions live in `~/.pidor/agent`. Project configuration
lives in `.pidor`. Existing `pi` installations and `~/.pi` settings are separate.

Build from this repository with `npm ci --ignore-scripts`,
`npm run hydrate:model-data`, and `npm run build:offline`. Point the `pidor`
command at `packages/coding-agent/dist/bundle/cli.js`.

The fork also handles the Google SDK's `TOO_MANY_TOOL_CALLS` finish reason as an
error, matching the raw string finish-reason handling and restoring compilation.
