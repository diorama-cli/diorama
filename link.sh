#!/usr/bin/env bash
# Put this checkout's CLI on PATH as **diorama-beta** (see README "Development").
#
# Why `npm link` works here: the package is `private` and uses `workspace:*`
# dependencies, but npm link does not fetch anything — the CLI resolves its
# dependencies through packages/cli/node_modules, which pnpm points at the
# workspace packages. It only needs the npm global prefix to be writable, which
# it is for a node installed by nvm (`~/.nvm/versions/node/<v>/bin`).
#
# Naming: a linked checkout is a **beta**. The package's `bin` field maps the
# beta name, so `npm link` installs `diorama-beta` and never shadows a real
# `diorama` (installed from the registry, which owns the plain name).
#
# Usage:
#   ./link.sh              # build + npm link (installs diorama-beta)
#   ./link.sh --unlink     # remove the links this checkout installed
#   ./link.sh --path       # build + PATH for THIS shell only (no global link)
#   source ./link.sh       # same as --path
#
# Re-run `pnpm build` after changing sources; the link keeps working.
#
# **No `set -euo pipefail` here on purpose**: this file can be sourced into an
# interactive shell, and `set -u` poisons it — every keystroke then errors with
# e.g. `_zsh_autosuggest_highlight_apply:3: POSTDISPLAY: parameter not set`
# (an unset variable inside a prompt hook). The build keeps its strict flags in
# its own subshell.

# Where this file is, in both shells: bash sets BASH_SOURCE, zsh sets $0 to the
# sourced file. `${BASH_SOURCE[0]:-$0}` is NOT portable — zsh parses
# `BASH_SOURCE[0]` as a subscript into a scalar and yields `$0` ("zsh").
if [ -n "${BASH_SOURCE:-}" ]; then
  self="$BASH_SOURCE"
else
  self="$0"
fi
repo="$(cd "$(dirname "$self")" && pwd)"
cli_dir="$repo/packages/cli"
bin="$cli_dir/bin"

# `link` when executed, `path` when sourced (a sourced run never touches the
# global npm prefix behind your back). After `. ./link.sh`, zsh's `$0` is the file.
if [ "$self" = "$0" ]; then
  mode=link
else
  mode=path
fi
for arg in "$@"; do
  case "$arg" in
    --unlink) mode=unlink ;;
    --path) mode=path ;;
    --link) mode=link ;;
    -h|--help)
      sed -n '2,29p' "$0" | sed 's/^# \{0,1\}//'
      return 0 2>/dev/null || exit 0
      ;;
    *)
      echo "link.sh: unknown option $arg" >&2
      return 2 2>/dev/null || exit 2
      ;;
  esac
done

die() {
  echo "✗ $*" >&2
  return 1 2>/dev/null || exit 1
}

npm_prefix() {
  command -v npm >/dev/null 2>&1 || die "npm is not on PATH"
  npm config get prefix
}

# A link belongs to this checkout when its fully resolved target lives in
# packages/cli. npm makes it in two hops (bin/diorama → lib/node_modules/
# diorama-cli → this checkout), so resolve all of them — `readlink` alone keeps
# returning ../lib/node_modules/… for either spelling.
points_into_checkout() {
  local link="$1" resolved
  resolved="$(realpath "$link" 2>/dev/null)" || return 1
  case "$resolved" in
    "$cli_dir"/*) return 0 ;;
  esac
  return 1
}

if [ "$mode" = unlink ]; then
  prefix="$(npm_prefix)"
  removed=no
  for name in diorama-beta diorama; do
    if [ -L "$prefix/bin/$name" ] && points_into_checkout "$prefix/bin/$name"; then
      rm -f "$prefix/bin/$name" && removed=yes && echo "✓ removed $prefix/bin/$name"
    fi
  done
  [ "$removed" = yes ] || echo "· nothing of this checkout linked in $prefix/bin"
  return 0 2>/dev/null || exit 0
fi

echo "▸ building (kernel → slots → ui → plugins → cli → shell)…"
(cd "$repo" && bash -c 'set -euo pipefail; pnpm build') >/dev/null || die "pnpm build failed"

if [ "$mode" = path ]; then
  # No global side effect: just this shell.
  case ":$PATH:" in
    *":$bin:"*) ;;
    *) export PATH="$bin:$PATH" ;;
  esac
  echo "✓ diorama-beta -> $bin/diorama-beta (PATH for this shell only)"
  echo "  for every shell: ./link.sh (npm link installs diorama-beta)"
  return 0 2>/dev/null || exit 0
fi

prefix="$(npm_prefix)"
[ -w "$prefix/bin" ] || die "$prefix/bin is not writable — use \`source ./link.sh\` for a per-shell PATH instead"
echo "▸ npm link…"
(cd "$cli_dir" && npm link) >/dev/null 2>&1 || die "npm link failed (run it in packages/cli to see why)"

# npm creates one link per `bin` entry. Keep `diorama-beta` (the beta name);
# a `diorama` link from this checkout would shadow a registry install.
if [ -L "$prefix/bin/diorama" ] && points_into_checkout "$prefix/bin/diorama"; then
  rm -f "$prefix/bin/diorama"
  echo "· removed the checkout's \`diorama\` link (beta keeps diorama-beta)"
fi

target="$prefix/bin/diorama-beta"
if [ -x "$target" ]; then
  echo "✓ diorama-beta -> $target"
else
  die "$target was not created; check \`packages/cli/package.json\` bin entries"
fi
command -v diorama-beta >/dev/null 2>&1 || echo "  note: $prefix/bin is not on your PATH — add it to ~/.zshrc"
echo "  try: diorama-beta --help"
echo "       diorama-beta ."
echo "  state: \$DIORAMA_HOME/diorama-beta.sock (a registry \`diorama\` uses diorama.sock)"
