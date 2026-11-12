"""Atelier tests, on a made-up chapter.

    python -m unittest atelier.tests.test_atelier      (from the repository root)
"""
from __future__ import annotations

import json
import shutil
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer
from pathlib import Path

from atelier import text as tx
from atelier.server import Atelier, make_handler

CHAPTER = (
    "# 3. The station at Saint-Aubin\n\n"
    "The train arrived ten minutes late, which surprised no one.\n\n"
    "*Her again*, thought Lucy when she saw the figure on the platform.\n\n"
    "***\n\n"
    "<!-- TODO: check the time of the last train -->\n\n"
    "She got off first, the suitcase knocking against her knees.\n"
)


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="atelier-test-"))
        folder = self.tmp / "project" / "chapters"
        folder.mkdir(parents=True)
        (folder / "ch03.md").write_bytes(CHAPTER.encode("utf-8"))
        (folder / "ch01.md").write_bytes("# 1. Before\n\nFirst paragraph.\n".encode())
        (folder / "ch-final.md").write_bytes("# End\n\nLast one.\n".encode())
        (folder / "README.md").write_text("not a chapter", encoding="utf-8")
        self.file = folder / "ch03.md"
        self.a = Atelier(self.tmp / "project", "chapters", self.tmp / "state")

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)


class Text(unittest.TestCase):
    def test_round_trip_without_loss(self):
        blocks, eol = tx.read_blocks(CHAPTER)
        self.assertEqual(len(blocks), 6)
        self.assertEqual(tx.write_blocks(blocks, eol), CHAPTER)

    def test_windows_line_endings_kept(self):
        crlf = CHAPTER.replace("\n", "\r\n")
        blocks, eol = tx.read_blocks(crlf)
        self.assertEqual(eol, "\r\n")
        self.assertEqual(tx.write_blocks(blocks, eol), crlf)

    def test_a_block_with_a_blank_line_becomes_two(self):
        self.assertEqual(tx.write_blocks(["one\n\ntwo"]), "one\n\ntwo\n")

    def test_kinds(self):
        blocks, _ = tx.read_blocks(CHAPTER)
        self.assertEqual([tx.kind(b) for b in blocks],
                         ["heading", "paragraph", "paragraph", "separator",
                          "comment", "paragraph"])


class Chapters(Base):
    def test_listed_in_order_without_readme(self):
        ids = [c["id"] for c in self.a.chapters()]
        self.assertEqual(ids, ["ch01", "ch03", "ch-final"])

    def test_style_guide_is_not_a_chapter(self):
        root = self.tmp / "flat"
        root.mkdir()
        (root / "ch01.md").write_text("# One\n\nText.\n", encoding="utf-8")
        (root / "style.md").write_text("Short sentences.\n", encoding="utf-8")
        a = Atelier(root, ".", self.tmp / "state-flat")
        self.assertEqual([c["id"] for c in a.chapters()], ["ch01"])
        with self.assertRaises(KeyError):
            a.path("style")

    def test_annexes_listed_after_and_editable(self):
        sheets = self.tmp / "project" / "notes" / "characters"
        sheets.mkdir(parents=True)
        (sheets / "marion.md").write_bytes("# Marion\n\nShe wants.\n".encode())
        a = Atelier(self.tmp / "project", "chapters", self.tmp / "state",
                    ["notes/characters", "missing"])
        listing = a.chapters()
        self.assertEqual([c["id"] for c in listing], ["ch01", "ch03", "ch-final", "marion"])
        self.assertEqual([c["annex"] for c in listing], [False, False, False, True])
        r = a.read("marion")
        s = a.save("marion", r["blocks"] + ["She is wrong."], r["hash"])
        self.assertFalse(s["conflict"])
        self.assertIn("She is wrong.", (sheets / "marion.md").read_text(encoding="utf-8"))

    def test_path_outside_the_folder_refused(self):
        for bad in ("../ch03", "..\\x", "ch99", ""):
            with self.assertRaises(KeyError):
                self.a.path(bad)

    def test_editing_one_paragraph_leaves_the_others_alone(self):
        r = self.a.read("ch03")
        blocks = list(r["blocks"])
        blocks[1] = "The train finally arrived."
        s = self.a.save("ch03", blocks, r["hash"])
        self.assertFalse(s["conflict"])
        expected = CHAPTER.replace(
            "The train arrived ten minutes late, which surprised no one.",
            "The train finally arrived.")
        self.assertEqual(self.file.read_text(encoding="utf-8"), expected)

    def test_file_changed_elsewhere_not_overwritten(self):
        r = self.a.read("ch03")
        self.file.write_text(CHAPTER + "\nAdded by another editor.\n", encoding="utf-8")
        s = self.a.save("ch03", ["# overwritten"], r["hash"])
        self.assertTrue(s["conflict"])
        self.assertIn("Added by another editor.", self.file.read_text(encoding="utf-8"))

    def test_force_overwrites(self):
        r = self.a.read("ch03")
        self.file.write_text("other\n", encoding="utf-8")
        s = self.a.save("ch03", ["# kept"], r["hash"], force=True)
        self.assertFalse(s["conflict"])
        self.assertEqual(self.file.read_text(encoding="utf-8"), "# kept\n")


