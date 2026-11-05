# Agent bridge (prototype)

`bridge.mjs` lets an AI agent on your laptop run commands in the Strands Shell
open in your browser tab. It needs Node.js 22+ and has no dependencies.

```
local agent --stdio MCP--> bridge.mjs (127.0.0.1:7357) <--WebSocket-- page --> wasm shell
```

## Use with Claude Code

```sh
claude mcp add tryshell -- node /path/to/bridge.mjs --page-url https://tryshell.sh/
```

For a local preview:

```sh
claude mcp add tryshell -- node /path/to/bridge.mjs --page-url http://127.0.0.1:4173/
```

Ask the agent for the pairing URL (the `pairing_url` tool), open it in Chrome or
Edge, and the titlebar shows **agent connected**. Agent commands appear in the
terminal at an `agent ›` prompt.

| Flag | Default | Meaning |
| --- | --- | --- |
| `--port` | `7357` | WebSocket port on 127.0.0.1 |
| `--page-url` | `https://tryshell.sh/` | Page used to build the pairing URL |
| `--origin` | none | Extra allowed page origin; repeatable |
| `--open` | off | Open the pairing URL in the default browser |

The bridge accepts pages only from the `--page-url` origin and any `--origin`
flags, so other sites, including local dev servers, cannot pair.

## Tools

- `run_shell {command}` runs a command in the tab's in-memory sandbox and
  returns exit status, cwd, stdout, and stderr. No network, no host files.
- `pairing_url` returns the URL to open and whether a tab is connected.

## Security

The bridge listens on 127.0.0.1 only. A page is accepted only when its `Origin`
is allowlisted and its first message carries the random pairing token generated
at startup. One tab is paired at a time; a newer tab replaces the older one. The
page removes the token from the address bar after reading it.

## Page protocol

JSON text frames over `ws://127.0.0.1:<port>`:

```
page   -> bridge  {type:'hello', token}
bridge -> page    {type:'paired'}
bridge -> page    {type:'run', id, command}
page   -> bridge  {type:'result', id, stdout, stderr, status, cwd}
page   -> bridge  {type:'error', id, message}   the tab cannot run commands
```

Calls time out after 10 seconds. Close code 4001 means a bad token; 4000 means
another tab took over.

## Test

With `npm run preview -- --port 4173` running, `npm run check:bridge` drives the
bridge as an MCP client and pairs a headless Chromium tab.
