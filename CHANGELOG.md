# Changelog

Every published version of `@diorama-cli/diorama`, newest first. Generated from
the commit log by `pnpm release` — see [docs/release.md](docs/release.md).

## 0.0.6 (2026-10-28)

### Features

- **file-tree:** a file's raw bytes get an address, and three ways to take it
- **file-tree:** the file view gets a toolbar that locates the file being read
- **shell:** the page title is the served directory's name
- **theme:** the mount's default theme comes from diorama.toml
- **cli:** stop serving one directory from the command line

### Documentation

- **release:** file the 0.0.6 change lists under their version

## 0.0.5 (2026-10-26)

### Features

- **commands:** shortcuts reach the page, and show themselves on the controls
- **git-changes:** highlight the diff readers that show file content
- **layout:** the sidebar folds down to its switcher

### Documentation

- **release:** file the 0.0.4 change lists under their version

## 0.0.4 (2026-10-24)

### Features

- **html:** [html] scripts decides whether a preview runs page scripts
- **markdown:** an in-document outline, KaTeX math and Mermaid diagrams
- **ui:** panes the reader can drag, and long names read by scrolling
- **git:** read every repository a mounted directory holds
- **git-changes:** read a diff three ways, and move between its changes

### Fixes

- **rpc:** the page reconnects and re-subscribes after a dropped network

### Other

- diff readers onto main

## 0.0.3 (2026-10-21)

### Features

- **release:** one command bumps every version, a tag publishes
- **cli:** print the mount as one JSON document with `--json`
- **cli:** offer candidates in the config wizard, addresses from this machine
- **cli:** edit diorama.toml from the command line, interactively or by flags
- **theme:** follow the system, pin light/dark, and let pieces add themes
- **release:** ship as one npm package, @diorama-cli/diorama 0.0.1
- **icons:** file-type and button icons from two MIT sets, one generated table
- **search:** find files by name and by content, and jump to the line
- **help:** a shortcut sheet on `?`, and `layout.overlay` becomes a list
- **html:** a renderer for .html/.htm — sanitised preview plus the source
- **git-changes:** the changes view follows the file system, not a timer
- **pdf:** a PDF renderer that hands the bytes to the browser's viewer
- **git-changes:** the history view — commits on the left, a commit on the right
- **git:** show / showCommit / blob — the history view's server half
- **image:** an image renderer that fetches its own bytes
- **git-changes:** the changes view is a tree, not a flat list
- **m4-s3:** ctx.router — the URL names the file, the hash names the view
- **m4-s2:** sidebar.views — one left column, many views
- **m4-s1:** ctx.git — a read-only view of the mount's repository
- **cli:** a beta entry — `diorama-beta` for linked checkouts, `diorama` for releases
- **m3-s5:** degraded mounts — banner, one auto-restart, ls status
- **m3-s4:** diorama ls, gateway verbs, and a short-lived `diorama <dir>`
- **m3-s3b:** share directory watches per mount and cap them
- **m3-s3:** one plugin graph, a fork context per mount
- **m3-s2:** a resident gateway serves many directories, one port each
- **m3-s1:** gateway control plane — NDJSON frames over a Unix socket
- **m2-s6:** fs.watch over RPC sessions — live tree and content refresh
- **m2-s5:** palette plugin — a layout.overlay entry over ctx.commands
- **m2-s4:** command kernel — ctx.commands, one key dispatcher, layout.overlay
- **m2-s3:** real multi-tab — keyed tabs.content, per-tab seats, ctx.tabs
- **m2-s2:** file tree pages large directories; hiding flows through fs.list
- **m2-s1:** diorama.toml, config precedence, ignore rules in fs.list
- **m1:** plugin kernel takes shape — contract v0.2, RPC, renderer matchers, markdown/code
- **m0:** left-tree/right-document viewer with a plugin kernel

### Fixes

- **release:** derive the test's versions instead of writing them down
- **release:** carry the README into the npm package, links rewritten
- **markdown:** a relative link opens a tab instead of reloading the page
- **cli:** let `diorama config` exit once it has written the file
- **cli:** draw the config menu in place, one frame per keystroke
- **keys:** macOS composes Option+letter, so every `mod+alt+*` was dead
- **history:** a picked commit ends when the reader goes back to browsing
- **html:** keep the page's CSS, and run its scripts only after a confirmation
- **gateway:** an answer from a service is not a mount fault
- **git:** the repository comes from the mount, not the environment
- **git-changes:** a commit's message is its title line; the body folds
- **link.sh:** do not set -u in the sourced shell
- **renderer-registry:** stop the dispatcher from re-rendering for ever

### Refactoring

- **renderer-registry:** pre-read text only; renderers fetch their own bytes

### Documentation

- **contract:** a contract number is bumped at release, not per commit
- **readme:** rewrite for users and developers
- record the second M4 round (contract 0.6) in spec, features, plan, AGENTS
- **m4-s5:** contract v0.6 — git history, image/pdf renderers, text-only preload
- **m4-s0:** contract v0.5 — ctx.git, ctx.router, sidebar.views
- **m3-s6:** record M3 — spec, feature tiers, plan, agent map
- **m3-s0:** contract v0.4 — gateway control plane, fork lifecycle, degraded
- **m2-s7:** record M2 — spec implementation notes, feature tiers, plan
- record tianwu org handle is reserved; plan tianwu-labs

### Tests

- **history:** wait for the views to register before pressing their shortcuts

### Chores

- finalize name as Diorama; org diorama-cli
- initialize Tianwu with naming rationale

### Other

- README packaging fix onto the Markdown link fix
