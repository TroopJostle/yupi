#!/bin/sh
set -eu

# Reproduces the local "pidor" setup documented in README.md
# (Local launch defaults). Safe to re-run: existing files are kept
# unless --force is given.

REPO_URL="https://github.com/TroopJostle/yupi.git"
REPO_BRANCH="pidor"
SOURCE_ARG=""
FORCE=0

usage() {
	cat <<EOF
Usage: install.sh [--source /path/to/checkout] [--repo URL] [--force]

--source   Use an existing fork checkout instead of cloning to
           ~/.local/share/pidor/source
--repo     Repository to clone when no --source is given
           (default: $REPO_URL, branch $REPO_BRANCH)
--force    Overwrite existing launcher, observer, settings, and models files
EOF
}

while [ $# -gt 0 ]; do
	case "$1" in
		--source) SOURCE_ARG="${2:?--source needs a path}"; shift 2 ;;
		--repo) REPO_URL="${2:?--repo needs a URL}"; shift 2 ;;
		--force) FORCE=1; shift ;;
		-h | --help) usage; exit 0 ;;
		*) echo "Unknown option: $1" >&2; usage >&2; exit 1 ;;
	esac
done

INSTALL_DIR="$HOME/.local/share/pidor"
BIN_DIR="$HOME/.local/bin"
AGENT_DIR="$HOME/.pidor/agent"
SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"

install_file() {
	src="$1"
	dst="$2"
	if [ "$FORCE" -eq 0 ] && [ -e "$dst" ]; then
		echo "keep    $dst (exists; use --force to replace)"
	else
		mkdir -p "$(dirname -- "$dst")"
		cp "$src" "$dst"
		echo "install $dst"
	fi
}

# 1. Source checkout: use --source, existing build, or clone + build
if [ -n "$SOURCE_ARG" ]; then
	SOURCE_ARG="$(CDPATH= cd -- "$SOURCE_ARG" && pwd)"
	echo "source  using provided checkout: $SOURCE_ARG"
	if [ ! -e "$INSTALL_DIR/source" ]; then
		mkdir -p "$INSTALL_DIR"
		ln -s "$SOURCE_ARG" "$INSTALL_DIR/source"
		echo "link    $INSTALL_DIR/source -> $SOURCE_ARG"
	fi
elif [ -d "$INSTALL_DIR/source/packages/coding-agent/dist/bundle" ]; then
	echo "keep    $INSTALL_DIR/source (already built)"
else
	command -v git >/dev/null 2>&1 || { echo "git is required to clone the fork" >&2; exit 1; }
	command -v npm >/dev/null 2>&1 || { echo "npm is required to build the fork" >&2; exit 1; }
	mkdir -p "$INSTALL_DIR"
	git clone --branch "$REPO_BRANCH" "$REPO_URL" "$INSTALL_DIR/source"
	cd "$INSTALL_DIR/source"
	npm ci --ignore-scripts
	npm run hydrate:model-data
	npm run build:offline
fi

# 2. Launcher and trace observer
install_file "$SCRIPT_DIR/pidor-no-context" "$INSTALL_DIR/pidor-no-context"
chmod +x "$INSTALL_DIR/pidor-no-context"
install_file "$SCRIPT_DIR/debug-trace.mjs" "$INSTALL_DIR/debug-trace.mjs"

# 3. Command symlink
mkdir -p "$BIN_DIR"
ln -sfn "$INSTALL_DIR/pidor-no-context" "$BIN_DIR/pidor"
echo "link    $BIN_DIR/pidor -> $INSTALL_DIR/pidor-no-context"
case ":$PATH:" in
	*":$BIN_DIR:"*) ;;
	*) echo "note    $BIN_DIR is not in your PATH" ;;
esac

# 4. Settings and provider definitions (never overwritten without --force)
install_file "$SCRIPT_DIR/settings.json" "$AGENT_DIR/settings.json"
install_file "$SCRIPT_DIR/models.json" "$AGENT_DIR/models.json"

# 5. Credentials are NOT included in this repository.
if [ ! -f "$AGENT_DIR/auth.json" ]; then
	echo "note    no $AGENT_DIR/auth.json yet: start pidor and run /login,"
	echo "        or copy auth.json privately from the previous machine."
	echo "        Never commit that file."
fi

echo "Done. Start with: pidor"
