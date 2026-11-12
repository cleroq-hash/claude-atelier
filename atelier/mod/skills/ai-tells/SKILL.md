---
name: ai-tells
description: Flags traces of AI writing in a passage (the Humanizer grid, drawn from Wikipedia's "Signs of AI writing") and checks each one against the author's style guide, to say what is a tic and what is the writer's own voice. Returns findings; never rewrites anything unless asked, passage by passage. Use when the Atelier sends a request with "AI tells on", or when the writer asks whether a text "sounds like AI". Do not use to rewrite a text in the writer's style, nor for craft rules (that is craft-rules).
---

# AI tells — flag, compare, do not rewrite

The grid is [`humanizer-grid.md`](humanizer-grid.md), next to this file: 26 patterns,
numbered from strongest (§1) to weakest, vendored unchanged. **Take its patterns, never its
procedure**: its "How to work" section rewrites the text; this skill does not.

## What is never done

- **Touching the text.** The source is not modified, neither in place nor in a copy offered
  unasked. The findings are the deliverable.
- **Rewriting on momentum.** A rewrite happens only on request, **for the passages the
  writer points to**, showing before and after, and the writer chooses. "Fix them all" means
  the findings marked *tic*, not those marked *your voice*.
- **Comparing with an unmeasured corpus.** A density is counted on the text, never
  estimated. Do not claim a comparison with the writer's "earlier texts" without having
  counted them.

## 1. The reference: the author's style guide

Its path is given on the `Style guide:` line of an `[Atelier]` request, or as `style_guide`
by the `mcp__atelier__state` tool (by default `style.md` at the root of the manuscript).

**The style guide overrides the grid**, as the grid itself provides for a voice sample. A
construction the grid hunts (a "not X but Y" contrast, a short closing line, a dash, a
triad) may be exactly what the style guide asks for: then it is the writer's voice, not a
tic.

**If there is no style guide**, say so once, flag with the grid alone, and suggest that a
passage the writer recognises as their own could serve as a sample. Without a reference,
use *your call* rather than *your voice*.

## 2. Flagging

Read the style guide, then the passage in full. The grid is written for English; for a text
in another language, look for the **equivalent construction**, not a translation of the
words.

- §1 to §5 justify a finding on a single sighting.
- A pattern marked *weak alone* is flagged only when it has company from other tells in the
  same passage.
- Fiction is not a report: invented detail, dialogue full of filler, and a character's verbal
  habits are not tells. Check the narration first.
- Choose rather than flag everything: a pattern that recurs is one finding with its count,
  not ten notes.

## 3. Returning the findings

Each finding gets one of three verdicts:

- **tic**: nothing in the style guide supports it.
- **your voice**: a rule of the style guide describes or requires it; the note cites that
  rule.
- **your call**: the style guide allows it, but its density or position makes it suspect
  (ten contrasts in 700 words, a short closer after every paragraph).

**In the Atelier** — call `mcp__atelier__propose` with `target: "paragraph"` and the
findings in `notes`, no `proposals` unless the request's action asked for them:

```json
{"text": "tic: a one-line closer that repeats the paragraph's point.",
 "excerpt": "the exact passage, copied character for character",
 "rule": "§2"}
```

- `text` starts with the verdict (`tic:`, `your voice:`, `your call:`), then the reason;
  for *your voice*, the style guide rule that carries it (`style.md §3`).
- `rule`: the grid section (`§1`, `§12`…).
- `excerpt` is copied from the text exactly and must be unique in the paragraph. One call
  per block.

**Outside the Atelier** — in the conversation: one header line (reference used, word count,
number of findings per verdict), then one line per finding in text order: short exact
quote · grid § · verdict · reason.

**What the style guide does not cover**: a strong, recurring pattern on which the guide is
silent is left for the writer to decide, and, if they decide, to write into the style guide
itself.

Then stop. Any rewrite is the writer's request to make.
