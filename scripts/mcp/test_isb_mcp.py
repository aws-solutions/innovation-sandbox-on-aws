# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0
"""Tests for isb_mcp.py. Standard library only; run with `npm run test:mcp`."""

from __future__ import annotations

import base64
import json
import os
import socket
import subprocess
import sys
import tempfile
import threading
import time
import types
import unittest
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest import mock

import isb_mcp


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class FakeDeployment:
    authorize_endpoint = "https://auth.example.test/oauth2/authorize"
    client_id = "mcp-client"

    def __init__(self) -> None:
        self.callback_urls = [f"http://localhost:{free_port()}/callback"]


def get(url: str) -> tuple[int, str]:
    try:
        with urllib.request.urlopen(url, timeout=5) as resp:
            return resp.status, resp.read().decode()
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()


class ParseCallbackTest(unittest.TestCase):
    def test_checks_state_before_the_error_fields(self):
        url = "http://localhost/callback?error=access_denied&state=forged"
        with self.assertRaises(isb_mcp.StateMismatch):
            isb_mcp.parse_callback(url, "expected")

    def test_non_ascii_state_is_a_plain_mismatch(self):
        with self.assertRaises(isb_mcp.StateMismatch):
            isb_mcp.parse_callback("http://localhost/callback?state=%C3%A9&code=c", "expected")

    def test_reports_errors_that_carry_the_right_state(self):
        url = "http://localhost/callback?error=access_denied&error_description=nope&state=s"
        with self.assertRaisesRegex(isb_mcp.IsbMcpError, "sign-in failed: access_denied nope"):
            isb_mcp.parse_callback(url, "s")

    def test_returns_the_code(self):
        self.assertEqual(isb_mcp.parse_callback("http://x/callback?code=c&state=s", "s"), "c")


class CallbackListenerTest(unittest.TestCase):
    def setUp(self):
        self.listener = isb_mcp.CallbackListener(FakeDeployment(), "the-state")
        port = self.listener.server.server_address[1]
        self.base = f"http://127.0.0.1:{port}{self.listener.path}"
        self.result: dict = {}
        self.waiter = threading.Thread(target=self._wait, daemon=True)
        self.waiter.start()

    def tearDown(self):
        self.listener.close()

    def _wait(self):
        try:
            self.result["code"] = self.listener.wait(5)
        except isb_mcp.IsbMcpError as e:
            self.result["error"] = str(e)

    def _request(self, **params: str) -> tuple[int, str]:
        time.sleep(0.1)  # let serve_forever start
        return get(f"{self.base}?{urllib.parse.urlencode(params)}")

    def test_wrong_state_does_not_end_sign_in(self):
        status, body = self._request(error="<script>alert(1)</script>", state="forged")
        self.assertEqual(status, 400)
        self.assertNotIn("<script>alert", body)
        self.assertFalse(self.listener.done.is_set())

        status, _ = self._request(code="real-code", state="the-state")
        self.assertEqual(status, 200)
        self.waiter.join(5)
        self.assertEqual(self.result, {"code": "real-code"})

    def test_non_ascii_state_gets_the_mismatch_page(self):
        status, _ = self._request(state="\u00e9", code="forged")
        self.assertEqual(status, 400)
        self.assertFalse(self.listener.done.is_set())

    def test_escapes_error_text_in_the_page(self):
        status, body = self._request(
            error="access_denied",
            error_description="<img src=x onerror=alert(1)>",
            state="the-state",
        )
        self.assertEqual(status, 200)
        self.assertIn("&lt;img src=x onerror=alert(1)&gt;", body)
        self.assertNotIn("<img", body)
        self.waiter.join(5)
        self.assertIn("sign-in failed", self.result["error"])


