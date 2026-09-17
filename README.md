# Pidor

Pidor is a Pi source fork with its own `pidor` command and `.pidor`
configuration directory. The upstream project documentation follows the local
setup notes below. See [PIDOR.md](PIDOR.md) for fork and build notes.

## Local launch defaults

On this installation, start Pidor with tools and the minimal prompt setup using:

```sh
pidor
```

These defaults were configured on September 13, 2026, after the same setup in
`./pi-debug` produced the desired behavior. That first launcher ran stock Pi;
`pidor` runs this fork. The purpose is to reduce automatically added instructions
while keeping tools available and recording what the client sends and executes.
This does not establish why the model behaved differently with tools enabled,
and it does not guarantee the same responses as `--no-tools`.

The defaults live in a **local shell launcher and local settings**, not in new
fork CLI defaults: a plain build of this repository runs with normal discovery.
The [local-setup](local-setup/) directory reproduces the full local
installation, and the launcher itself remains plain configuration that can be
edited or removed without rebuilding. Stock `pi` and its `~/.pi/agent`
configuration are separate.

### Reproduce the local setup

`local-setup/` contains the launcher (`pidor-no-context`), the trace observer
(`debug-trace.mjs`), the tool/model settings (`settings.json`), and the provider
definitions (`models.json`, no credentials). To install on a fresh machine:

```sh
git clone --branch pidor https://github.com/TroopJostle/yupi.git
cd yupi/local-setup
./install.sh
```

`install.sh` clones and builds the fork into `~/.local/share/pidor/source` (or
links an existing checkout via `--source /path/to/checkout`), installs the
launcher and observer, symlinks `~/.local/bin/pidor`, and writes
`~/.pidor/agent/settings.json` and `models.json` when absent. Re-running keeps
existing files; pass `--force` to replace them.

Credentials (`auth.json`), sessions, and trace logs are deliberately **not**
in the repository. Add API keys by starting Pidor and using `/login`, or copy
`~/.pidor/agent/auth.json` privately from the previous machine; never commit it.

### Where the configuration lives

| Location | Purpose |
| --- | --- |
| `~/.local/bin/pidor` → `~/.local/share/pidor/pidor-no-context` | Command symlink and active launcher. Edit the launcher to change startup flags. |
| `~/.local/share/pidor/source/` | This fork checkout. The launcher runs `packages/coding-agent/dist/bundle/cli.js` with Node. |
| `~/.pidor/agent/` | Global settings, models, credentials, and sessions. `settings.json` contains `defaultTools`. `PIDOR_CODING_AGENT_DIR` can override the agent directory. |
| `.pidor/` in a project | Project configuration, subject to the fork's project trust rules. |
| `~/.local/share/pidor/debug-trace.mjs` and `~/.pidor/agent/debug/pidor/` | Explicitly loaded observer and its default log directory. `PI_DEBUG_LOG_DIR` overrides the log directory independently of the agent directory. |

The active launcher's execution block is:

```sh
exec node "$PIDOR_INSTALL_DIR/source/packages/coding-agent/dist/bundle/cli.js" \
  --system-prompt " " \
  --no-context-files \
  --no-extensions \
  --no-skills \
  --no-prompt-templates \
  --extension "$PIDOR_INSTALL_DIR/debug-trace.mjs" \
  "$@"
```

The launcher defines `PIDOR_INSTALL_DIR="$HOME/.local/share/pidor"` above this
block. Keep `"$@"` last: it forwards your arguments, letting later scalar options
such as `--system-prompt` override the launcher's value.

| Default | Why it is present |
| --- | --- |
| `--system-prompt " "` | Supplies one literal space, bypassing the built-in coding instructions. In this version, `""` is treated as absent and falls back to the built-in prompt. |
| `--no-context-files` | Stops automatic `AGENTS.md` and `CLAUDE.md` loading. |
| `--no-extensions` plus the explicit trace extension | Stops extension discovery while keeping the observer loaded. Explicit `--extension` paths still work. |
| `--no-skills` | Stops automatic skill loading, including skills configured in settings. Explicit `--skill` paths still work. |
| `--no-prompt-templates` | Stops automatic prompt template loading. Explicit `--prompt-template` paths still work. |

