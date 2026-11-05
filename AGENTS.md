# AGENTS.md

A static demo site that runs the [Strands Shell](https://github.com/strands-agents/shell)
Rust core, compiled to WebAssembly, in a browser worker. A small local bridge lets an
AI agent on the visitor's machine run commands in that tab over MCP. `README.md`
covers the layout, build, and checks; `package.json` lists the scripts.

## Constraints that shape every change

- **Static only.** The site ships as files any static host can serve. Anything that
  needs a server runs on the visitor's machine, through the bridge.
- **The bridge is one dependency-free file.** Visitors copy it and run it with plain
  Node, so it stays self-contained, listens on `127.0.0.1` only, and pairs only with
  an allowed origin that presents the pairing token.
- **The engine is pinned upstream.** The Rust core is a git dependency at a fixed
  commit. Changes to shell behaviour belong in the upstream repository; this repo
  only adapts it. Push only to this repository.

## Engine behaviour worth knowing

- One command at a time: overlapping calls into the engine crash it. Route every
  command, typed or from the agent, through the page's session module, which
  serializes them.
- The engine cannot be interrupted. Stopping a command, hitting the time limit, or
  resetting means discarding the worker, and the workspace with it.
- The command set is the engine's own, not coreutils. Before naming a command in
  completion, help text, docs, or the bridge's tool description, confirm the engine
  has it (`command -v <name>` in the shell).

## Working here

- Browser checks run against the preview server, which serves the last build. Rebuild
  the site before running them, or they test stale code.
- Rebuilding the engine needs `WASI_SDK_PATH`; site-only changes need only the site
  build.
- Terminal output has a single font size, so anything sized differently belongs in
  the page around the terminal.
- Work in small, separately committed steps with Conventional Commit messages
  (`feat:`, `fix:`, `refactor:`, `style:`, `docs:`, `test:`).
