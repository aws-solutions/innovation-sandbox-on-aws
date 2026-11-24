#!/usr/bin/env python3
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0
"""Connect MCP clients (Kiro, Claude Code, Codex, Cursor) to the ISB MCP gateway.

Signs in through the deployment's MCP Cognito app client (browser PKCE on a
loopback callback) and keeps the refresh token on disk. `serve` runs
mcp-proxy-for-aws in-process, attaching a fresh ID token and Identity Pool
credentials to each request, so sessions outlive the one-hour token lifetime.

Usage:
    isb_mcp.py login [--manual-callback]
    isb_mcp.py logout
    isb_mcp.py status
    isb_mcp.py probe
    isb_mcp.py serve        # what an MCP client launches

Requires ISB_URL, the Innovation Sandbox web URL. Everything else is read from
that deployment's public /config.json.
"""

from __future__ import annotations

import argparse
import base64
import contextlib
import hashlib
import html
import http.server
import importlib.util
import json
import os
import queue
import secrets
import shutil
import socket
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import webbrowser
from pathlib import Path
from typing import NoReturn

# Pinned: the in-process proxy wraps one library internal (see run_proxy_in_process),
# so upgrades are deliberate. To upgrade, bump this, then run `npm run test:mcp` and
# `isb_mcp.py probe` against a deployment.
PROXY_PACKAGE = "mcp-proxy-for-aws==1.7.0"
PROXY_PYTHON = "3.12"
LOGIN_TIMEOUT_SECONDS = 180
PROBE_TIMEOUT_SECONDS = 120
# Shorter when `serve` signs in on its own: MCP clients stop waiting for a server
# to start well before a person in a terminal would give up.
SERVE_LOGIN_TIMEOUT_SECONDS = 45
REFRESH_MARGIN_SECONDS = 300
IN_PROXY_ENV = "ISB_MCP_IN_PROXY_ENV"  # guards against re-exec loops


class IsbMcpError(Exception):
    pass


class NeedsLogin(IsbMcpError):
    pass


def log(msg: str) -> None:
    # stdout is the MCP channel under `serve`, so all diagnostics go to stderr.
    print(msg, file=sys.stderr, flush=True)


def die(msg: str) -> NoReturn:
    log(f"isb-mcp: {msg}")
    sys.exit(1)


def http_json(url: str, *, data: bytes | None = None, headers: dict | None = None) -> dict:
    req = urllib.request.Request(url, data=data, headers=headers or {})
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            body = resp.read().decode()
            return json.loads(body) if body else {}
    except urllib.error.HTTPError as e:
        body = e.read().decode(errors="replace")
        raise IsbMcpError(f"{url} -> HTTP {e.code}: {body[:400]}") from None
    except (urllib.error.URLError, TimeoutError) as e:
        # A read timeout raises TimeoutError directly rather than a URLError.
        raise IsbMcpError(f"{url} -> {getattr(e, 'reason', e)}") from None
    except json.JSONDecodeError:
        # e.g. a captive portal or an ISB_URL that serves HTML.
        raise IsbMcpError(f"{url} -> response was not JSON") from None


def b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).decode().rstrip("=")


def jwt_claims(token: str) -> dict:
    try:
        part = token.split(".")[1]
        return json.loads(base64.urlsafe_b64decode(part + "=" * (-len(part) % 4)))
    except (IndexError, ValueError):
        return {}


def describe(id_token: str) -> str:
    c = jwt_claims(id_token)
    mins = round((c.get("exp", 0) - time.time()) / 60)
    return (
        f"{c.get('cognito:username', '?')} roles={c.get('custom:isb_roles', '?')} "
        f"(ID token valid {mins} min)"
    )


# --------------------------------------------------------------------------- #
# Deployment
# --------------------------------------------------------------------------- #