class AwaitResponseTest(unittest.TestCase):
    def test_times_out_when_the_proxy_is_silent(self):
        read_fd, write_fd = os.pipe()  # never written to: a plain readline() would block
        with os.fdopen(read_fd) as stream:
            started = time.monotonic()
            self.assertIsNone(isb_mcp.await_response(isb_mcp.line_queue(stream), 1, timeout=0.5))
            self.assertLess(time.monotonic() - started, 2)
            os.close(write_fd)

    def test_returns_none_when_the_proxy_exits(self):
        read_fd, write_fd = os.pipe()
        os.close(write_fd)
        with os.fdopen(read_fd) as stream:
            self.assertIsNone(isb_mcp.await_response(isb_mcp.line_queue(stream), 1, timeout=5))

    def test_skips_unrelated_lines_and_returns_the_matching_message(self):
        read_fd, write_fd = os.pipe()
        with os.fdopen(write_fd, "w") as w:
            w.write('not json\n{"jsonrpc":"2.0","id":2,"result":{}}\n')
            w.write('{"jsonrpc":"2.0","id":1,"result":{"ok":true}}\n')
        with os.fdopen(read_fd) as stream:
            msg = isb_mcp.await_response(isb_mcp.line_queue(stream), 1, timeout=5)
        self.assertEqual(msg, {"jsonrpc": "2.0", "id": 1, "result": {"ok": True}})


class BrowserLaunchTest(unittest.TestCase):
    """`serve` must fail at once without a browser; `login` keeps waiting."""

    def setUp(self):
        for patcher in (
            mock.patch.object(isb_mcp, "log"),
            mock.patch.object(isb_mcp, "TokenStore"),  # never reached: no code arrives
        ):
            patcher.start()
            self.addCleanup(patcher.stop)

    def sign_in(self, *, interactive: bool, opens: bool, platform: str, env: dict) -> tuple:
        with (
            mock.patch.object(isb_mcp.webbrowser, "open", return_value=opens) as open_browser,
            mock.patch.object(isb_mcp.sys, "platform", platform),
            mock.patch.dict(os.environ, env, clear=True),
        ):
            started = time.monotonic()
            try:
                isb_mcp.login(FakeDeployment(), None, interactive=interactive, timeout=0.5)
            except isb_mcp.IsbMcpError as e:
                return e, open_browser, time.monotonic() - started
        self.fail("sign-in should not complete without a callback")

    def test_serve_fails_at_once_when_no_browser_opens(self):
        error, _, elapsed = self.sign_in(interactive=False, opens=False, platform="darwin", env={})
        self.assertIsInstance(error, isb_mcp.NoBrowser)
        self.assertLess(elapsed, 0.4)

    def test_serve_never_starts_a_text_browser_on_headless_linux(self):
        error, open_browser, _ = self.sign_in(
            interactive=False, opens=True, platform="linux", env={}
        )
        self.assertIsInstance(error, isb_mcp.NoBrowser)
        open_browser.assert_not_called()

    def test_serve_waits_when_a_browser_opens(self):
        error, open_browser, _ = self.sign_in(
            interactive=False, opens=True, platform="linux", env={"DISPLAY": ":0"}
        )
        open_browser.assert_called_once()
        self.assertRegex(str(error), "no sign-in within")

    def test_login_keeps_waiting_without_a_browser(self):
        # e.g. the URL is opened on another machine through an SSH tunnel
        error, open_browser, elapsed = self.sign_in(
            interactive=True, opens=True, platform="linux", env={}
        )
        open_browser.assert_not_called()
        self.assertRegex(str(error), "no sign-in within")
        self.assertGreaterEqual(elapsed, 0.4)
        messages = " ".join(str(call.args[0]) for call in isb_mcp.log.call_args_list)
        self.assertIn("Open the URL above in any browser", messages)

    def test_serve_points_to_manual_callback(self):
        with (
            mock.patch.object(isb_mcp, "refresh_id_token", side_effect=isb_mcp.NeedsLogin("x")),
            mock.patch.object(isb_mcp, "login", side_effect=isb_mcp.NoBrowser("no browser")),
            self.assertRaisesRegex(isb_mcp.IsbMcpError, "login --manual-callback"),
        ):
            isb_mcp.ensure_signed_in(None, None, timeout=1, interactive=False)


# --------------------------------------------------------------------------- #
# Tokens: rotation, locking, persistence, refresh failures
# --------------------------------------------------------------------------- #


