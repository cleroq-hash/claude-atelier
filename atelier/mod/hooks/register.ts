// Atelier — the bridge between the local page and the conversation.
//
// The page (served by `python -m atelier.server`) stores each request in
// `<state>/requests/<id>.json`. This mod sees it, marks it as sent, and submits it
// to the conversation as if the writer had typed it. Claude replies with the
// `propose` tool, which writes `<state>/proposals/<id>.json`: the page shows it in
// the margin. `~/.atelier/active.json`, which the server rewrites every 10 s, says
// where the state is and that the server is alive: with the server stopped, the mod
// stays quiet (no protocol, no polling).
import type { Register, EngineInterface } from 'claude-code'

type Pointer = { state: string; root: string; url: string; seen?: number }
type Request = {
  id: string; chapter: string; block: number; excerpt?: string; paragraph?: string;
  prompt: string
}

const POLL_MS = 1000
const HEARTBEAT_MS = 4000
const STALE_MS = 3 * 60 * 1000 // an older request is no longer sent on its own
const ALIVE_MS = 30 * 1000      // the server beats every 10 s

const PROTOCOL = `# Atelier

The writer is working in the Atelier, a local page open next to the conversation. A message that starts with "[Atelier]" comes from a button on that page.

- Reply by calling the mcp__atelier__propose tool: it places your proposals in the margin of the targeted paragraph. In the conversation, one line at most: the answer is in the margin.
- Never modify the manuscript files yourself: the writer applies, edits or dismisses with one click.
- "style guide on": read the file named on the "Style guide:" line (or "style_guide" in mcp__atelier__state) before writing any prose (once per session is enough if it has not changed), and write in that voice. "off", or no file: do not rely on it.
- "craft rules on": check the targeted passage with the craft-rules skill of this plugin (atelier:craft-rules) and return what you find as notes (notes[], the rule id in "rule"). The style guide always wins over the craft rules.
- "AI tells on": check the targeted passage with the ai-tells skill of this plugin (atelier:ai-tells) and return what you find as notes, each with its verdict (tic / your voice / your call). The style guide always wins over the grid.
- "craft handbook on": consult the craft-handbook skill of this plugin (atelier:craft-handbook) and give your advice as notes citing the handbook section (§ 9, Part III…) in "rule". The style guide always wins over the handbook.
- None of these skills rewrites anything: findings go in notes; proposals only for what the action itself asks for.
- Level: light = a single proposal, the smallest edit that serves the direction; suggest = two or three short, clearly different proposals; co-write = you may propose whole paragraphs.
- Improve: target "selection" with the exact excerpt when a piece is selected, otherwise "paragraph". Variants: three clearly different versions of the same passage. Continue: target "after", one or two possible continuations, in the voice of the text. Free question: answer in notes, and in proposals if the question calls for them. Retry: rework the given proposal following the new direction.
- Each proposal may carry a one-line "why". The chapter direction applies to every request; the request's own direction takes precedence.
- A request made in the conversation about the text open in the Atelier: call mcp__atelier__state to see what the writer is looking at, then mcp__atelier__propose.`

const unix = (p: string) => p.replace(/\\/g, '/')
const readJson = async <T>($: EngineInterface, path: string): Promise<T | undefined> => {
  try { return JSON.parse(String(await $.fs.read(path))) as T } catch { return undefined }
}

async function pointer($: EngineInterface): Promise<Pointer | undefined> {
  const home = (await $.env.get('USERPROFILE')) || (await $.env.get('HOME'))
  if (!home) return undefined
  const p = await readJson<Pointer>($, `${unix(home)}/.atelier/active.json`)
  return p ? { ...p, state: unix(p.state) } : undefined
}

async function serverAlive($: EngineInterface): Promise<Pointer | undefined> {
  const p = await pointer($)
  return p?.seen && (await $.clock.now()) - p.seen < ALIVE_MS ? p : undefined
}

function timestamp(ms: number): string {
  const d = new Date(ms)
  const two = (n: number) => String(n).padStart(2, '0')
  return `${two(d.getMonth() + 1)}${two(d.getDate())}-${two(d.getHours())}${two(d.getMinutes())}${two(d.getSeconds())}`
}

// Requests already seen by this module (it starts empty on every reload; the
// `sent/<id>` file keeps the memory from one reload to the next).
const submitted = new Set<string>()

async function poll($: EngineInterface): Promise<void> {
  const p = await serverAlive($)
  if (!p) return
  const requests = await $.fs.list(`${p.state}/requests`).catch(() => [])
  if (!requests.length) return
  const now = await $.clock.now()
  const recent = requests.filter(f => f.kind === 'file' && f.name.endsWith('.json')
    && !submitted.has(f.name.slice(0, -5)) && now - f.mtimeMs < STALE_MS)
  if (!recent.length) return
  const already = new Set((await $.fs.list(`${p.state}/sent`).catch(() => [])).map(f => f.name))
  for (const f of recent) {
    const id = f.name.slice(0, -5)
    submitted.add(id)
    if (already.has(id)) continue
    const d = await readJson<Request>($, `${p.state}/requests/${f.name}`)
    if (!d?.prompt) continue
    // Marked before sending: a reloaded module will not send it twice.
    await $.fs.write(`${p.state}/sent/${id}`, new Date(now).toISOString())
    void $.prompt.submit({ text: d.prompt, asUser: true })
  }
}