class Deployment:
    def __init__(self, isb_url: str) -> None:
        parsed = urllib.parse.urlparse(isb_url)
        if parsed.scheme != "https" or not parsed.netloc:
            raise IsbMcpError("ISB_URL must be an https:// URL")
        self.origin = f"https://{parsed.netloc}"
        cfg = http_json(f"{self.origin}/config.json")

        def need(key: str):
            if not cfg.get(key):
                raise IsbMcpError(
                    f"{self.origin}/config.json has no {key}. Deploy a version of ISB "
                    "with the MCP app client (Data stack, then Compute stack)."
                )
            return cfg[key]

        self.region = need("Region")
        self.user_pool_id = need("CognitoUserPoolId")
        self.identity_pool_id = need("CognitoIdentityPoolId")
        self.client_id = need("CognitoMcpClientId")
        self.callback_urls: list[str] = need("CognitoMcpCallbackUrls")
        self.gateway_url = need("SandboxAgentMcpGatewayUrl")
        self.token_endpoint = (
            f"https://{need('CognitoDomain')}.auth.{self.region}.amazoncognito.com/oauth2/token"
        )
        self.authorize_endpoint = self.token_endpoint.replace("/token", "/authorize")
        self.revoke_endpoint = self.token_endpoint.replace("/token", "/revoke")

    def _post_form(self, url: str, params: dict) -> dict:
        return http_json(
            url,
            data=urllib.parse.urlencode({"client_id": self.client_id, **params}).encode(),
            headers={"Content-Type": "application/x-www-form-urlencoded"},
        )

    def token_request(self, params: dict) -> dict:
        return self._post_form(self.token_endpoint, params)

    def revoke(self, refresh_token: str) -> None:
        """Invalidates the refresh token in Cognito, so no copy of it can be used."""
        self._post_form(self.revoke_endpoint, {"token": refresh_token})


# --------------------------------------------------------------------------- #
# Token storage
# --------------------------------------------------------------------------- #


