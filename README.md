# Yupi

A TUI agent harness for working with code, right in your terminal.

Yupi puts your conversation, tools, and model controls in a fullscreen workspace: a scrollable transcript, a fixed composer, and a session sidebar when there's room. Switch providers, choose a reasoning level, and extend the harness with your own tools and skills.

## What you get

- **A fullscreen terminal workspace.** Charcoal surfaces, violet accents, a compact header, and a responsive sidebar with session, model, and context information. Regular terminal scrollback is available too.
- **Multiple model providers.** Use OpenAI, Anthropic, Google, Z.ai, and other supported providers through one agent runtime.
- **Model and reasoning controls.** `/model` switches models. `/thinking` selects from the current model's supported reasoning levels; `/thinking high` sets a level directly.
- **Tools and extensions.** Read and edit files, run shell commands, and add skills, prompt templates, themes, and extensions.
- **Resumable sessions.** Keep working across conversations with `/resume`, with Yupi's settings and sessions stored in `~/.yupi/agent/`.

## Get started

Requires Node.js **22.19.0 or newer**, npm, and Git. Build and run Yupi from this checkout:

```sh
git clone https://github.com/TroopJostle/yupi.git
cd yupi
npm ci --ignore-scripts
npm run build
mkdir -p "$HOME/.local/bin"
ln -s "$PWD/packages/coding-agent/dist/bundle/cli.js" "$HOME/.local/bin/yupi"
yupi
```

Keep `~/.local/bin` on your `PATH`. The `yupi` command points to this checkout's build, so rebuild after updating the source.

Inside Yupi, connect a provider and choose a model:

```text
/login openai-codex
/model
/thinking
```

For a Z.ai Coding Plan, use `/login zai` and enter your Coding Plan key. See the [provider guide](packages/coding-agent/docs/providers.md) for other providers.

## Make it yours

| Command | Action |
|---------|--------|
| `/model` | Choose a provider and model |
| `/thinking` | Choose a supported reasoning level |
| `/resume` | Open a previous session |
| `/settings` | Adjust preferences, including the TUI mode |
| `/compact` | Compact the current conversation manually |

Use `yupi --tui-mode regular` if you prefer terminal-owned scrollback.

Yupi discovers skills in `~/.yupi/agent/skills` and the current project's `.yupi/skills`. Additional paths can be configured explicitly. Shared `.agents/skills` and `.pi` directories are not loaded automatically.

Read the [usage guide](packages/coding-agent/docs/usage.md), [settings reference](packages/coding-agent/docs/settings.md), and [local setup notes](YUPI.md) for more details.

## Packages

The workspace retains its upstream package identifiers:

| Package | Purpose |
|---------|---------|
| [Coding agent](packages/coding-agent) | Interactive CLI, sessions, tools, and extensions |
| [Agent core](packages/agent) | Agent runtime with tool calling and state management |
| [AI](packages/ai) | Unified multi-provider model API |
| [TUI](packages/tui) | Terminal UI and rendering |
| [Chord](packages/chord) | Application composition, services, RPC, and plugins |
| [Telemetry](packages/telemetry) | Telemetry contracts and adapters |

## Development

```sh
npm install --ignore-scripts # Install dependencies without lifecycle scripts
npm run build               # Refresh model data and build all packages
npm run build:offline       # Build using existing model data
npm run check               # Format, lint, type-check, and validate packages
./test.sh                   # Run tests with isolated settings and no API keys
```

Direct external dependencies are pinned. The repository validates dependency declarations, lockfiles, and TypeScript imports as part of `npm run check`.

See [CONTRIBUTING.md](CONTRIBUTING.md) and [AGENTS.md](AGENTS.md) for the repository's contribution and development rules. Some inherited package documentation and scripts still use the upstream Pi names.

## Permissions

Yupi runs with the filesystem, process, network, and credential access of the user that launches it. It does not include a built-in system for restricting that access. For isolation options, see the [containerization guide](packages/coding-agent/docs/containerization.md).

## Credits and license

Yupi is a fork of [Pi](https://github.com/earendil-works/pi), created by Mario Zechner and its contributors.

[MIT](LICENSE).
