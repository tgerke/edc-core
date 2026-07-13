# edc-core Python engine
#
# Executes workbench Python scripts against read-only, version-pinned
# DuckLake snapshots. Stateless: every request runs in a fresh Python
# subprocess with the same containment as the SQL workbench; script
# storage, versioning, and audit live in the API (E6-04). Same execution
# contract as services/r-engine: attach payload in, {ok, stdout,
# resultColumns, resultJson} out.
#
# Stdlib HTTP server on purpose: two internal endpoints don't justify a
# web framework, and the runtime dependencies stay at duckdb + pandas.

import json
import os
import signal
import subprocess
import sys
import tempfile
import time
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import duckdb

REQUIRED = ("script", "catalogUri", "dataPath", "metadataSchema", "version", "tables")
RUNNER = os.path.join(os.path.dirname(os.path.abspath(__file__)), "runner.py")


def execute(payload):
    timeout_s = payload.get("timeoutMs", 60000) / 1000
    started = time.monotonic()
    # The runner writes its result to a file, not stdout: user code that
    # writes to the real fd 1 (bypassing the redirected sys.stdout) must
    # not be able to corrupt the result channel.
    with tempfile.NamedTemporaryFile(suffix=".json") as result_file:
        # start_new_session so a timeout can SIGKILL the whole process
        # group: anything user code spawned inherits the stderr pipe, and a
        # surviving orphan would keep communicate() blocked past the timeout.
        proc = subprocess.Popen(
            [sys.executable, RUNNER, result_file.name],
            stdin=subprocess.PIPE,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
            start_new_session=True,
        )
        try:
            _, stderr = proc.communicate(json.dumps(payload).encode(), timeout=timeout_s)
        except subprocess.TimeoutExpired:
            os.killpg(proc.pid, signal.SIGKILL)
            proc.wait()
            return {
                "ok": False,
                "stdout": "",
                "error": "execution cancelled after %gs" % timeout_s,
                "elapsedMs": round((time.monotonic() - started) * 1000),
            }
        raw = result_file.read()
    if raw:
        out = json.loads(raw)
    else:
        detail = stderr.decode(errors="replace").strip()
        out = {
            "ok": False,
            "stdout": "",
            "error": "runner produced no result" + (": " + detail if detail else ""),
        }
    out["elapsedMs"] = round((time.monotonic() - started) * 1000)
    return out


class Handler(BaseHTTPRequestHandler):
    def _send(self, status, body):
        data = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path != "/health":
            return self._send(404, {"error": "not found"})
        self._send(
            200,
            {
                "status": "ok",
                "service": "edc-core-py-engine",
                "python_version": "%d.%d.%d" % sys.version_info[:3],
                "duckdb_version": duckdb.__version__,
                "time": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z",
            },
        )

    def do_POST(self):
        if self.path != "/execute":
            return self._send(404, {"error": "not found"})
        try:
            length = int(self.headers.get("content-length", 0))
            payload = json.loads(self.rfile.read(length))
        except ValueError:
            payload = None
        if not isinstance(payload, dict) or not all(k in payload for k in REQUIRED):
            return self._send(400, {"ok": False, "error": "invalid payload", "stdout": ""})
        self._send(200, execute(payload))


if __name__ == "__main__":
    ThreadingHTTPServer(("0.0.0.0", 8000), Handler).serve_forever()
