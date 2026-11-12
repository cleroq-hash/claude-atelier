"""The manuscript seen as a list of blocks, and the request sent to Claude.

A chapter is a Markdown file: one paragraph per line, a blank line between two
paragraphs. A block is whatever sits between two blank lines: a paragraph, a
`# ...` heading, a `***` separator, an `<!-- ... -->` comment. Blocks are numbered
from 1, as the page shows them: that is the number Claude and the writer share.
"""
from __future__ import annotations

import re

_BLANK_LINE = re.compile(r"\n[ \t]*\n")
_WORD = re.compile(r"[^\W\d_]+(?:[’'-][^\W\d_]+)*", re.UNICODE)


def read_blocks(text: str) -> tuple[list[str], str]:
    """Split a chapter into blocks; also return the file's line ending."""
    eol = "\r\n" if "\r\n" in text else "\n"
    raw = text.replace("\r\n", "\n")
    blocks = [b.strip("\n") for b in _BLANK_LINE.split(raw)]
    return [b for b in blocks if b.strip()], eol


def write_blocks(blocks: list[str], eol: str = "\n") -> str:
    """The inverse of `read_blocks`. A block containing a blank line becomes two."""
    joined = "\n\n".join(b.replace("\r\n", "\n") for b in blocks)
    clean, _ = read_blocks(joined)
    if not clean:
        return ""
    return ("\n\n".join(clean) + "\n").replace("\n", eol)


def kind(block: str) -> str:
    """heading, separator, comment or paragraph."""
    b = block.strip()
    if b.startswith("# ") or b.startswith("## "):
        return "heading"
    if b in ("***", "* * *", "---"):
        return "separator"
    if b.startswith("<!--") and b.endswith("-->"):
        return "comment"
    return "paragraph"


def title(blocks: list[str]) -> str | None:
    for b in blocks:
        if kind(b) == "heading":
            return b.lstrip("#").strip()
    return None


def count_words(blocks: list[str]) -> int:
    return sum(len(_WORD.findall(b)) for b in blocks if kind(b) != "comment")


# ---- the request sent to Claude

ACTIONS = {
    "improve": "Improve",
    "variants": "Variants",
    "continue": "Continue",
    "ask": "Free question",
    "retry": "Retry",
}
LEVELS = {"light": "light", "suggest": "suggest", "cowrite": "co-write"}
DEFAULT_SETTINGS = {"style": True, "level": "suggest"}


def _truncate(text: str, n: int = 700) -> str:
    text = " ".join(text.split())
    return text if len(text) <= n else text[: n - 1].rstrip() + "…"


def _on(v: bool) -> str:
    return "on" if v else "off"


def prompt(d: dict) -> str:
    """The message sent into the conversation: it stands on its own."""
    s = {**DEFAULT_SETTINGS, **(d.get("settings") or {})}
    lines = [
        f"[Atelier] {ACTIONS.get(d['action'], d['action'])} — "
        f"{d['chapter']}, block {d['block']} · request {d['id']}"
    ]
    if d.get("direction"):
        lines.append(f"Direction: {d['direction'].strip()}")
    if d.get("chapter_direction"):
        lines.append(f"Chapter direction: {d['chapter_direction'].strip()}")
    lines.append(
        f"Settings: style guide {_on(s['style'])} · level "
        f"{LEVELS.get(s['level'], s['level'])}"
    )
    if s["style"] and d.get("style_guide"):
        lines.append(f"Style guide: {d['style_guide']}")
    if d.get("excerpt"):
        lines.append(f"Target excerpt: “{d['excerpt'].strip()}”")
    lines.append(f"Paragraph: “{d['paragraph'].strip()}”")
    if d.get("previous"):
        lines.append(f"Proposal to rework: “{d['previous'].strip()}”")
    for name, key in (("Before", "before"), ("After", "after")):
        if d.get(key):
            lines.append(f"{name}: “{_truncate(d[key])}”")
    lines.append(f"File: {d['file']}")
    lines.append(
        f"→ Reply with the mcp__atelier__propose tool (request {d['id']}). Without that tool: "
        f"write to {d['reply_path']} a JSON object of the form "
        '{"request": "<id>", "chapter": "<id>", "block": <n>, '
        '"target": "selection|paragraph|after", "excerpt": "<exact excerpt replaced>", '
        '"proposals": [{"text": "…", "why": "…"}], '
        '"notes": [{"text": "…", "excerpt": "…", "rule": "…"}], "message": "…"}'
    )
    return "\n".join(lines)
