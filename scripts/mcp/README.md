# MCP — Connect an IDE to Innovation Sandbox

Exposes the Innovation Sandbox API as MCP tools in Kiro, Claude Code, Codex, Cursor, or any
MCP client that can launch a stdio server. You sign in with your normal Innovation Sandbox
account; no AWS account or credentials of your own are needed.

This is for interactive MCP clients only. For scripts and CI, use [`scripts/m2m/`](../m2m/).

## Quick start

You need [Python 3.10+ and uv](#prerequisites).

1. **Point the script at your deployment** — the URL of the Innovation Sandbox web console:

   ```bash
   export ISB_URL='https://<your-isb-domain>'
   ```

2. **Sign in.** A browser opens; sign in as you would to the web console. On a machine without a
   browser (for example over SSH), see [Signing in on a remote machine](#signing-in-on-a-remote-machine-ssh).

   ```bash
   python3 scripts/mcp/isb_mcp.py login
   ```

3. **Check the connection** (optional). Lists the tools available to your role and makes one
   read-only call:

   ```bash
   python3 scripts/mcp/isb_mcp.py probe
   ```

4. **Add the server to your MCP client** (see [Client configuration](#client-configuration)),
   then restart the client so it picks up the change.

5. **Try it.** Ask your assistant something like _"List my Innovation Sandbox leases."_

Sign-in lasts about a week. When it expires, the server signs in again on its next start, or run
`login` again.

## Prerequisites

- **Python 3.10+**
- **[uv](https://docs.astral.sh/uv/getting-started/installation/)** — `serve` uses `uvx` to run
  [`mcp-proxy-for-aws`](https://github.com/aws/mcp-proxy-for-aws) in an isolated environment, so
  nothing is installed into your system Python. Install it with one of:

  ```bash
  brew install uv                                      # macOS (Homebrew)
  curl -LsSf https://astral.sh/uv/install.sh | sh      # macOS / Linux
  powershell -c "irm https://astral.sh/uv/install.ps1 | iex"   # Windows
  ```

  Check with `uvx --version`. The first `serve` downloads the proxy (a pinned version, set by
  `PROXY_PACKAGE` in the script), which takes a few seconds; later starts reuse the cached copy.

- An Innovation Sandbox deployment that includes the MCP app client, and an account with an ISB
  role (Admin, Manager, or User). Tools are filtered to your role.

`ISB_URL` is the only setting. Everything else — Cognito ids, region, callback URLs, gateway URL —
is read from the deployment's public `/config.json`.

## Commands

| Command                   | Does                                                                                                                                                                                              |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `serve`                   | Runs as an MCP server over stdio. This is what your MCP client launches. Opens a browser to sign in when needed.                                                                                  |
| `login`                   | Signs in from a terminal. Recommended before first use: `serve` can also sign in, but gives up after 45 seconds so your MCP client doesn't time out waiting for it.                               |
| `login --manual-callback` | Sign in in any browser (another machine, or a private window), then paste back the URL of the page that fails to load. See [Signing in on a remote machine](#signing-in-on-a-remote-machine-ssh). |
| `logout`                  | Revokes the refresh token in Cognito and deletes it locally. A running MCP server keeps working for up to an hour; restart it to stop it immediately. Your browser stays signed in.               |
| `status`                  | Shows who you are signed in as.                                                                                                                                                                   |
| `probe`                   | Connects, lists tools, and makes one read-only tool call.                                                                                                                                         |

## Client configuration

Use an absolute path to the script. The same server entry works in each client's MCP config file:

```json
{
  "mcpServers": {
    "isb": {
      "command": "python3",
      "args": ["/absolute/path/to/scripts/mcp/isb_mcp.py", "serve"],
      "env": { "ISB_URL": "https://<your-isb-domain>" }
    }
  }
}
```

| Client      | Config file                                                                         |
| ----------- | ----------------------------------------------------------------------------------- |
| Kiro        | `~/.kiro/settings/mcp.json`                                                         |
| Claude Code | `~/.claude.json`, or `claude mcp add`                                               |
| Cursor      | `~/.cursor/mcp.json`                                                                |
| Codex       | `~/.codex/config.toml` (`[mcp_servers.isb]` with the same `command`, `args`, `env`) |

## Signing in on a remote machine (SSH)

On a machine without a browser, sign in with a browser on your own computer and copy the result
back:

1. On the remote machine, run:

   ```bash
   python3 scripts/mcp/isb_mcp.py login --manual-callback
   ```

   It prints a sign-in URL and waits at a `>` prompt.

2. Open that URL in a browser on your own computer and sign in.
3. The browser is sent to `http://localhost:29367/callback?code=…&state=…` and the page fails to
   load. That's expected: the sign-in result is in the address bar.
4. Copy the full URL from the address bar and paste it at the `>` prompt on the remote machine.

Finish within a few minutes: the code in the URL can be used only once and expires quickly. If it
does, run `login --manual-callback` again.

If something on your computer is listening on port 29367 (for example, your own local `login`),
the page may load instead of failing. Copy the URL anyway.

**Tip:** if you connect with `ssh` yourself, forwarding the callback port avoids the copy step:
connect with `ssh -L 29367:localhost:29367 <host>`, run plain `login` on the remote machine, and
open the printed URL locally. The redirect reaches the remote script through the tunnel.

## How it works

1. **Sign-in** — authorization code with PKCE against the deployment's dedicated MCP Cognito app
   client, via a loopback callback on the first free port of `localhost:29367`–`29369`.
2. **Refresh token** — stored per deployment at `~/.config/innovation-sandbox/mcp/`
   (`%APPDATA%\innovation-sandbox\mcp` on Windows), mode `0600`. Refresh tokens rotate on every
   use; a file lock keeps concurrent sessions from invalidating each other.
3. **Per request** — `serve` runs `mcp-proxy-for-aws` in-process and attaches a current ID token
   (`x-isb-identity`) and Identity Pool credentials (SigV4) to each request, renewing them before
   they expire. Sessions therefore outlast the one-hour token lifetime, and the token never
   appears in process arguments.

Sessions last for the refresh-token lifetime (`cognitoRefreshTokenValidityDays`, 7 days by
default), counted from sign-in. After that, tool calls fail with "sign-in expired"; restart the
server to sign in again.

## Troubleshooting

| Symptom                                    | Fix                                                                                                                                                                                                                                                                      |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Cognito page shows `redirect_mismatch`     | The app client and `/config.json` disagree on the callback URL — usually the Data stack was deployed without the Compute stack. Redeploy Compute.                                                                                                                        |
| `callback ports … are all in use`          | Other programs hold ports 29367–29369. Free one, or use `login --manual-callback`.                                                                                                                                                                                       |
| Signed in as the wrong account             | Your browser reused an existing session. `logout`, then `login --manual-callback` and open the URL in a private window.                                                                                                                                                  |
| `serve` fails with `no sign-in within 45s` | No browser opened (common over SSH), or sign-in took too long. Run `login --manual-callback` in a terminal, then restart the MCP server.                                                                                                                                 |
| Tool calls fail with `sign-in expired`     | The refresh token expired or was revoked. Restart the MCP server to sign in again, or run `login` first.                                                                                                                                                                 |
| `config.json has no CognitoMcp…`           | The deployment predates the MCP app client. Deploy the Data stack, then Compute.                                                                                                                                                                                         |
| `uvx not found`                            | Install [uv](#prerequisites). If `uvx --version` works in your terminal but the MCP client still can't find it, the client was started with a shorter `PATH` (common for desktop apps on macOS). Add `"PATH"` with the directory from `which uvx` to the server's `env`. |
| Tool calls return 403                      | Your ISB role doesn't allow that operation. `status` shows your role.                                                                                                                                                                                                    |
