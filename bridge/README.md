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
| `--port` | `7357` | WebSocket port on 127.0.0.1; without the flag, a busy 7357 falls back to a free port named in the pairing URL |
| `--page-url` | `https://tryshell.sh/` | Page used to build the pairing URL |
| `--origin` | none | Extra allowed page origin; repeatable |
| `--open` | off | Open the pairing URL in the default browser |

The bridge accepts pages only from the `--page-url` origin and any `--origin`
flags, so other sites, including local dev servers, cannot pair.

## Tools

- `run_shell {command}` runs a command in the tab's in-memory sandbox and
  returns exit status, cwd, stdout, and stderr, as text and as structured
  content. Output over 16,000 characters keeps its start and end. Cancelling
  the request skips the command if it has not started. No network, no host
  files.
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
bridge -> page    {type:'cancel', id}            call timed out or was cancelled; skip it if still queued
page   -> bridge  {type:'result', id, stdout, stderr, status, cwd}
page   -> bridge  {type:'error', id, message}    the tab cannot run commands
```

Calls time out after 10 seconds. Close code 4001 means a bad token; 4000 means
another tab took over.

## Browser permission

When the page comes from a public site such as `https://tryshell.sh`, recent
Chrome and Edge versions may ask for permission to access devices on the local
network before the page can reach `127.0.0.1`. Allow it for the site; if it is
blocked, the titlebar stays at **agent disconnected** and you can re-enable it
from the site settings. Pages served from `127.0.0.1` or `localhost` are not
asked. `npm run check:bridge` serves the page locally, so it does not cover this
prompt.

## Test

With `npm run preview -- --port 4173` running, `npm run check:bridge` drives the
bridge as an MCP client and pairs a headless Chromium tab.

`test/bridge.test.js` covers WebSocket framing, pairing, and MCP handling
without a browser and runs with `npm test`. `test/e2e.mjs` is the end-to-end
check behind `npm run check:bridge`.