async function beat($: EngineInterface): Promise<void> {
  const p = await serverAlive($)
  if (p) await $.fs.write(`${p.state}/bridge.json`, JSON.stringify({ seen: await $.clock.now() }))
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const r = await next(e)
    await $.tool.register({
      name: 'state',
      description: 'What the writer is looking at in the Atelier: open chapter, block where the cursor is, selection, settings, chapter direction, path of the style guide, and the chapter\'s blocks numbered as the page shows them. Call it before answering a request made in the conversation about the text.',
      inputSchema: { type: 'object', properties: {} },
      isDeferred: false,
    })
    await $.tool.register({
      name: 'propose',
      description: 'Places proposals or notes in the margin of a paragraph in the Atelier. Does not modify the manuscript: the writer applies, edits or dismisses. target: "selection" replaces the exact excerpt within the block, "paragraph" replaces the whole block, "after" inserts after the block.',
      inputSchema: {
        type: 'object',
        properties: {
          request: { type: 'string', description: 'The id of the [Atelier] request you are answering (d-...). Omit for a request made in the conversation.' },
          chapter: { type: 'string', description: 'The chapter id (ch03). Default: the request\'s, otherwise the one open in the Atelier.' },
          block: { type: 'integer', minimum: 1, description: 'The number of the targeted block, as the page shows it. Default: the request\'s.' },
          target: { type: 'string', enum: ['selection', 'paragraph', 'after'] },
          excerpt: { type: 'string', description: 'The exact piece replaced, when target = selection.' },
          proposals: {
            type: 'array',
            items: {
              type: 'object',
              properties: { text: { type: 'string' }, why: { type: 'string', description: 'One line.' } },
              required: ['text'],
            },
          },
          notes: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                text: { type: 'string' },
                excerpt: { type: 'string', description: 'The exact passage the note is about.' },
                rule: { type: 'string', description: 'The rule cited: a craft rule id (M3), a style guide section (style.md §4), a grid section (§1), or typo.' },
              },
              required: ['text'],
            },
          },
          message: { type: 'string', description: 'One line for the writer, at the top of the card.' },
        },
        required: ['target'],
      },
      isDeferred: false,
    })
    $.clock.every(POLL_MS, () => { void poll($).catch(() => undefined) })
    $.clock.every(HEARTBEAT_MS, () => { void beat($).catch(() => undefined) })
    void beat($).catch(() => undefined)
    return r
  })

  on('prompt.compose', async ($, e, next) => {
    const r = await next(e)
    if (!(await serverAlive($))) return r
    return { sections: [...r.sections, { id: 'atelier:protocol', text: PROTOCOL, scope: 'session' as const }] }
  })

  on('tool.call', { tool: 'mcp__atelier__state' }, async $ => {
    const p = await pointer($)
    if (!p) return { result: 'The Atelier has never been started on this machine (no ~/.atelier/active.json).' }
    const c = await readJson<Record<string, unknown>>($, `${p.state}/current.json`)
    if (!c) return { result: `The Atelier is running (${p.url}) but no page is open on it.` }
    return { result: JSON.stringify(c, null, 1) }
  }).catch(($, e, next) => next.called ? next(e) : { deny: 'atelier: the state tool failed.' })

  on('tool.call', { tool: 'mcp__atelier__propose' }, async ($, e) => {
    const x = e as unknown as {
      request?: string; chapter?: string; block?: number; target: string; excerpt?: string
      proposals?: { text: string; why?: string }[]
      notes?: { text: string; excerpt?: string; rule?: string }[]; message?: string
    }
    const p = await pointer($)
    if (!p) return { deny: 'The Atelier has never been started (no ~/.atelier/active.json).' }
    if (!(x.proposals?.length || x.notes?.length)) return { deny: 'Nothing to place: no proposal and no note.' }
    if (!['selection', 'paragraph', 'after'].includes(x.target)) return { deny: 'target: selection, paragraph or after.' }

    let chapter = x.chapter, block = x.block, excerpt = x.excerpt, anchor: string | undefined
    if (x.request) {
      const d = await readJson<Request>($, `${p.state}/requests/${x.request}.json`)
      if (!d) return { deny: `Unknown request: ${x.request}.` }
      chapter ??= d.chapter
      block ??= d.block
      if (x.target === 'selection') excerpt ??= d.excerpt
      if (block === d.block && chapter === d.chapter) anchor = d.paragraph
    } else {
      const c = await readJson<{ chapter: string; block?: number; blocks: { n: number; text: string }[] }>($, `${p.state}/current.json`)
      chapter ??= c?.chapter
      block ??= c?.block ?? undefined
      if (c && chapter === c.chapter) anchor = c.blocks.find(b => b.n === block)?.text
    }
    if (!chapter || !block) return { deny: 'Chapter or block missing: call mcp__atelier__state.' }
    if (x.target === 'selection' && !excerpt) return { deny: 'target selection: give the exact excerpt replaced.' }
    if (x.target === 'selection' && anchor && excerpt && !anchor.includes(excerpt))
      return { deny: `The excerpt is not in block ${block}: copy it exactly, or target the paragraph.` }

    const when = await $.clock.now()
    const id = `p-${timestamp(when)}-${Math.random().toString(16).slice(2, 6)}`
    const record = {
      id, request: x.request ?? null, chapter, block, target: x.target, excerpt: excerpt ?? '',
      anchor: anchor ?? null, proposals: x.proposals ?? [], notes: x.notes ?? [],
      message: x.message ?? '', created: new Date(when).toISOString(),
    }
    await $.fs.write(`${p.state}/proposals/${id}.json`, JSON.stringify(record, null, 1))
    const n = record.proposals.length, m = record.notes.length
    return { result: `Placed in the margin: ${chapter}, block ${block} — ${n} proposal(s), ${m} note(s).` }
  }).catch(($, e, next) => next.called ? next(e) : { deny: 'atelier: the propose tool failed.' })
}