def make_id_token(ttl: float = 3600) -> str:
    def part(data: dict) -> str:
        return base64.urlsafe_b64encode(json.dumps(data).encode()).decode().rstrip("=")

    claims = {"sub": "user-sub", "email": "user@example.com", "exp": int(time.time() + ttl)}
    return f"{part({'alg': 'none'})}.{part(claims)}.sig"


class FakeCognito:
    """Token endpoint whose refresh tokens are single-use, like Cognito with rotation.

    Stricter than Cognito (no grace period), so any reuse of a rotated token fails.
    """

    def __init__(self, first_token: str = "rt-0") -> None:
        self.valid = {first_token}
        self.used: list[str] = []
        self.mode = "rotate"  # rotate | no_rotation | invalid_grant | server_error | no_id_token
        self.delay = 0.0  # widens the window in which unlocked refreshes would race
        self.id_token_ttl = 3600.0
        self._issued = 0
        self._lock = threading.Lock()
        fake = self

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):  # noqa: N802
                length = int(self.headers["Content-Length"])
                params = urllib.parse.parse_qs(self.rfile.read(length).decode())
                status, body = fake.respond(params["refresh_token"][0])
                payload = json.dumps(body).encode()
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)

            def log_message(self, format: str, *args: object) -> None:
                pass

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}/oauth2/token"
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def respond(self, refresh_token: str) -> tuple[int, dict]:
        time.sleep(self.delay)
        with self._lock:
            if self.mode == "server_error":
                return 500, {"message": "internal error"}
            if self.mode == "invalid_grant" or refresh_token not in self.valid:
                return 400, {"error": "invalid_grant"}
            self.used.append(refresh_token)
            body: dict = {"id_token": make_id_token(self.id_token_ttl), "access_token": "at"}
            if self.mode == "no_id_token":
                del body["id_token"]
            if self.mode != "no_rotation":
                self.valid.discard(refresh_token)
                self._issued += 1
                body["refresh_token"] = f"rt-{self._issued}"
                self.valid.add(body["refresh_token"])
            return 200, body

    def close(self) -> None:
        self.server.shutdown()
        self.server.server_close()


class TokenDeployment(isb_mcp.Deployment):
    """A Deployment pointed at FakeCognito, without fetching config.json."""

    def __init__(self, token_url: str) -> None:  # skips super(): it fetches config.json
        self.origin = "https://isb.example.test"
        self.client_id = "mcp-client"
        self.token_endpoint = token_url
        self.revoke_endpoint = token_url.replace("/token", "/revoke")


class TokenTestCase(unittest.TestCase):
    """Each test gets its own token directory and fake token endpoint."""

    def setUp(self):
        self.config_dir = tempfile.TemporaryDirectory()
        env = mock.patch.dict(os.environ, {"XDG_CONFIG_HOME": self.config_dir.name})
        env.start()
        os.environ.pop("PLUGIN_DATA", None)
        self.addCleanup(env.stop)
        self.addCleanup(self.config_dir.cleanup)
        self.cognito = FakeCognito()
        self.addCleanup(self.cognito.close)
        self.dep = TokenDeployment(self.cognito.url)
        self.store = isb_mcp.TokenStore(self.dep)
        self.store.save("rt-0")


class RotationTest(TokenTestCase):
    def test_saves_the_rotated_refresh_token(self):
        isb_mcp.refresh_id_token(self.dep, self.store)
        self.assertEqual(self.store.load(), "rt-1")
        isb_mcp.refresh_id_token(self.dep, self.store)  # the old token would now be rejected
        self.assertEqual(self.store.load(), "rt-2")

    def test_keeps_the_token_when_the_response_has_no_new_one(self):
        self.cognito.mode = "no_rotation"
        isb_mcp.refresh_id_token(self.dep, self.store)
        self.assertEqual(self.store.load(), "rt-0")


CHILD = """
import sys
sys.path.insert(0, {scripts_dir!r})
import isb_mcp, test_isb_mcp
dep = test_isb_mcp.TokenDeployment({url!r})
store = isb_mcp.TokenStore(dep)
for _ in range({count}):
    isb_mcp.refresh_id_token(dep, store)
"""


