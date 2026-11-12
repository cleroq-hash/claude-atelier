---
name: craft-rules
description: Checks a passage of fiction against the author's own style guide, then against a set of craft rules from writers and practitioners (M1 to M10, in craft-rules.md), and says which rule is not followed and where. Never rewrites. Use when the Atelier sends a request with "craft rules on", or when the writer asks to check a chapter or passage against craft rules. Do not use for traces of AI writing (that is ai-tells), nor to write or rewrite prose.
---

# Craft rules — which rule, and where

The goal is to show the writer which rule is not followed, and where. The writer decides
what to do about it. The text is never modified.

## 1. The rules, in this order

1. **The author's style guide** — it always wins. Its path is given on the `Style guide:`
   line of an `[Atelier]` request, or as `style_guide` by the `mcp__atelier__state` tool
   (by default `style.md` at the root of the manuscript). If there is none, say so once and
   use the craft rules alone.
   - What the guide names as a deliberate signature of the voice (a recurring construction,
     a way of ending paragraphs, a dialect) is **never** flagged.
   - A breach of a convention or of a defect the guide itself names is flagged, citing the
     section: `style.md §4`.
2. **The craft rules** in [`craft-rules.md`](craft-rules.md), all of them, M1 to M10. Read
   each rule's **limit** before flagging: an adjective inside dialogue, a negation that
   denies or contrasts, an adverb that cannot be said better otherwise are not breaches.
   **When a craft rule contradicts the style guide, the style guide wins and the case is not
   flagged.**
3. **`typo`** — agreement, punctuation, a missing space. Not a style rule, but it is seen in
   passing and the writer wants a clean text: one label for all of them.
4. **`consistency`** — a fact contradicted by another chapter or by the style guide (a name
   that changes, a day that disappears). Only asserted after checking the file that
   contradicts it; the note cites that place.

## 2. Flagging

- Read the style guide in full, then `craft-rules.md`, then the passage (or chapter) in
  full, before writing a single finding.
- One chapter at a time: beyond that, attention drops and the last findings are worth less.
- **M5** is checked only at a character's **first appearance**.
- **M8** is checked once per chapter, on its **last whole scene**: open or closed.
- **M9** is checked only on the **opening of the book** (or of a part).
- **M7** is not flagged sentence by sentence: flag the passage where several sentences in
  a row stand still.
- **Choose rather than flag everything.** A lone adverb that earns its place is not
  flagged. What is flagged: a cluster, a close repetition, a generic portrait, a breach of
  a written convention. When the rule itself hesitates, open the note with "Your call:" and
  say why in one sentence.
- **Never propose a full rewrite.** A note says what is wrong and may suggest a word
  ("'crept' carries both"); it does not rewrite the sentence.

## 3. Returning the findings

**In the Atelier** — call `mcp__atelier__propose` with `target: "paragraph"` and the
findings in `notes`, one note per finding, no `proposals` unless the request's action
asked for them:

```json
{"text": "What is wrong, in one or two sentences.",
 "excerpt": "the exact passage, copied character for character",
 "rule": "M3"}
```

- `rule`: a craft rule id (`M1`, `M10c`…), a style guide section (`style.md §4`), `typo`
  or `consistency`.
- `excerpt` is copied from the text exactly (curly quotes, apostrophes, without italic
  asterisks) and must be unique in the paragraph: lengthen it rather than guess. The page
  uses it to highlight the passage.
- One call per block: findings about another block go in another call, with its `block`.

**Outside the Atelier** — return a short list in the conversation: excerpt · rule · note,
in text order, then the count per rule (`M2: 4 · style.md §4: 2 · typo: 3`).

Then stop. Fixing the text is the writer's job.