class Requests(Base):
    def request(self, **extra):
        d = {"chapter": "ch03", "block": 2, "action": "improve",
             "excerpt": "which surprised no one", "direction": "drier",
             "settings": {"style": False}}
        d.update(extra)
        return self.a.request(d)

    def test_prompt_carries_excerpt_paragraph_direction_and_settings(self):
        self.a.set_direction("ch03", "Lucy is afraid, she does not say it")
        d = self.request()
        p = d["prompt"]
        self.assertTrue(p.startswith("[Atelier] Improve — ch03, block 2"))
        self.assertIn("Target excerpt: “which surprised no one”", p)
        self.assertIn("Direction: drier", p)
        self.assertIn("Chapter direction: Lucy is afraid, she does not say it", p)
        self.assertIn("style guide off · level suggest", p)
        self.assertNotIn("Style guide:", p)
        self.assertIn("The train arrived ten minutes late", p)
        self.assertIn("mcp__atelier__propose", p)

    def test_style_guide_path_given_when_on_and_present(self):
        guide = self.tmp / "project" / "style.md"
        guide.write_text("Short sentences.\n", encoding="utf-8")
        d = self.request(settings={"style": True})
        self.assertIn(f"Style guide: {guide.resolve()}", d["prompt"])

    def test_retry_carries_the_previous_proposal(self):
        d = self.request(action="retry", previous="The train arrived, late.")
        self.assertIn("Proposal to rework: “The train arrived, late.”", d["prompt"])

    def test_continue_gives_more_context(self):
        d = self.request(action="continue", block=6, excerpt="")
        self.assertIn("Her again", d["before"])

    def test_invalid_block_or_action(self):
        with self.assertRaises(ValueError):
            self.request(block=42)
        with self.assertRaises(ValueError):
            self.request(action="erase")

    def test_life_cycle(self):
        d = self.request()
        status = lambda: self.a.requests("ch03")[0]["status"]
        self.assertEqual(status(), "pending")
        (self.a.state / "sent" / d["id"]).write_text("")
        self.assertEqual(status(), "sent")
        prop = {"request": d["id"], "chapter": "ch03", "block": 2, "target": "selection",
                "excerpt": d["excerpt"], "proposals": [{"text": "as expected"}]}
        (self.a.state / "proposals" / "p-1.json").write_text(json.dumps(prop), encoding="utf-8")
        self.assertEqual(status(), "answered")
        props = self.a.proposals("ch03")
        self.assertEqual(props[0]["status"], "new")
        self.a.set_status(props[0]["id"], "applied")
        self.assertEqual(self.a.proposals("ch03")[0]["status"], "applied")

    def test_a_proposal_does_not_modify_the_chapter(self):
        before = self.file.read_bytes()
        d = self.request()
        prop = {"request": d["id"], "chapter": "ch03", "block": 2,
                "proposals": [{"text": "x"}]}
        (self.a.state / "proposals" / "p-2.json").write_text(json.dumps(prop), encoding="utf-8")
        self.a.updates("ch03")
        self.assertEqual(self.file.read_bytes(), before)

    def test_current_gives_numbered_blocks(self):
        c = self.a.set_current({"chapter": "ch03", "block": 3, "selection": "Her again"})
        self.assertEqual(c["blocks"][2]["n"], 3)
        self.assertEqual(c["blocks"][2]["text"][:11], "*Her again*")
        self.assertTrue((self.a.state / "current.json").exists())

    def test_bridge_inactive_without_heartbeat(self):
        self.assertFalse(self.a.bridge()["active"])


class Http(Base):
    def setUp(self):
        super().setUp()
        self.srv = ThreadingHTTPServer(("127.0.0.1", 0), make_handler(self.a))
        threading.Thread(target=self.srv.serve_forever, daemon=True).start()
        self.url = f"http://127.0.0.1:{self.srv.server_address[1]}"

    def tearDown(self):
        self.srv.shutdown()
        self.srv.server_close()
        super().tearDown()

    def get(self, path):
        with urllib.request.urlopen(self.url + path) as r:
            return r.status, r.headers, r.read()

    def test_listens_on_this_machine_only(self):
        self.assertEqual(self.srv.server_address[0], "127.0.0.1")

    def test_the_page_loads_nothing_external(self):
        code, headers, body = self.get("/")
        self.assertEqual(code, 200)
        self.assertIn("default-src 'self'", headers["Content-Security-Policy"])
        self.assertNotIn(b"http://", body.replace(b"http://127.0.0.1", b""))
        self.assertNotIn(b"https://", body)

    def test_api_chapter_and_save(self):
        _, _, body = self.get("/api/chapter?id=ch03")
        r = json.loads(body)
        r["blocks"][1] = "Modified over HTTP."
        req = urllib.request.Request(
            self.url + "/api/chapter", method="POST",
            data=json.dumps({"id": "ch03", "blocks": r["blocks"],
                             "hash": r["hash"]}).encode("utf-8"),
            headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(req) as resp:
            self.assertEqual(resp.status, 200)
        self.assertIn("Modified over HTTP.", self.file.read_text(encoding="utf-8"))

    def status(self, path, body=b"{}", **headers):
        req = urllib.request.Request(self.url + path, method="POST", data=body,
                                     headers={"Content-Type": "application/json", **headers})
        try:
            with urllib.request.urlopen(req) as r:
                return r.status
        except urllib.error.HTTPError as e:
            e.close()
            return e.code

    def test_another_page_in_the_browser_is_refused(self):
        request = json.dumps({"chapter": "ch03", "block": 2, "action": "improve"}).encode()
        self.assertEqual(self.status("/api/request", request, Origin="https://example.net"), 403)
        self.assertEqual(self.status("/api/request", request, **{"Content-Type": "text/plain"}), 415)
        self.assertEqual(self.status("/api/request", request, Host="atelier.example.net"), 403)
        self.assertEqual(list((self.a.state / "requests").glob("*.json")), [])
        self.assertEqual(self.status("/api/request", request,
                                     Origin=self.url.replace("127.0.0.1", "localhost")), 200)

    def test_a_body_that_is_not_an_object(self):
        self.assertEqual(self.status("/api/request", b"[1, 2]"), 400)


if __name__ == "__main__":
    unittest.main()
