#!/usr/bin/env python3
import json
import subprocess
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


LISTEN_HOST = "0.0.0.0"
LISTEN_PORT = 18555


class QuiesceState:
    def __init__(self) -> None:
        self.lock = threading.RLock()
        self.frozen = False
        self.generation = 0
        self.deadline = 0.0

    def freeze(self, ttl_seconds: int) -> dict[str, object]:
        ttl_seconds = max(30, ttl_seconds)
        with self.lock:
            if self.frozen:
                return {
                    "status": "already_frozen",
                    "ttlSeconds": max(0, int(self.deadline - time.monotonic())),
                }
            subprocess.run(["sync"], check=True)
            subprocess.run(["fsfreeze", "-f", "/"], check=True)
            self.frozen = True
            self.generation += 1
            generation = self.generation
            self.deadline = time.monotonic() + ttl_seconds
            thread = threading.Thread(
                target=self._auto_thaw,
                args=(generation, ttl_seconds),
                daemon=True,
            )
            thread.start()
            return {"status": "frozen", "ttlSeconds": ttl_seconds}

    def thaw(self) -> dict[str, object]:
        with self.lock:
            if not self.frozen:
                return {"status": "idle"}
            subprocess.run(["fsfreeze", "-u", "/"], check=True)
            self.frozen = False
            self.generation += 1
            self.deadline = 0.0
            return {"status": "thawed"}

    def _auto_thaw(self, generation: int, ttl_seconds: int) -> None:
        time.sleep(ttl_seconds)
        with self.lock:
            if not self.frozen or self.generation != generation:
                return
            try:
                subprocess.run(["fsfreeze", "-u", "/"], check=True)
            finally:
                self.frozen = False
                self.generation += 1
                self.deadline = 0.0


STATE = QuiesceState()


class Handler(BaseHTTPRequestHandler):
    server_version = "gw-warm-quiesce-helper/1"

    def do_GET(self) -> None:
        if self.path != "/health":
            self._send_json(404, {"error": "not_found"})
            return
        with STATE.lock:
            payload = {
                "status": "frozen" if STATE.frozen else "idle",
                "ttlSeconds": max(0, int(STATE.deadline - time.monotonic())) if STATE.frozen else 0,
            }
        self._send_json(200, payload)

    def do_POST(self) -> None:
        try:
            length = int(self.headers.get("content-length", "0"))
        except ValueError:
            length = 0
        raw = self.rfile.read(length) if length > 0 else b"{}"
        try:
            payload = json.loads(raw.decode("utf-8") or "{}")
        except json.JSONDecodeError:
            self._send_json(400, {"error": "invalid_json"})
            return

        try:
            if self.path == "/freeze":
                ttl_seconds = int(payload.get("ttlSeconds", 180))
                result = STATE.freeze(ttl_seconds)
                self._send_json(200, result)
                return
            if self.path == "/thaw":
                result = STATE.thaw()
                self._send_json(200, result)
                return
        except subprocess.CalledProcessError as error:
            self._send_json(
                500,
                {
                    "error": "command_failed",
                    "command": error.cmd,
                    "returncode": error.returncode,
                },
            )
            return

        self._send_json(404, {"error": "not_found"})

    def log_message(self, format: str, *args: object) -> None:
        return

    def _send_json(self, status_code: int, payload: dict[str, object]) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status_code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def main() -> None:
    server = ThreadingHTTPServer((LISTEN_HOST, LISTEN_PORT), Handler)
    server.serve_forever()


if __name__ == "__main__":
    main()