There is no `--no-tools` in the launcher. The configured `defaultTools` are
`read`, `bash`, `edit`, `write`, `grep`, `find`, and `ls`. Provider and model
selection still comes from normal Pidor settings or your command-line options.

### What “minimal prompt” means

The one-space value is **not a completely empty provider request**. The client
still appends the working directory and sends tool descriptions and argument
schemas separately. Enabling skills adds skill guidance and an index to the
system prompt when a tool that can read skill files is available.

`APPEND_SYSTEM.md` is discovered separately from `AGENTS.md` and `CLAUDE.md`.
The current flags do not disable it: a trusted project's `.pidor/APPEND_SYSTEM.md`
can take precedence over `~/.pidor/agent/APPEND_SYSTEM.md`. To override that
discovery for one run with a space:

```sh
pidor --append-system-prompt " "
```

For that behavior on every launch, add `--append-system-prompt " " \` before
`"$@"` in the launcher. The explicit `--system-prompt` already overrides
automatic `SYSTEM.md` selection.

Disabling automatic context loading does not prevent a tool from reading an
instruction file when requested. Those tool calls appear in the trace. These
flags control client configuration; they do not remove provider-side
instructions or model training, and the trace cannot reveal either.

### Enable selected skills for one run

Pass a skill file, a directory of skills, or repeat the option:

```sh
pidor --skill "$HOME/.pidor/agent/skills/my-skill/SKILL.md"
pidor --skill /path/to/chosen-skills
pidor --skill /path/to/first/SKILL.md --skill /path/to/second/SKILL.md
```

Replace the example paths with existing skills. These options work **without
removing `--no-skills`**. A directory can include multiple skills; use individual
`SKILL.md` paths when you want only particular ones. Each skill needs valid YAML
frontmatter, including its name and description; see the [skill format and
loading documentation](packages/coding-agent/docs/skills.md).

Loaded skills become available to the model. Their names and descriptions enter
the skill index; their full instructions are loaded on demand. To invoke a
loaded skill explicitly, use `/skill:my-skill` in Pidor, using its frontmatter
name. Skill slash commands are enabled by default via `enableSkillCommands`.

### Make selected skills permanent

1. Open `~/.local/share/pidor/pidor-no-context` in your editor.
2. Keep `--no-skills` and add a `--skill` line for each chosen file before `"$@"`.
3. Save the launcher and start a new `pidor` process.

For example, the execution block with one selected skill becomes:

```sh
exec node "$PIDOR_INSTALL_DIR/source/packages/coding-agent/dist/bundle/cli.js" \
  --system-prompt " " \
  --no-context-files \
  --no-extensions \
  --no-skills \
  --no-prompt-templates \
  --extension "$PIDOR_INSTALL_DIR/debug-trace.mjs" \
  --skill "$HOME/.pidor/agent/skills/my-skill/SKILL.md" \
  "$@"
