# Browser agent bridge — throwaway prototype

This prototype lets an external Model Context Protocol (MCP) client operate the
same Strands Shell workspace as a person in the browser. Commands execute in the
existing WebAssembly worker. The agent receives stdout, stderr, exit status,
working directory, and elapsed milliseconds. The browser displays each command.

The experiment tests shared state, browser consent, and interruption. It does
not implement a public remote MCP service or OAuth.

## Run

Build the website using the [root README](../../README.md#build-and-run), then run
the relay from the repository root:

```sh
npm run prototype:agent
```

Open `http://127.0.0.1:4180` in current Chrome or Edge. Click **connect agent** and
copy the MCP configuration into your agent's configuration. Run that connector
on the relay machine, as the same operating-system user.

Ask your agent to call `shell_connect`. Approve its request in the browser.
Then ask:

> Count the ERROR lines in app.log, write the count and error messages to
> summary.txt, and read it back.

Run `cat summary.txt` yourself in the browser. Both participants use the same
files, variables, and working directory. A partially typed local command returns
after an agent command finishes. If a local command is already running, the agent
receives a busy error and can retry.

Click **agent connected** to reopen the panel and disconnect. Disconnecting an
idle agent preserves files. Each command has a five-second execution limit.
Stopping a command or reaching that limit discards files and variables and revokes
agent access. Reloading, resetting, or closing the tab also ends the connection.
Keep the browser tab open and active; background suspension can cause a timeout.

## Connect from another machine

MCP uses standard input/output. Transport it over an existing SSH connection:

```json
{
  "mcpServers": {
    "strands-shell": {
      "command": "ssh",
      "args": [
        "-T",
        "your-user@relay-host",
        "/absolute/path/to/node",
        "/absolute/path/to/shell-demo/prototypes/agent-bridge/mcp.mjs",
        "--session",
        "session-id-from-the-browser"
      ]
    }
  }
}
```

Use the node path, connector path, and session ID shown in the browser. The SSH
account must own the relay process. A fresh browser connection gets a new session
ID and requires an updated MCP configuration. IDs route requests; possession of
an ID alone does not grant access.

The HTTP server binds only to `127.0.0.1`. For a shared browser URL, put it behind
an authenticated reverse proxy that supports WebSockets. Set
`SHELL_PUBLIC_ORIGIN=https://your-demo-host` when starting the relay so that it
accepts that host and WebSocket origin. This setting is an origin allowlist,
not authentication.

## What runs where

```text
MCP client → stdio connector → owner-only Unix socket → relay
                                                         ↕ WebSocket
                                                   browser → WASM shell
```

The relay serves static assets and forwards commands. It never executes those
commands on the host. The agent's model and credentials remain with the agent.
The shell retains its existing disabled networking and virtual filesystem.

The Unix socket directory is mode `0700`, and the socket is mode `0600`.
An agent must pass the operating system's access check and receive approval from
the owning browser WebSocket. Approval applies to one live connector, not every
client with the same session ID. Only one agent can control a tab at a time.

`PORT` defaults to `4180`. `SHELL_BRIDGE_SOCKET` overrides the socket path in both
processes; its parent must be owned by the current user and mode `0700`. Otherwise,
the socket is in `strands-shell-agent-<uid>/relay.sock` under the system temporary
directory. After an unclean shutdown, confirm the old relay has stopped before
removing its stale socket file and restarting.

## Reproduce the experiment

With the relay running, use another terminal in the repository root:

```sh
npx playwright install chromium
npm test
npm run check:agent
DEMO_ORIGIN=http://127.0.0.1:4180 npm run check:browser
```

`check:agent` connects an actual MCP SDK client to Chromium and the built WASM
engine. It exercises approval and denial, connection isolation, shared files,
working-directory and variable persistence, input restoration, busy responses,
revocation, interruption, the watchdog, tab closure, and host/origin restrictions.
It saves results and screenshots in `test-results/`. It does not invoke an LLM.

Use this branch to evaluate the interaction. A public service would need a
standard remote MCP transport and authorization, deployment and session routing,
and limits on shared infrastructure before replacing this local/SSH connector.
