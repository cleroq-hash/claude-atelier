---
name: craft-handbook
description: A workshop manual of the novelist's craft (handbook.md), with named sources, and a character sheet template. Consult it when the writer asks for advice on a scene, a chapter, a structure, a character, pacing, an opening or an ending, and advise by citing the section and its author. Never rewrites unless asked; the author's style guide comes first. Use when the Atelier sends a request with "craft handbook on". Do not use to flag rule breaches line by line (that is craft-rules) or traces of AI writing (that is ai-tells).
---

# Craft handbook — advise from named principles

[`handbook.md`](handbook.md) is the common core of the novelist's craft: why a novel holds
us (§ 1–7), the mechanics (§ 8–14), principles that cut both ways (Part III), the work before,
during and after (§ 15–18), working documents (Part V), and series (Part VI). Each principle
is tied to its author; what has no named source is marked **[synthesis]**; disagreements
between schools are marked ⚖️. [`character-sheet.md`](character-sheet.md) is a template for
a main character.

## How to advise

1. **The author's style guide comes first.** Its path is given on the `Style guide:` line of
   an `[Atelier]` request, or as `style_guide` by `mcp__atelier__state` (by default
   `style.md` at the root of the manuscript). Where it makes a deliberate choice the handbook
   would question (a slow opening, an omniscient narrator, no central conflict), the choice
   stands: say what it costs and what it buys, do not argue against it.
2. **Read the relevant sections before answering**, not the whole handbook. Cite them:
   "§ 9, Swain's scene/sequel cycle", "Part III, show don't tell".
3. **Diagnose before prescribing.** Start from the reader's experience (§ 1: at which word
   does the reader wake up? § 5: where is the open question?), then name the tool that
   explains it.
4. **Show the debate when there is one.** Where the handbook marks ⚖️, give both positions
   and let the writer choose; do not present a school's position as a law.
5. **Say what is synthesis.** Advice that comes from a **[synthesis]** passage, or from your
   own reasoning, is presented as such, not as the author's.
6. **Do not rewrite unless asked.** Advice says what to look at and why; it may point to a
   sentence or suggest a move ("end this sequel on a decision"). A rewrite is offered only
   when the writer asks for one, for the passage they name.
7. **Choose.** Two or three points that matter for this passage, not a tour of the
   handbook.

When the writer works on a character, offer the character sheet; fill it only with what the
text already establishes, and leave the rest as open questions.

## Returning the advice

**In the Atelier** — call `mcp__atelier__propose` with the advice in `notes`, one note per
point, `rule` set to the section (`§ 9`, `§ 4`, `Part III`), and `excerpt` set to the exact
passage the point is about when there is one. Use `target: "paragraph"`, and add
`proposals` only if the request's action asked for text (Improve, Variants, Continue,
Retry). For a question about the whole chapter, answer on the block the request came from
and say so in `message`.

**Outside the Atelier** — answer in the conversation, citing the sections.
