# Yupi local setup

Yupi is a personal fork of Pi. The CLI identifies itself as `yupi` and stores
settings and sessions in `~/.yupi/agent/`.

## Build and install from this checkout

```sh
npm ci --ignore-scripts
npm run build
mkdir -p "$HOME/.local/bin"
ln -s "$PWD/packages/coding-agent/dist/bundle/cli.js" "$HOME/.local/bin/yupi"
```

Keep `~/.local/bin` on your PATH. The command runs this checkout's build, so
rebuild after source changes. Nothing needs to be published.

## Providers

- Codex subscription: run `/login openai-codex` inside Yupi.
- Z.ai Coding Plan (international): run `/login zai` and enter your Coding Plan key.
- Switch models using `/model` or cycle scoped models with Ctrl+P.

```sh
yupi
yupi --provider zai --model glm-5.3
```

Yupi stores its own credentials in `~/.yupi/agent/auth.json`. On this machine,
the Codex and Z.ai credentials were copied once during setup; the file is not
linked to Pi. Credentials must remain outside this repository.

Skills are discovered only in `~/.yupi/agent/skills` and the current project's
`.yupi/skills`. Shared `~/.agents/skills`, ancestor `.agents/skills`, and `.pi`
directories are not auto-loaded. Additional skill paths must be explicitly configured.

The current local default is `openai-codex/gpt-5.6-terra`, with Codex and Z.ai
models enabled for cycling. These preferences live in `~/.yupi/agent/settings.json`.
