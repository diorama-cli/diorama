#!/usr/bin/env bash
# Build everything and put a working `diorama` on PATH for the current shell.
#
# A global `npm link` is not usable here: the npm global prefix is not writable
# (and the package is private with workspace:* dependencies). The linked CLI
# resolves its dependencies through packages/cli/node_modules, which pnpm points
# at the workspace packages — so the built outputs next to them are what runs.
#
# Usage:
#   source ./link.sh      # adds <repo>/packages/cli/bin to PATH in this shell
#   diorama .             # then use it anywhere
#
# Re-run `pnpm build` after changing sources; the PATH entry stays valid.
#
# **No `set -euo pipefail` here on purpose**: this file is sourced into an
# interactive shell, and `set -u` poisons it — every keystroke then errors with
# e.g. `_zsh_autosuggest_highlight_apply:3: POSTDISPLAY: parameter not set`
# (an unset variable inside a prompt hook). The build keeps its strict flags in
# its own subshell. Works under both bash (BASH_SOURCE) and zsh ($0).
repo="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
bin="$repo/packages/cli/bin"

echo "▸ building (kernel → slots → ui → plugins → cli → shell)…"
(cd "$repo" && bash -c 'set -euo pipefail; pnpm build') >/dev/null

test -x "$bin/diorama" || { echo "✗ $bin/diorama is not executable" >&2; return 1 2>/dev/null || exit 1; }

case ":$PATH:" in
  *":$bin:"*) ;;
  *) export PATH="$bin:$PATH" ;;
esac

echo "✓ diorama -> $bin/diorama"
echo "  try: diorama . --dump-plan"
echo "       diorama ."