class CrossProcessLockTest(TokenTestCase):
    def test_concurrent_processes_never_reuse_a_rotated_token(self):
        self.cognito.delay = 0.05
        processes, count = 3, 5
        code = CHILD.format(
            scripts_dir=str(Path(__file__).resolve().parent), url=self.cognito.url, count=count
        )
        children = [
            subprocess.Popen([sys.executable, "-B", "-c", code], stderr=subprocess.PIPE, text=True)
            for _ in range(processes)
        ]
        for child in children:
            _, err = child.communicate(timeout=60)
            self.assertEqual(child.returncode, 0, err)
        self.assertEqual(len(self.cognito.used), processes * count)
        self.assertEqual(len(set(self.cognito.used)), processes * count)  # each used once
        self.assertIn(self.store.load(), self.cognito.valid)


class PersistenceTest(TokenTestCase):
    @unittest.skipIf(sys.platform == "win32", "POSIX permissions")
    def test_token_file_is_private(self):
        self.assertEqual(self.store.path.stat().st_mode & 0o777, 0o600)

    def test_leaves_no_temp_files(self):
        self.store.save("rt-new")
        self.assertEqual(
            sorted(p.name for p in self.store.path.parent.iterdir() if "refresh-token" in p.name),
            [self.store.path.name],
        )

    def test_failed_save_keeps_the_previous_token(self):
        with (
            mock.patch.object(isb_mcp.os, "replace", side_effect=OSError("disk full")),
            self.assertRaises(OSError),
        ):
            self.store.save("rt-new")
        self.assertEqual(self.store.load(), "rt-0")
        self.assertFalse([p for p in self.store.path.parent.iterdir() if ".tmp." in p.name])


class RefreshFailureTest(TokenTestCase):
    def test_invalid_grant_means_sign_in_again(self):
        self.cognito.mode = "invalid_grant"
        with self.assertRaises(isb_mcp.NeedsLogin):
            isb_mcp.refresh_id_token(self.dep, self.store)

    def test_other_errors_do_not_ask_for_sign_in(self):
        self.cognito.mode = "server_error"
        with self.assertRaises(isb_mcp.IsbMcpError) as caught:
            isb_mcp.refresh_id_token(self.dep, self.store)
        self.assertNotIsInstance(caught.exception, isb_mcp.NeedsLogin)
        self.assertEqual(self.store.load(), "rt-0")

    def test_no_stored_token_means_sign_in(self):
        self.store.clear()
        with self.assertRaises(isb_mcp.NeedsLogin):
            isb_mcp.refresh_id_token(self.dep, self.store)

    def test_response_without_an_id_token_is_an_error(self):
        self.cognito.mode = "no_id_token"
        with self.assertRaisesRegex(isb_mcp.IsbMcpError, "no id_token"):
            isb_mcp.refresh_id_token(self.dep, self.store)


class SessionCredentialsTest(TokenTestCase):
    def setUp(self):
        super().setUp()
        aws = ({"AWS_ACCESS_KEY_ID": "AKIA"}, time.time() + 3600)
        patcher = mock.patch.object(isb_mcp, "identity_pool_credentials", return_value=aws)
        patcher.start()
        self.addCleanup(patcher.stop)
        quiet = mock.patch.object(isb_mcp, "log")
        quiet.start()
        self.addCleanup(quiet.stop)
        self.session = isb_mcp.SessionCredentials(self.dep, self.store)

    def test_reuses_credentials_while_they_are_valid(self):
        self.session.current()
        self.session.current()
        self.assertEqual(len(self.cognito.used), 1)

    def test_renews_shortly_before_expiry(self):
        self.cognito.id_token_ttl = isb_mcp.REFRESH_MARGIN_SECONDS - 60
        self.session.current()
        self.session.current()
        self.assertEqual(len(self.cognito.used), 2)

    def test_expired_sign_in_mid_session_says_to_restart(self):
        self.cognito.mode = "invalid_grant"
        with self.assertRaisesRegex(isb_mcp.IsbMcpError, "Restart this MCP server"):
            self.session.current()


# --------------------------------------------------------------------------- #
# Proxy setup
# --------------------------------------------------------------------------- #


