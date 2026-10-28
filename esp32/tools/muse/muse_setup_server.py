#!/usr/bin/env python3
"""
Local HTTP Server & CORS Proxy for Meta Muse ESP32 Gadget Full Setup.

Serves `muse_full_setup.html` on http://localhost:8099 and proxies token-minting,
token-refresh, and VM discovery requests to `https://api.muse.ai` (which does not
include browser CORS headers).
"""

from __future__ import annotations

import argparse
import json
import os
import ssl
import sys
import urllib.error
import urllib.request
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

UPSTREAM_API_BASE = "https://api.muse.ai"
API_VERSION = "1.0.0"
DEFAULT_PORT = 8099
HERE = Path(__file__).resolve().parent


def _upstream_request(
    method: str,
    path: str,
    bearer_token: str,
    body_obj: dict[str, Any] | None = None,
    timeout: float = 20.0,
) -> tuple[int, dict[str, Any]]:
    url = f"{UPSTREAM_API_BASE}{path}"
    headers = {
        "Authorization": f"Bearer {bearer_token.strip()}",
        "X-API-Version": API_VERSION,
        "Accept": "application/json",
        "User-Agent": "muse-esp32-provisioner/1.0",
    }
    data_bytes = None
    if body_obj is not None:
        headers["Content-Type"] = "application/json"
        data_bytes = json.dumps(body_obj).encode("utf-8")

    req = urllib.request.Request(url, data=data_bytes, headers=headers, method=method)
    ctx = ssl.create_default_context()

    try:
        with urllib.request.urlopen(req, context=ctx, timeout=timeout) as resp:
            raw = resp.read().decode("utf-8", errors="replace")
            status = resp.status
            try:
                parsed = json.loads(raw) if raw else {}
            except json.JSONDecodeError:
                parsed = {"raw": raw}
            return status, parsed
    except urllib.error.HTTPError as err:
        raw = err.read().decode("utf-8", errors="replace") if err.fp else ""
        try:
            parsed = json.loads(raw) if raw else {}
        except json.JSONDecodeError:
            parsed = {"error": raw or err.reason}
        return err.code, parsed
    except Exception as exc:
        return 502, {"error": f"Upstream request to {url} failed: {exc}"}


class MuseSetupHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args: Any, **kwargs: Any) -> None:
        super().__init__(*args, directory=str(HERE), **kwargs)

    def end_headers(self) -> None:
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization")
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def do_OPTIONS(self) -> None:
        self.send_response(HTTPStatus.NO_CONTENT)
        self.end_headers()

    def do_GET(self) -> None:
        if self.path in ("/", "/index.html"):
            self.path = "/muse_full_setup.html"
            return super().do_GET()

        if self.path == "/api/health":
            self._send_json(
                HTTPStatus.OK,
                {
                    "ok": True,
                    "upstream": UPSTREAM_API_BASE,
                    "api_version": API_VERSION,
                },
            )
            return

        return super().do_GET()

    def do_POST(self) -> None:
        try:
            length = int(self.headers.get("Content-Length", "0"))
            raw_body = self.rfile.read(length).decode("utf-8") if length > 0 else "{}"
            payload = json.loads(raw_body) if raw_body.strip() else {}
        except Exception as exc:
            self._send_json(HTTPStatus.BAD_REQUEST, {"error": f"Invalid JSON body: {exc}"})
            return

        if self.path == "/api/mint":
            web_token = str(payload.get("web_token") or "").strip()
            device_id = str(payload.get("device_id") or "").strip()
            sdk_token = str(payload.get("sdk_token") or "").strip()

            if not web_token:
                self._send_json(HTTPStatus.BAD_REQUEST, {"error": "Missing web_token"})
                return
            if not device_id:
                self._send_json(
                    HTTPStatus.BAD_REQUEST,
                    {"error": "Missing device_id (expected homelink-xxxxxx)"},
                )
                return

            mint_body: dict[str, Any] = {"device_id": device_id}
            if sdk_token:
                mint_body["sdk_token"] = sdk_token

            print(
                f"[Proxy] POST {UPSTREAM_API_BASE}/device_token/mint "
                f"(device_id={device_id}, sdk_token={'set' if sdk_token else 'none'})",
                flush=True,
            )
            status, resp_data = _upstream_request(
                "POST", "/device_token/mint", web_token, mint_body
            )
            self._send_json(status, resp_data)
            return

        if self.path == "/api/refresh":
            refresh_token = str(payload.get("refresh_token") or "").strip()
            device_id = str(payload.get("device_id") or "").strip()
            sdk_token = str(payload.get("sdk_token") or "").strip()

            if not refresh_token or not device_id:
                self._send_json(
                    HTTPStatus.BAD_REQUEST,
                    {"error": "Missing refresh_token or device_id"},
                )
                return

            refresh_body: dict[str, Any] = {"device_id": device_id}
            if sdk_token:
                refresh_body["sdk_token"] = sdk_token

            print(
                f"[Proxy] POST {UPSTREAM_API_BASE}/device_token/refresh (device_id={device_id})",
                flush=True,
            )
            status, resp_data = _upstream_request(
                "POST", "/device_token/refresh", refresh_token, refresh_body
            )
            self._send_json(status, resp_data)
            return

        if self.path == "/api/fetch_vms":
            access_token = str(payload.get("access_token") or "").strip()
            if not access_token:
                self._send_json(HTTPStatus.BAD_REQUEST, {"error": "Missing access_token"})
                return

            print(f"[Proxy] GET {UPSTREAM_API_BASE}/fetch_vms", flush=True)
            status, resp_data = _upstream_request("GET", "/fetch_vms", access_token, None)
            self._send_json(status, resp_data)
            return

        self._send_json(HTTPStatus.NOT_FOUND, {"error": f"Unknown endpoint: {self.path}"})

    def _send_json(self, status: int, data: dict[str, Any]) -> None:
        raw = json.dumps(data).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Meta Muse ESP32 Full Web Bluetooth Provisioner Server"
    )
    parser.add_argument("--host", default="127.0.0.1", help="Bind host (default: 127.0.0.1)")
    parser.add_argument(
        "--port", type=int, default=DEFAULT_PORT, help=f"Bind port (default: {DEFAULT_PORT})"
    )
    args = parser.parse_args()

    os.chdir(HERE)
    server = ThreadingHTTPServer((args.host, args.port), MuseSetupHandler)
    url = f"http://localhost:{args.port}"
    print(f"============================================================", flush=True)
    print(f" Meta Muse ESP32 Full Setup Server running at: {url}", flush=True)
    print(f" Serving directory: {HERE}", flush=True)
    print(f" Upstream CORS Proxy: {UPSTREAM_API_BASE} (X-API-Version: {API_VERSION})", flush=True)
    print(f"============================================================", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down server...", flush=True)
        server.server_close()
        sys.exit(0)


if __name__ == "__main__":
    main()