class TokenStore:
    """One refresh token per deployment, readable only by the current user."""

    def __init__(self, dep: Deployment) -> None:
        key = b64url(hashlib.sha256(dep.origin.encode()).digest())[:24]
        self.path = self._root() / f"{key}.refresh-token"
        self._lock_path = self.path.with_name(self.path.name + ".lock")

    @staticmethod
    def _root() -> Path:
        if plugin_data := os.environ.get("PLUGIN_DATA"):  # Agent Plugins: survives updates
            return Path(plugin_data)
        if sys.platform == "win32":
            return Path(os.environ.get("APPDATA", Path.home())) / "innovation-sandbox" / "mcp"
        base = os.environ.get("XDG_CONFIG_HOME") or Path.home() / ".config"
        return Path(base) / "innovation-sandbox" / "mcp"

    def _ensure_dir(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with contextlib.suppress(OSError):
            os.chmod(self.path.parent, 0o700)

    def load(self) -> str:
        return self.path.read_text().strip() if self.path.is_file() else ""

    def save(self, token: str) -> None:
        self._ensure_dir()
        tmp = self.path.with_name(f"{self.path.name}.tmp.{os.getpid()}")
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)  # never world-readable
        try:
            with os.fdopen(fd, "w") as f:
                f.write(token)
            os.replace(tmp, self.path)  # atomic: readers see the old token or the new one
        except BaseException:
            tmp.unlink(missing_ok=True)  # it holds a token too
            raise

    def clear(self) -> bool:
        if self.path.exists():
            self.path.unlink()
            return True
        return False

    @contextlib.contextmanager
    def lock(self):
        """Serializes refreshes across concurrent sessions (Kiro, Codex, Claude Code).

        Required because the MCP client rotates refresh tokens: two processes
        refreshing with the same token would invalidate each other.
        """
        self._ensure_dir()
        with open(self._lock_path, "a+") as fh:
            if sys.platform == "win32":
                import msvcrt

                while True:
                    try:
                        msvcrt.locking(fh.fileno(), msvcrt.LK_LOCK, 1)
                        break
                    except OSError:
                        time.sleep(0.2)
                try:
                    yield
                finally:
                    with contextlib.suppress(OSError):
                        msvcrt.locking(fh.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                import fcntl

                fcntl.flock(fh.fileno(), fcntl.LOCK_EX)
                yield  # released when the file closes


# --------------------------------------------------------------------------- #
# Sign-in (authorization code + PKCE)
# --------------------------------------------------------------------------- #


class NoBrowser(IsbMcpError):
    """No browser could be opened for sign-in."""


class StateMismatch(IsbMcpError):
    """The callback wasn't for the sign-in in progress (stale tab, or forged)."""


def parse_callback(url: str, expected_state: str) -> str:
    params = urllib.parse.parse_qs(urllib.parse.urlparse(url.strip()).query)
    # State first: anything can request the fixed localhost callback, so nothing
    # else in the URL is trusted until it proves it belongs to this sign-in.
    # Bytes: compare_digest raises TypeError on non-ASCII str, and this is untrusted input.
    received = params.get("state", [""])[0].encode()
    if not secrets.compare_digest(received, expected_state.encode()):
        raise StateMismatch("state mismatch; sign in again")
    if "error" in params:
        detail = params.get("error_description", [""])[0]
        raise IsbMcpError(f"sign-in failed: {params['error'][0]} {detail}".strip())
    if not params.get("code"):
        raise IsbMcpError("no authorization code in the callback URL")
    return params["code"][0]


class _LoopbackServer(http.server.HTTPServer):
    # Lets a port be bound again right after the previous sign-in (TCP TIME_WAIT).
    # Not on Windows, where the option would let this process share a port in use.
    allow_reuse_address = sys.platform != "win32"


def _port_in_use(port: int) -> bool:
    # With SO_REUSEADDR, macOS allows binding 127.0.0.1 over another program's
    # 0.0.0.0 listener, so a successful bind alone doesn't prove the port is free.
    with socket.socket() as s:
        s.settimeout(0.5)
        return s.connect_ex(("127.0.0.1", port)) == 0


class CallbackListener:
    """Receives the sign-in redirect on the first free registered callback port."""

    def __init__(self, dep: Deployment, state: str) -> None:
        self.result: dict = {}
        self.done = threading.Event()
        listener = self

        class Handler(http.server.BaseHTTPRequestHandler):
            def do_GET(self):  # noqa: N802
                if urllib.parse.urlparse(self.path).path != listener.path:
                    self.send_response(404)
                    self.end_headers()
                    return
                try:
                    listener.result["code"] = parse_callback(self.path, state)
                except StateMismatch:
                    # Not ours; keep waiting so a stray request can't cancel sign-in.
                    self._page(400, "Not this sign-in", "Return to the sign-in in progress.")
                    return
                except IsbMcpError as e:
                    listener.result["error"] = str(e)
                    self._page(200, "Sign-in failed", str(e))
                else:
                    self._page(
                        200,
                        "Signed in",
                        "You can close this tab.",
                        script="<script>setTimeout(()=>window.close(),800)</script>",
                    )
                listener.done.set()

            def _page(self, status: int, title: str, body: str, script: str = "") -> None:
                self.send_response(status)
                self.send_header("Content-Type", "text/html; charset=utf-8")
                self.end_headers()
                self.wfile.write(
                    f"<html><body style='font-family:system-ui;padding:2rem'>"
                    f"<h2>{html.escape(title)}</h2><p>{html.escape(body)}</p>{script}"
                    "</body></html>".encode()
                )

            def log_message(self, format: str, *args: object) -> None:
                pass

        for url in dep.callback_urls:
            callback = urllib.parse.urlparse(url)
            port = callback.port or 80
            if _port_in_use(port):
                continue
            try:
                self.server = _LoopbackServer(("127.0.0.1", port), Handler)
            except OSError:
                continue
            self.redirect_uri, self.path = url, callback.path
            return
        ports = ", ".join(str(urllib.parse.urlparse(u).port) for u in dep.callback_urls)
        raise IsbMcpError(
            f"callback ports {ports} are all in use. Free one, or run `login --manual-callback`."
        )

    def wait(self, timeout: float) -> str:
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        try:
            if not self.done.wait(timeout):
                raise IsbMcpError(f"no sign-in within {timeout:.0f}s")
        finally:
            self.server.shutdown()
        if "error" in self.result:
            raise IsbMcpError(self.result["error"])
        return self.result["code"]

    def close(self) -> None:
        self.server.server_close()


def login(
    dep: Deployment,
    store: TokenStore,
    *,
    manual_callback: bool = False,
    interactive: bool = True,
    timeout: float = LOGIN_TIMEOUT_SECONDS,
) -> str:
    """Runs the browser sign-in, stores the refresh token, and returns the ID token.

    `interactive` is False when `serve` signs in on its own: nobody sees the printed
    URL then, so sign-in fails at once if no browser opens.
    """
    verifier = b64url(secrets.token_bytes(32))
    state = b64url(secrets.token_bytes(16))
    # Bind first: the redirect URI must name the port actually listened on. With a
    # manual callback the redirect never reaches a listener, so any registered URI works.
    listener = None if manual_callback else CallbackListener(dep, state)
    redirect_uri = listener.redirect_uri if listener else dep.callback_urls[0]
    try:
        code = _authorize(dep, listener, redirect_uri, verifier, state, timeout, interactive)
    finally:
        if listener:
            listener.close()

    tokens = dep.token_request(
        {
            "grant_type": "authorization_code",
            "code": code,
            "redirect_uri": redirect_uri,
            "code_verifier": verifier,
        }
    )
    if not tokens.get("refresh_token") or not tokens.get("id_token"):
        raise IsbMcpError("sign-in response was missing tokens")
    with store.lock():
        store.save(tokens["refresh_token"])
    return tokens["id_token"]


def _authorize(
    dep: Deployment,
    listener: CallbackListener | None,
    redirect_uri: str,
    verifier: str,
    state: str,
    timeout: float,
    interactive: bool,
) -> str:
    """Sends the user to the hosted sign-in page and returns the authorization code."""
    url = (
        dep.authorize_endpoint
        + "?"
        + urllib.parse.urlencode(
            {
                "response_type": "code",
                "client_id": dep.client_id,
                "redirect_uri": redirect_uri,
                "scope": "openid profile email",
                "code_challenge": b64url(hashlib.sha256(verifier.encode()).digest()),
                "code_challenge_method": "S256",
                "state": state,
            }
        )
    )

    log(f"\nSign in to Innovation Sandbox:\n\n  {url}\n")
    # Cognito requires an exact callback match; a mismatch usually means the Data
    # stack was deployed without the Compute stack that publishes config.json.
    log(f"(If Cognito shows `redirect_mismatch` for {redirect_uri}, redeploy the Compute stack.)\n")

    if listener is None:
        # The browser can be anywhere — another machine over SSH, or a private
        # window to sign in as a different account. Its redirect to localhost fails
        # to load, but the code is in the address bar.
        log("After signing in, copy the full URL of the page that fails to load and paste it here:")
        return parse_callback(input("> "), state)
    if not (_can_open_gui_browser() and webbrowser.open(url)):
        if not interactive:
            raise NoBrowser("could not open a browser")
        # Keep waiting: the URL can be opened anywhere, e.g. through an SSH tunnel.
        log(
            "Couldn't open a browser here. Open the URL above in any browser, or run "
            "`login --manual-callback`."
        )
    log("Waiting for sign-in ...")
    return listener.wait(timeout)


def _can_open_gui_browser() -> bool:
    # Without a display, Linux's webbrowser module falls back to text browsers (lynx,
    # w3m) that run in this terminal — and under `serve` stdout is the MCP channel.
    if sys.platform.startswith("linux"):
        return bool(os.environ.get("DISPLAY") or os.environ.get("WAYLAND_DISPLAY"))
    return True


# --------------------------------------------------------------------------- #
# Credentials
# --------------------------------------------------------------------------- #


def refresh_id_token(dep: Deployment, store: TokenStore) -> str:
    with store.lock():
        refresh_token = store.load()
        if not refresh_token:
            raise NeedsLogin("not signed in")
        try:
            tokens = dep.token_request(
                {"grant_type": "refresh_token", "refresh_token": refresh_token}
            )
        except IsbMcpError as e:
            if "invalid_grant" in str(e):
                raise NeedsLogin("sign-in expired or was revoked") from None
            raise
        # Rotation: each refresh returns a new refresh token and retires the old one.
        if tokens.get("refresh_token"):
            store.save(tokens["refresh_token"])
    if not tokens.get("id_token"):
        raise IsbMcpError("refresh response had no id_token")
    return tokens["id_token"]


def identity_pool_credentials(dep: Deployment, id_token: str) -> tuple[dict, float]:
    """Exchanges an ID token for AWS credentials, as the ISB web console does.

    Returns the credentials as environment variables, and their expiry (epoch seconds).
    """
    logins = {f"cognito-idp.{dep.region}.amazonaws.com/{dep.user_pool_id}": id_token}

    def call(target: str, body: dict) -> dict:
        return http_json(
            f"https://cognito-identity.{dep.region}.amazonaws.com/",
            data=json.dumps(body).encode(),
            headers={
                "Content-Type": "application/x-amz-json-1.1",
                "X-Amz-Target": f"AWSCognitoIdentityService.{target}",
            },
        )

    identity = call("GetId", {"IdentityPoolId": dep.identity_pool_id, "Logins": logins})
    creds = call(
        "GetCredentialsForIdentity", {"IdentityId": identity["IdentityId"], "Logins": logins}
    )["Credentials"]
    env = {
        "AWS_ACCESS_KEY_ID": creds["AccessKeyId"],
        "AWS_SECRET_ACCESS_KEY": creds["SecretKey"],  # the API calls it SecretKey
        "AWS_SESSION_TOKEN": creds["SessionToken"],
    }
    return env, float(creds["Expiration"])


class SessionCredentials:
    """The current ID token and AWS credentials, renewed shortly before either expires."""

    def __init__(self, dep: Deployment, store: TokenStore) -> None:
        self.dep, self.store = dep, store
        self._lock = threading.Lock()
        self._id_token = ""
        self._aws_env: dict = {}
        self._valid_until = 0.0

    def current(self) -> tuple[str, dict]:
        with self._lock:
            if time.time() + REFRESH_MARGIN_SECONDS >= self._valid_until:
                try:
                    self._id_token = refresh_id_token(self.dep, self.store)
                except NeedsLogin as e:
                    # Never opens a browser mid-session; surfaces to the MCP client
                    # as a tool error instead.
                    msg = f"Innovation Sandbox {e}. Restart this MCP server to sign in again."
                    log(msg)
                    raise IsbMcpError(msg) from None
                self._aws_env, aws_exp = identity_pool_credentials(self.dep, self._id_token)
                self._valid_until = min(jwt_claims(self._id_token).get("exp", 0), aws_exp)
                log(f"credentials refreshed for {describe(self._id_token)}")
            return self._id_token, self._aws_env


def logout(dep: Deployment, store: TokenStore) -> None:
    with store.lock():
        refresh_token = store.load()
        if not refresh_token:
            log("not signed in")
            return
        try:
            dep.revoke(refresh_token)
        except IsbMcpError as e:
            # Still forget it locally; it stays usable until it expires.
            log(f"warning: could not revoke the refresh token in Cognito ({e})")
        store.clear()
    log("signed out")
    log(
        "A running MCP server keeps its current credentials for up to an hour; restart it "
        "to stop it now. Your browser is still signed in — to switch accounts, run "
        "`login --manual-callback` and open the URL in a private window."
    )


def ensure_signed_in(
    dep: Deployment, store: TokenStore, *, timeout: float, interactive: bool
) -> None:
    try:
        refresh_id_token(dep, store)
    except NeedsLogin as e:
        log(f"{e}; signing in")
        try:
            login(dep, store, timeout=timeout, interactive=interactive)
        except IsbMcpError as login_error:
            raise IsbMcpError(
                f"{login_error}. If this machine has no browser (for example over SSH), "
                "run `isb_mcp.py login --manual-callback` in a terminal, then restart the MCP "
                "server."
            ) from None


# --------------------------------------------------------------------------- #
# Proxy
# --------------------------------------------------------------------------- #


def run_proxy_in_process(dep: Deployment, session: SessionCredentials) -> int:
    """Runs mcp-proxy-for-aws with a per-request identity hook.

    Running in-process — instead of spawning the proxy with a fixed `--header` —
    means the ID token and AWS credentials refresh during long sessions, and the
    token never appears in process arguments.
    """
    import asyncio

    import mcp_proxy_for_aws.utils as proxy_utils
    from mcp_proxy_for_aws.cli import parse_args
    from mcp_proxy_for_aws.logging_config import (
        configure_logging,
    )
    from mcp_proxy_for_aws.server import run_proxy

    async def identity_hook(request) -> None:
        # Runs before the library's SigV4 hook, so the header is covered by the
        # signature; the signer re-reads credentials from the environment on every
        # request, so it picks up refreshed ones.
        id_token, aws_env = await asyncio.to_thread(session.current)
        os.environ.update(aws_env)
        request.headers["x-isb-identity"] = id_token

    if not hasattr(proxy_utils, "create_sigv4_client"):
        raise IsbMcpError(
            "this mcp-proxy-for-aws release no longer has utils.create_sigv4_client; "
            "set PROXY_PACKAGE back to a version that does"
        )
    create_client = proxy_utils.create_sigv4_client

    def create_client_with_identity(*args, **kwargs):
        client = create_client(*args, **kwargs)
        hooks = client.event_hooks
        client.event_hooks = {**hooks, "request": [identity_hook, *hooks["request"]]}
        return client

    # The one library internal this script depends on: the transport factory looks
    # this up by module-level name when it builds each HTTP client.
    proxy_utils.create_sigv4_client = create_client_with_identity

    # Explicit credentials only — an inherited profile would take precedence.
    for var in ("AWS_PROFILE", "AWS_DEFAULT_PROFILE"):
        os.environ.pop(var, None)
    os.environ.update(AWS_REGION=dep.region, AWS_DEFAULT_REGION=dep.region)
    os.environ.update(session.current()[1])  # fail fast, before the MCP client connects

    sys.argv = [
        "mcp-proxy-for-aws",
        dep.gateway_url,
        "--service",
        "bedrock-agentcore",
        "--region",
        dep.region,
    ]
    args = parse_args()
    configure_logging(args.log_level)
    asyncio.run(run_proxy(args))
    return 0


def serve(dep: Deployment, store: TokenStore) -> int:
    if importlib.util.find_spec("mcp_proxy_for_aws") is None:
        if os.environ.get(IN_PROXY_ENV):
            raise IsbMcpError(f"{PROXY_PACKAGE} is not importable in the uv environment") from None
        # Sign in now, while the terminal is still ours; then re-run under uvx with
        # the proxy installed. stdio carries over to the MCP client.
        ensure_signed_in(dep, store, timeout=SERVE_LOGIN_TIMEOUT_SECONDS, interactive=False)
        uvx = shutil.which("uvx")
        if not uvx:
            raise IsbMcpError("uvx not found; install uv: https://docs.astral.sh/uv/") from None
        cmd = [
            uvx,
            "--python",
            PROXY_PYTHON,
            "--from",
            PROXY_PACKAGE,
            "python",
            str(Path(__file__).resolve()),
            "serve",
        ]
        env = {**os.environ, IN_PROXY_ENV: "1"}
        if sys.platform == "win32":
            return subprocess.call(cmd, env=env)
        os.execvpe(cmd[0], cmd, env)
    return run_proxy_in_process(dep, SessionCredentials(dep, store))


def line_queue(stream) -> queue.Queue[str | None]:
    """Reads lines on a thread so callers can wait with a timeout. None marks EOF."""
    lines: queue.Queue[str | None] = queue.Queue()

    def pump() -> None:
        for line in stream:
            lines.put(line)
        lines.put(None)

    threading.Thread(target=pump, daemon=True).start()
    return lines


def await_response(lines: queue.Queue[str | None], msg_id: int, timeout: float) -> dict | None:
    """Returns the JSON-RPC message with `msg_id`, or None on timeout or EOF."""
    deadline = time.monotonic() + timeout
    while (remaining := deadline - time.monotonic()) > 0:
        try:
            line = lines.get(timeout=remaining)
        except queue.Empty:
            return None
        if line is None:
            return None
        with contextlib.suppress(json.JSONDecodeError):
            msg = json.loads(line)
            if isinstance(msg, dict) and msg.get("id") == msg_id:
                return msg
    return None


def probe(dep: Deployment, store: TokenStore) -> int:
    """Runs `serve` as a child and talks to it over stdio, as an MCP client would."""
    ensure_signed_in(dep, store, timeout=LOGIN_TIMEOUT_SECONDS, interactive=True)
    proc = subprocess.Popen(
        [sys.executable, str(Path(__file__).resolve()), "serve"],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    assert proc.stdin and proc.stdout and proc.stderr
    stdin, stdout, proc_stderr = proc.stdin, proc.stdout, proc.stderr
    stderr: list[str] = []
    threading.Thread(target=lambda: stderr.extend(proc_stderr), daemon=True).start()
    lines = line_queue(stdout)

    def request(msg_id: int, method: str, params: dict) -> dict:
        stdin.write(
            json.dumps({"jsonrpc": "2.0", "id": msg_id, "method": method, "params": params}) + "\n"
        )
        stdin.flush()
        msg = await_response(lines, msg_id, PROBE_TIMEOUT_SECONDS)
        if msg is None:
            raise IsbMcpError(
                f"no response to {method} within {PROBE_TIMEOUT_SECONDS}s. Proxy output:\n"
                + "".join(stderr[-15:])
            )
        if "error" in msg:
            raise IsbMcpError(f"{method} failed: {msg['error']}")
        return msg["result"]

    try:
        init = request(
            1,
            "initialize",
            {
                "protocolVersion": "2024-11-05",
                "capabilities": {},
                "clientInfo": {"name": "isb-mcp-probe", "version": "1"},
            },
        )
        log(f"connected: {init.get('serverInfo', {}).get('name')}")
        stdin.write(json.dumps({"jsonrpc": "2.0", "method": "notifications/initialized"}) + "\n")

        tools = [t["name"] for t in request(2, "tools/list", {})["tools"]]
        log(f"tools: {len(tools)} available for your role")

        # tools/list is answered by the gateway; a call proves the ISB API itself
        # accepts the forwarded identity. GetConfigurations is read-only, takes no
        # arguments, and is open to every role.
        probe_tool = next((t for t in tools if t.endswith("___GetConfigurations")), None)
        if not probe_tool:
            raise IsbMcpError("GetConfigurations is missing from tools/list")
        result = request(3, "tools/call", {"name": probe_tool, "arguments": {}})
        if result.get("isError"):
            text = " ".join(c.get("text", "") for c in result.get("content", []))
            raise IsbMcpError(f"{probe_tool} failed: {text[:300]}")
        log(f"tool call: {probe_tool} OK")
        log("probe passed")
        return 0
    finally:
        proc.kill()


# --------------------------------------------------------------------------- #
# CLI
# --------------------------------------------------------------------------- #


def main() -> int:
    parser = argparse.ArgumentParser(
        prog="isb_mcp.py", description=(__doc__ or "").split("\n\n")[0]
    )
    sub = parser.add_subparsers(dest="cmd", required=True)
    p_login = sub.add_parser("login", help="sign in and store a refresh token")
    p_login.add_argument(
        "--manual-callback",
        action="store_true",
        help="sign in in any browser (another machine, or a private window) and paste "
        "the redirect URL back",
    )
    sub.add_parser("logout", help="revoke and forget the stored refresh token")
    sub.add_parser("status", help="show who you are signed in as")
    sub.add_parser("probe", help="end-to-end self-test")
    sub.add_parser("serve", help="run as an MCP server over stdio")
    args = parser.parse_args()

    if not os.environ.get("ISB_URL"):
        die("set ISB_URL to your Innovation Sandbox web URL")

    try:
        dep = Deployment(os.environ["ISB_URL"])
        store = TokenStore(dep)

        if args.cmd == "login":
            id_token = login(dep, store, manual_callback=args.manual_callback)
            log(f"\nsigned in as {describe(id_token)}")
        elif args.cmd == "logout":
            logout(dep, store)
        elif args.cmd == "status":
            try:
                log(f"signed in as {describe(refresh_id_token(dep, store))}")
            except NeedsLogin as e:
                log(f"{e}; run `isb_mcp.py login`")
                return 1
        elif args.cmd == "probe":
            return probe(dep, store)
        elif args.cmd == "serve":
            return serve(dep, store)
        return 0
    except IsbMcpError as e:
        die(str(e))
    except KeyboardInterrupt:
        return 130


if __name__ == "__main__":
    sys.exit(main())