class FakeSession:
    """Returns a new ID token and AWS credentials on every call."""

    def __init__(self) -> None:
        self.calls = 0

    def current(self) -> tuple[str, dict]:
        self.calls += 1
        return f"id-token-{self.calls}", {
            "AWS_ACCESS_KEY_ID": f"AKIA{self.calls}",
            "AWS_SECRET_ACCESS_KEY": "secret",
            "AWS_SESSION_TOKEN": "session",
        }


def fake_proxy_modules(events: list, *, with_client_factory: bool = True) -> dict:
    """Stands in for mcp_proxy_for_aws, with the same request-hook model as httpx."""

    class FakeClient:
        def __init__(self) -> None:
            async def sign(request) -> None:
                events.append(
                    {
                        "headers": dict(request.headers),
                        "access_key": os.environ.get("AWS_ACCESS_KEY_ID"),
                        "profile": os.environ.get("AWS_PROFILE"),
                    }
                )

            self.event_hooks = {"request": [sign], "response": []}

    utils = types.ModuleType("mcp_proxy_for_aws.utils")
    if with_client_factory:
        utils.create_sigv4_client = lambda *args, **kwargs: FakeClient()

    async def run_proxy(args) -> None:
        # The real transport looks the factory up by module-level name, per client.
        client = utils.create_sigv4_client()
        for _ in range(2):
            request = types.SimpleNamespace(headers={})
            for hook in client.event_hooks["request"]:
                await hook(request)

    cli = types.ModuleType("mcp_proxy_for_aws.cli")
    cli.parse_args = lambda: (
        events.append({"argv": list(sys.argv)}),
        types.SimpleNamespace(log_level="INFO"),
    )[1]
    logging_config = types.ModuleType("mcp_proxy_for_aws.logging_config")
    logging_config.configure_logging = lambda level: None
    server = types.ModuleType("mcp_proxy_for_aws.server")
    server.run_proxy = run_proxy
    package = types.ModuleType("mcp_proxy_for_aws")
    package.utils, package.cli, package.logging_config, package.server = (
        utils,
        cli,
        logging_config,
        server,
    )
    return {
        "mcp_proxy_for_aws": package,
        "mcp_proxy_for_aws.utils": utils,
        "mcp_proxy_for_aws.cli": cli,
        "mcp_proxy_for_aws.logging_config": logging_config,
        "mcp_proxy_for_aws.server": server,
    }


class ProxySetupTest(unittest.TestCase):
    dep = types.SimpleNamespace(region="us-east-1", gateway_url="https://gateway.example/mcp")

    def run_proxy(self, **fake_options) -> list:
        events: list = []
        with (
            mock.patch.dict(sys.modules, fake_proxy_modules(events, **fake_options)),
            mock.patch.dict(os.environ, {"AWS_PROFILE": "dev", "AWS_DEFAULT_PROFILE": "dev"}),
            mock.patch.object(sys, "argv", ["isb_mcp.py", "serve"]),
        ):
            isb_mcp.run_proxy_in_process(self.dep, FakeSession())
        return events

    def test_each_request_is_signed_with_a_current_identity(self):
        requests = [e for e in self.run_proxy() if "headers" in e]
        self.assertEqual(len(requests), 2)
        for n, request in enumerate(requests, start=2):  # call 1 is the fail-fast check
            # The identity hook ran before the signer: the header is in place and the
            # environment holds the matching credentials when the request is signed.
            self.assertEqual(request["headers"]["x-isb-identity"], f"id-token-{n}")
            self.assertEqual(request["access_key"], f"AKIA{n}")
            self.assertIsNone(request["profile"])

    def test_passes_the_gateway_without_the_token_in_argv(self):
        (argv,) = [e["argv"] for e in self.run_proxy() if "argv" in e]
        self.assertEqual(
            argv,
            [
                "mcp-proxy-for-aws",
                "https://gateway.example/mcp",
                "--service",
                "bedrock-agentcore",
                "--region",
                "us-east-1",
            ],
        )
        self.assertFalse(any("id-token" in arg for arg in argv))

    def test_fails_clearly_if_the_proxy_internal_moves(self):
        with self.assertRaisesRegex(isb_mcp.IsbMcpError, "create_sigv4_client"):
            self.run_proxy(with_client_factory=False)


if __name__ == "__main__":
    unittest.main()