```

Keep a trailing `\` on each continued line, with no characters after it. Check
the shell syntax after editing:

```sh
sh -n "$HOME/.local/share/pidor/pidor-no-context"
```

### Restore automatic skill discovery

Remove the `--no-skills \` line from the launcher and restart Pidor. There is
no opposite `--skills` flag that cancels it for one run.

Normal discovery can then load global skills from `~/.pidor/agent/skills`,
project skills from `.pidor/skills`, and configured/package skill paths.
Project sources remain subject to project trust rules. Restoring discovery can
therefore load more than the skill you intended; use explicit paths above for a
selected set.

This fork also disables automatic discovery of the shared `~/.agents/skills`
and project `.agents/skills` directories in its source. Removing `--no-skills`
does not restore those shared directories. To use their skills, pass explicit
`--skill` paths or add their paths to settings after enabling discovery. The
linked skill documentation describes upstream Pi; use the Pidor paths here for
this installation.

With discovery enabled, you can also merge a `skills` entry into
`~/.pidor/agent/settings.json` or project settings:

```json
{
  "skills": ["/absolute/path/to/chosen-skills"]
}
```

This is a settings fragment: preserve the file's other keys. Adding it while the
launcher still includes `--no-skills` will not enable those configured skills.

### Change the prompt, tools, or other defaults

Override the prompt or tools for one run:

```sh
pidor --system-prompt "Your system instructions here."
pidor --system-prompt /absolute/path/to/system-prompt.md
pidor --tools read,grep,find,ls
pidor --no-tools
```

To change the permanent tool set, edit only `defaultTools` in
`~/.pidor/agent/settings.json`, preserving the other settings. Its current value
is:

```json
{
  "defaultTools": ["read", "bash", "edit", "write", "grep", "find", "ls"]
}
```

To restore other automatic behavior, edit the corresponding launcher line:

| Desired behavior | Launcher change |
| --- | --- |
| Use normal `SYSTEM.md` selection or the built-in coding prompt | Remove `--system-prompt " " \`. For just the built-in prompt on one run, use `pidor --system-prompt ""`. |
| Load `AGENTS.md` / `CLAUDE.md` automatically | Remove `--no-context-files \`. |
| Discover extensions | Remove `--no-extensions \`. To add only one, keep it and use `pidor --extension /path/to/extension.mjs`. |
| Discover skills | Remove `--no-skills \`. |
| Discover prompt templates | Remove `--no-prompt-templates \`. To add only one, keep it and use `pidor --prompt-template /path/to/template.md`. |

Restart Pidor after launcher changes; `/reload` does not replace startup flags.
These edits require no rebuild. To bypass the local launcher for a single run,
use the fork CLI directly:

```sh
node "$HOME/.local/share/pidor/source/packages/coding-agent/dist/bundle/cli.js"
```

That uses normal fork discovery and the same Pidor settings, without this
launcher's flags or explicitly loaded trace observer.

### Trace activity and turn logging off

In a second terminal, follow the latest run:

```sh
pidor --follow
```

Inside Pidor, `/trace` displays the run directory. Ctrl+O is the default shortcut
to expand tool output. Each run records:

- `trace.log`: activity, tool calls, arguments, and completion.
- `events.jsonl`: client system prompt, context metadata, messages, and tool results.
- `request-NNNN.json`: provider request bodies at the `before_provider_request` hook.

The observer does not alter prompts, requests, tool arguments, or results.
Additional extensions can change requests after an earlier observer runs.
The trace records shell commands and their results, not every file opened by
subprocesses; it cannot inspect server-side prompt transformations.

Logs contain conversation text and returned file contents. New log directories
use permissions `0700` and files use `0600`; HTTP authentication headers are not
recorded. Use `PI_DEBUG_LOG_DIR=/path/to/logs pidor` to choose another location,
and use the same variable with `pidor --follow`.

To stop recording new traces, remove the explicit
`--extension "$PIDOR_INSTALL_DIR/debug-trace.mjs" \` line and restart Pidor.
Adding `--no-extensions` again does not disable an explicitly loaded extension.
Removing the observer also removes `/trace`; existing logs remain on disk, and
`pidor --follow` can still point at the last recorded run.

### Previous configuration and verification

The pre-change files were saved alongside their originals:

```text
~/.local/share/pidor/pidor-no-context.before-debug-defaults-20260913T190651Z.bak
~/.pidor/agent/settings.json.before-debug-defaults-20260913T190651Z.bak
```

The earlier launcher supplied only `--no-context-files`. To return to that
launch behavior, restore that launcher's backup. Restore the settings backup
only if you also want its entire old configuration; after later settings edits,
prefer changing just `defaultTools` to avoid losing unrelated changes.

The original `./pi-debug`, observer source, and local smoke test live in
`~/Documents/projects/random/opensource/pidor/`. The installed observer is a
copy, so edits to the workspace copy do not automatically update Pidor's copy.
The old installation's `runtime/` and `pidor.mjs` are superseded; the active
launcher is `pidor-no-context`.

Verification used synthetic files and isolated settings. It confirmed selected
skill files/directories and repeated `--skill` flags work with discovery off,
removing `--no-skills` restores discovery, and prompt/append overrides work.
Those checks stopped before any provider request. The local smoke test also
checks real `read`/`bash` execution against a local mock provider, unchanged
request bodies with tracing enabled, private log permissions, and `--no-tools`:

```sh
python3 "$HOME/Documents/projects/random/opensource/pidor/tests/trace-smoke.py" pidor
```

The relevant implementation is in [CLI argument parsing](packages/coding-agent/src/cli/args.ts),
[resource loading](packages/coding-agent/src/core/resource-loader.ts), and
[system prompt construction](packages/coding-agent/src/core/system-prompt.ts).
Check these again when upgrading the fork, since flag and loading behavior can
change.

---

<p align="center">
  <a href="https://pi.dev">
    <img alt="pi logo" src="https://pi.dev/logo-auto.svg" width="128">
  </a>
</p>
<p align="center">
  <a href="https://discord.com/invite/3cU7Bz4UPx"><img alt="Discord" src="https://img.shields.io/badge/discord-community-5865F2?style=flat-square&logo=discord&logoColor=white" /></a>
  <a href="https://www.npmjs.com/package/@earendil-works/pi-coding-agent"><img alt="npm" src="https://img.shields.io/npm/v/@earendil-works/pi-coding-agent?style=flat-square" /></a>
</p>

> New issues and PRs from new contributors are auto-closed by default. Maintainers review auto-closed issues daily. See [CONTRIBUTING.md](CONTRIBUTING.md).

# Pi Agent Harness

This is the home of the Pi agent harness project including our self extensible coding agent.

* **[@earendil-works/pi-coding-agent](packages/coding-agent)**: Interactive coding agent CLI
* **[@earendil-works/pi-agent-core](packages/agent)**: Agent runtime with tool calling and state management
* **[@earendil-works/pi-ai](packages/ai)**: Unified multi-provider LLM API (OpenAI, Anthropic, Google, …)

To learn more about Pi:

* [Visit pi.dev](https://pi.dev), the project website with demos
* [Read the documentation](https://pi.dev/docs/latest), but you can also ask the agent to explain itself

## All Packages

| Package | Description |
|---------|-------------|
| **[@earendil-works/chord](packages/chord)** | Standalone application-composition runtime for services, replicated state, RPC, and plugins |
| **[@earendil-works/pi-telemetry](packages/telemetry)** | Vendor-neutral telemetry contracts, reference adapter, conformance tests, and typed schemas |
| **[@earendil-works/pi-ai](packages/ai)** | Unified multi-provider LLM API (OpenAI, Anthropic, Google, etc.) |
| **[@earendil-works/pi-agent-core](packages/agent)** | Agent runtime with tool calling and state management |
| **[@earendil-works/pi-coding-agent](packages/coding-agent)** | Interactive coding agent CLI |
| **[@earendil-works/pi-tui](packages/tui)** | Terminal UI library with differential rendering |

For Slack/chat automation and workflows see [earendil-works/pi-chat](https://github.com/earendil-works/pi-chat).

## Permissions & Containerization

Pi does not include a built-in permission system for restricting filesystem, process, network, or credential access. By default, it runs with the permissions of the user and process that launched it.

If you need stronger boundaries, containerize or sandbox Pi. See [packages/coding-agent/docs/containerization.md](packages/coding-agent/docs/containerization.md) for three patterns:

- **Gondolin extension**: keep `pi` and provider auth on the host while routing built-in tools and `!` commands into a local Linux micro-VM.
- **Plain Docker**: run the whole `pi` process in a local container for simple isolation.
- **OpenShell**: run the whole `pi` process in a policy-controlled sandbox.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for contribution guidelines and [AGENTS.md](AGENTS.md) for project-specific rules (for both humans and agents).  Longer term plans for Pi can also be found in [RFCs](https://rfc.earendil.com/keyword/pi/).

## Development

```bash
npm install --ignore-scripts  # Install all dependencies without running lifecycle scripts
npm run build         # Refresh model data, then build all packages
npm run build:offline # Rebuild using existing model data without network access
npm run check         # Lint, format, and type check
./test.sh            # Run tests (skips LLM-dependent tests without API keys)
./pi-test.sh         # Run pi from sources (can be run from any directory)
```

## Building standalone binaries from release source

GitHub releases include a versioned source archive covered by the release's `SHA256SUMS` file. Extract it and run the same build script used for the official standalone binaries:

```bash
VERSION="<release-version>"
tar -xzf "pi-${VERSION}-source.tar.gz"
cd "pi-${VERSION}"
./scripts/build-binaries.sh --offline-model-data --platform linux-x64 --out "$PWD/out"
```

The archive includes release model data and native prebuilds. `--offline-model-data` uses that model data without refreshing provider catalogs. The script installs dependencies and builds the executable with its runtime assets; pass `--skip-install` if dependencies are already provided.

## Supply-chain hardening

We treat npm dependency changes as reviewed code changes.

- Direct external dependencies are pinned to exact versions. Internal workspace packages remain version-ranged.
- `.npmrc` sets `save-exact=true` and `min-release-age=2` to avoid same-day dependency releases during npm resolution.
- `package-lock.json` is the dependency ground truth. Pre-commit blocks accidental lockfile commits unless `PI_ALLOW_LOCKFILE_CHANGE=1` is set.
- `npm run check` verifies pinned direct deps, native TypeScript import compatibility, and the generated coding-agent shrinkwrap.
- The published CLI package includes `packages/coding-agent/npm-shrinkwrap.json`, generated from the root lockfile, to pin transitive deps for npm users.
- Release smoke tests use `npm run release:local` to build, pack, and create isolated npm and Bun installs outside the repo before tagging a release.
- Local release installs, documented npm installs, and `pi update --self` use `--ignore-scripts` where supported.
- CI installs with `npm ci --ignore-scripts`, and a scheduled GitHub workflow runs `npm audit --omit=dev` plus `npm audit signatures --omit=dev`.
- Shrinkwrap generation has an explicit allowlist for dependency lifecycle scripts; new lifecycle-script deps fail checks until reviewed.

## Share your OSS coding agent sessions

If you use Pi or other coding agents for open source work, please share your sessions.

Public OSS session data helps improve coding agents with real-world tasks, tool use, failures, and fixes instead of toy benchmarks.

For the full explanation, see [this post on X](https://x.com/badlogicgames/status/2037811643774652911).

To publish sessions, use [`badlogic/pi-share-hf`](https://github.com/badlogic/pi-share-hf). Read its README.md for setup instructions. All you need is a Hugging Face account, the Hugging Face CLI, and `pi-share-hf`.

You can also watch [this video](https://x.com/badlogicgames/status/2041151967695634619), where I show how I publish my `pi-mono` sessions.

I regularly publish my own `pi-mono` work sessions here:

- [badlogicgames/pi-mono on Hugging Face](https://huggingface.co/datasets/badlogicgames/pi-mono)

## License

MIT

<p align="center">
  <a href="https://pi.dev">pi.dev</a> domain graciously donated by
  <br /><br />
  <a href="https://exe.dev"><img src="packages/coding-agent/docs/images/exy.png" alt="Exy mascot" width="48" /><br />exe.dev</a>
</p>
