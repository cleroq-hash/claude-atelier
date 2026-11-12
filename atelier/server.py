"""Atelier — the local server.

Serves the Atelier page, reads and writes the manuscript's chapters, and keeps the
queue of requests made to Claude and of the proposals it returns. Listens on
127.0.0.1 only: nothing leaves the machine.

    python -m atelier.server --root path/to/my-novel

The state (requests, proposals, directions) lives outside the manuscript, in
`~/.atelier/<root folder name>/`: it contains excerpts of the text. The file
`~/.atelier/active.json` tells the mod where to find it.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import secrets
import sys
import threading
import time
from datetime import datetime
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from . import text as tx

PAGE = Path(__file__).parent / "page"
PORT = 7340
BRIDGE_ALIVE_S = 15
TYPES = {".html": "text/html", ".js": "text/javascript", ".css": "text/css",
         ".svg": "image/svg+xml"}
_CHAPTER_ID = re.compile(r"^[\w.-]+$")


def now() -> str:
    return datetime.now().isoformat(timespec="seconds")


def _write_atomic(path: Path, content: str) -> None:
    tmp = path.with_name(path.name + ".tmp-atelier")
    with open(tmp, "w", encoding="utf-8", newline="") as f:
        f.write(content)
    os.replace(tmp, path)


def _read_json(path: Path, default):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError):
        return default


def _write_json(path: Path, value) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    _write_atomic(path, json.dumps(value, ensure_ascii=False, indent=1))


def _chapter_key(p: Path):
    m = re.match(r"ch(\d+)(.*)$", p.stem)
    return (0, int(m.group(1)), m.group(2)) if m else (1, 0, p.stem)


class Atelier:
    """What the server can do, without HTTP: this is what the tests exercise."""

    def __init__(self, root: Path, manuscript: str, state: Path, annexes=(),
                 style: str = "style.md"):
        self.root = root.resolve()
        self.folder = (self.root / manuscript).resolve()
        # Annexes: folders read and written like chapters (character sheets, notes...),
        # listed after them, but which are not the manuscript itself.
        self.annexes = [d for d in ((self.root / a).resolve() for a in annexes)
                        if d.is_dir() and d != self.folder]
        # The style guide: a Markdown file Claude reads before proposing, if it exists.
        self.style_guide = (self.root / style).resolve()
        self.state = state.resolve()
        for sub in ("requests", "sent", "proposals"):
            (self.state / sub).mkdir(parents=True, exist_ok=True)
        self.lock = threading.Lock()

    # ---- chapters

    def chapters(self) -> list[dict]:
        out, seen = [], set()
        for folder in [self.folder, *self.annexes]:
            annex = folder != self.folder
            for p in sorted(folder.glob("*.md"), key=_chapter_key):
                # README.md, NOTES.md: not chapters; nor is the style guide.
                if p.stem.isupper() or p.stem in seen or p.resolve() == self.style_guide:
                    continue
                seen.add(p.stem)
                blocks, _ = tx.read_blocks(p.read_text(encoding="utf-8"))
                out.append({"id": p.stem, "file": p.name, "title": tx.title(blocks),
                            "words": tx.count_words(blocks), "annex": annex})
        return out

    def path(self, id_: str) -> Path:
        if not _CHAPTER_ID.match(id_ or ""):
            raise KeyError(id_)
        for folder in [self.folder, *self.annexes]:
            p = (folder / f"{id_}.md").resolve()
            if p.parent == folder and p.is_file() and p != self.style_guide:
                return p
        raise KeyError(id_)

    def read(self, id_: str) -> dict:
        p = self.path(id_)
        raw = p.read_bytes()
        blocks, eol = tx.read_blocks(raw.decode("utf-8"))
        return {"id": id_, "file": str(p), "blocks": blocks,
                "kinds": [tx.kind(b) for b in blocks],
                "hash": hashlib.sha1(raw).hexdigest(), "eol": eol,
                "words": tx.count_words(blocks)}

    def hash(self, id_: str) -> str:
        return hashlib.sha1(self.path(id_).read_bytes()).hexdigest()

    def save(self, id_: str, blocks: list[str], base: str | None,
             force: bool = False) -> dict:
        """Write the chapter, unless the file changed on disk since `base`."""
        with self.lock:
            p = self.path(id_)
            current = p.read_bytes()
            h = hashlib.sha1(current).hexdigest()
            if not force and base and base != h:
                return {"conflict": True, "hash": h}
            _, eol = tx.read_blocks(current.decode("utf-8"))
            content = tx.write_blocks(blocks, eol)
            if content.encode("utf-8") != current:
                _write_atomic(p, content)
            new = self.read(id_)
            return {"conflict": False, "hash": new["hash"],
                    "blocks": new["blocks"], "words": new["words"]}

    # ---- directions and current position

    def directions(self) -> dict:
        return _read_json(self.state / "directions.json", {})

    def set_direction(self, chapter: str, direction: str) -> None:
        with self.lock:
            directions = self.directions()
            directions[chapter] = direction
            _write_json(self.state / "directions.json", directions)

    def _style_guide_path(self) -> str:
        return str(self.style_guide) if self.style_guide.is_file() else ""

    def set_current(self, d: dict) -> dict:
        """Where the writer is: what the `state` tool returns to Claude."""
        r = self.read(d["chapter"])
        current = {
            "updated": now(), "root": str(self.root),
            "style_guide": self._style_guide_path(),
            "chapter": d["chapter"], "file": r["file"],
            "block": d.get("block"), "selection": d.get("selection") or "",
            "settings": {**tx.DEFAULT_SETTINGS, **(d.get("settings") or {})},
            "chapter_direction": self.directions().get(d["chapter"], ""),
            "blocks": [{"n": i + 1, "kind": k, "text": b}
                       for i, (b, k) in enumerate(zip(r["blocks"], r["kinds"]))],
            "proposals_dir": str(self.state / "proposals"),
        }
        _write_json(self.state / "current.json", current)
        return current

    # ---- the bridge

    def bridge(self) -> dict:
        p = _read_json(self.state / "bridge.json", {})
        seen = p.get("seen", 0) / 1000
        return {"active": bool(seen) and time.time() - seen < BRIDGE_ALIVE_S,
                "seen": p.get("seen")}

    def request(self, d: dict) -> dict:
        """A request from the page: it goes into the queue, the mod sends it on."""
        r = self.read(d["chapter"])
        n = int(d["block"])
        if not 1 <= n <= len(r["blocks"]):
            raise ValueError("block outside the chapter")
        if d.get("action") not in tx.ACTIONS:
            raise ValueError("unknown action")
        id_ = datetime.now().strftime("d-%m%d-%H%M%S-") + secrets.token_hex(2)
        paragraph = d.get("paragraph") or r["blocks"][n - 1]
        ctx = 3 if d["action"] == "continue" else 1
        req = {
            "id": id_, "created": now(), "chapter": d["chapter"], "block": n,
            "action": d["action"], "direction": (d.get("direction") or "").strip(),
            "chapter_direction": self.directions().get(d["chapter"], ""),
            "settings": {**tx.DEFAULT_SETTINGS, **(d.get("settings") or {})},
            "style_guide": self._style_guide_path(),
            "excerpt": (d.get("excerpt") or "").strip(), "paragraph": paragraph,
            "previous": (d.get("previous") or "").strip(),
            "before": "\n\n".join(r["blocks"][max(0, n - 1 - ctx):n - 1]),
            "after": "\n\n".join(r["blocks"][n:n + 1]),
            "file": r["file"],
            "reply_path": str(self.state / "proposals" / f"p-{id_[2:]}.json"),
        }
        req["prompt"] = tx.prompt(req)
        _write_json(self.state / "requests" / f"{id_}.json", req)
        return req

    def requests(self, chapter: str) -> list[dict]:
        answered = {p.get("request") for p in self._raw_proposals()}
        statuses = _read_json(self.state / "statuses.json", {})
        out = []
        for f in sorted((self.state / "requests").glob("d-*.json")):
            d = _read_json(f, None)
            if not d or d.get("chapter") != chapter:
                continue
            if statuses.get(d["id"], {}).get("status") == "dismissed":  # withdrawn by the writer
                continue
            status = ("answered" if d["id"] in answered else
                      "sent" if (self.state / "sent" / d["id"]).exists() else
                      "pending")
            out.append({k: d.get(k) for k in
                        ("id", "created", "block", "action", "excerpt", "direction", "prompt")}
                       | {"status": status})
        return out

    # ---- Claude's proposals

    def _raw_proposals(self) -> list[dict]:
        out = []
        for f in sorted((self.state / "proposals").glob("*.json")):
            p = _read_json(f, None)
            if isinstance(p, dict):
                p.setdefault("id", f.stem)
                out.append(p)
        return out

    def proposals(self, chapter: str) -> list[dict]:
        statuses = _read_json(self.state / "statuses.json", {})
        out = []
        for p in self._raw_proposals():
            if p.get("chapter") != chapter:
                continue
            p["status"] = statuses.get(p["id"], {}).get("status", "new")
            out.append(p)
        return out

    def set_status(self, id_: str, status: str) -> None:
        if status not in ("new", "applied", "dismissed"):
            raise ValueError("unknown status")
        with self.lock:
            statuses = _read_json(self.state / "statuses.json", {})
            statuses[id_] = {"status": status, "when": now()}
            _write_json(self.state / "statuses.json", statuses)

    def updates(self, chapter: str) -> dict:
        return {"bridge": self.bridge(), "hash": self.hash(chapter),
                "requests": self.requests(chapter),
                "proposals": self.proposals(chapter)}


def make_handler(atelier: Atelier):
    class Handler(BaseHTTPRequestHandler):
        server_version = "Atelier/1"

        def log_message(self, fmt, *args):  # keep the terminal readable
            pass

        def _json(self, value, code=HTTPStatus.OK):
            body = json.dumps(value, ensure_ascii=False).encode("utf-8")
            self.send_response(code)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)

        def _body(self) -> dict:
            n = int(self.headers.get("Content-Length") or 0)
            d = json.loads(self.rfile.read(n).decode("utf-8") or "{}")
            if not isinstance(d, dict):
                raise ValueError("JSON body expected: an object")
            return d

        def _from_page(self, method: str) -> HTTPStatus | None:
            """Refuse anything that does not come from the Atelier page. Without this,
            a web page open elsewhere in the browser could post a request that the mod
            would submit to Claude as if the writer had typed it (or read the
            manuscript through DNS rebinding)."""
            port = self.server.server_address[1]
            hosts = {f"127.0.0.1:{port}", f"localhost:{port}"}
            if self.headers.get("Host") not in hosts:
                return HTTPStatus.FORBIDDEN
            origin = self.headers.get("Origin")
            if origin and origin not in {f"http://{h}" for h in hosts}:
                return HTTPStatus.FORBIDDEN
            if method == "POST" and not (self.headers.get("Content-Type") or "").startswith("application/json"):
                return HTTPStatus.UNSUPPORTED_MEDIA_TYPE  # forces the browser's CORS preflight
            return None

        def _page(self, name: str):
            f = (PAGE / name).resolve()
            if f.parent != PAGE.resolve() or not f.is_file():
                return self._json({"error": "not found"}, HTTPStatus.NOT_FOUND)
            body = f.read_bytes()
            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type",
                             TYPES.get(f.suffix, "application/octet-stream") + "; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            # Nothing external: the page only loads what this server gives it.
            self.send_header("Content-Security-Policy",
                             "default-src 'self'; style-src 'self' 'unsafe-inline'; "
                             "img-src 'self' data:; connect-src 'self'")
            self.end_headers()
            self.wfile.write(body)

        def _route(self, method: str):
            url = urlparse(self.path)
            q = {k: v[0] for k, v in parse_qs(url.query).items()}
            route = url.path
            refusal = self._from_page(method)
            if refusal:
                return self._json({"error": "request refused: it does not come from the Atelier page"}, refusal)
            try:
                if method == "GET":
                    if route in ("/", "/index.html"):
                        return self._page("index.html")
                    if route.startswith("/page/"):
                        return self._page(route[len("/page/"):])
                    if route == "/api/chapters":
                        return self._json({"chapters": atelier.chapters(),
                                           "directions": atelier.directions(),
                                           "root": str(atelier.root)})
                    if route == "/api/chapter":
                        return self._json(atelier.read(q["id"]))
                    if route == "/api/updates":
                        return self._json(atelier.updates(q["chapter"]))
                else:
                    d = self._body()
                    if route == "/api/chapter":
                        r = atelier.save(d["id"], d["blocks"], d.get("hash"),
                                         bool(d.get("force")))
                        return self._json(r, HTTPStatus.CONFLICT if r["conflict"] else HTTPStatus.OK)
                    if route == "/api/request":
                        return self._json(atelier.request(d))
                    if route == "/api/status":
                        atelier.set_status(d["id"], d["status"])
                        return self._json({"ok": True})
                    if route == "/api/direction":
                        atelier.set_direction(d["chapter"], d.get("direction", ""))
                        return self._json({"ok": True})
                    if route == "/api/current":
                        atelier.set_current(d)
                        return self._json({"ok": True})
                return self._json({"error": "unknown route"}, HTTPStatus.NOT_FOUND)
            except KeyError as e:
                return self._json({"error": f"not found: {e}"}, HTTPStatus.NOT_FOUND)
            except (ValueError, TypeError) as e:
                return self._json({"error": str(e)}, HTTPStatus.BAD_REQUEST)

        def do_GET(self):
            self._route("GET")

        def do_POST(self):
            self._route("POST")

    return Handler


POINTER = Path.home() / ".atelier" / "active.json"
HEARTBEAT_S = 10


def write_pointer(atelier: Atelier, port: int, started: str) -> None:
    """`~/.atelier/active.json`: where the state is, and proof that the server is alive
    (`seen`, in milliseconds) — the mod goes quiet when it gets old."""
    _write_json(POINTER, {"state": str(atelier.state), "root": str(atelier.root),
                          "url": f"http://127.0.0.1:{port}/", "pid": os.getpid(),
                          "started": started, "seen": int(time.time() * 1000)})


def heartbeat(atelier: Atelier, port: int, stop: threading.Event) -> None:
    started = now()
    while not stop.is_set():
        try:
            write_pointer(atelier, port, started)
        except OSError:
            pass
        stop.wait(HEARTBEAT_S)


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--root", default=".",
                    help="the folder of the text (default: the current folder)")
    ap.add_argument("--manuscript", default=".",
                    help="the folder of the chapters, relative to the root (default: .)")
    ap.add_argument("--style", default="style.md",
                    help="the style guide, relative to the root (default: style.md); "
                         "Claude reads it before proposing, if it exists")
    ap.add_argument("--annex", action="append", default=[], metavar="FOLDER",
                    help="an extra folder of .md files, edited like chapters and listed "
                         "after them (repeatable; relative to the root)")
    ap.add_argument("--state", help="where to keep requests and proposals "
                                    "(default: ~/.atelier/<root folder name>)")
    ap.add_argument("--port", type=int, default=PORT)
    a = ap.parse_args(argv)
    root = Path(a.root).expanduser().resolve()
    state = Path(a.state).expanduser() if a.state else Path.home() / ".atelier" / root.name
    atelier = Atelier(root, a.manuscript, state, a.annex, a.style)
    if not atelier.folder.is_dir():
        print(f"no chapter folder: {atelier.folder}", file=sys.stderr)
        return 2
    server = ThreadingHTTPServer(("127.0.0.1", a.port), make_handler(atelier))
    stop = threading.Event()
    threading.Thread(target=heartbeat, args=(atelier, a.port, stop), daemon=True).start()
    print(f"Atelier: http://127.0.0.1:{a.port}/  ({atelier.folder})", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        stop.set()
    return 0


if __name__ == "__main__":
    sys.exit(main())
