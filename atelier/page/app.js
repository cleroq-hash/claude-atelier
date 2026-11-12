"use strict";
// Atelier — the page. No dependency, nothing external.
// The manuscript is a list of blocks (one per paragraph); Claude answers in the margin.

const $ = (s, r = document) => r.querySelector(s);
function el(tag, attrs = {}, ...children) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat()) if (c !== null && c !== undefined && c !== false)
    n.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return n;
}
const button = (text, fn, attrs = {}) =>
  el("button", { type: "button", ...attrs, onmousedown: e => e.preventDefault(), onclick: fn }, text);
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
const short = (s, n) => (s.length <= n ? s : s.slice(0, n - 1).trimEnd() + "…");
const clock = iso => (iso ? new Date(iso) : new Date()).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });

const api = {
  async get(url) {
    const r = await fetch(url, { cache: "no-store" });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || r.status);
    return j;
  },
  async post(url, body, opts = {}) {
    const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" },
                                 body: JSON.stringify(body), ...opts });
    const j = await r.json().catch(() => ({}));
    return { ...j, ok: r.ok, code: r.status };
  },
};

function load(key, fallback) {
  try { const v = localStorage.getItem(key); return v === null ? fallback : JSON.parse(v); } catch { return fallback; }
}
function store(key, v) { try { localStorage.setItem(key, JSON.stringify(v)); } catch { /* no storage: never mind */ } }

const NAMES = { improve: "Improve", variants: "Variants", continue: "Continue",
                ask: "Question", retry: "Retry" };
const LABELS = { selection: "Edit", paragraph: "Rewrite", after: "Continuation" };

const st = {
  chapters: [], directions: {}, id: null, blocks: [], hash: null,
  dirty: false, saving: null, again: false, timer: null, version: 0,
  focus: -1, requests: [], proposals: [], signature: "", bridge: null, first: true,
  applied: new Map(), // applied proposal → what is needed to undo it
  cards: new Map(),   // card id → { sig, node }: a card being edited is not redrawn
};
const settings = { style: true, level: "suggest", ...load("atelier.settings", {}) };

function kind(b) {
  const t = b.trim();
  if (t.startsWith("# ") || t.startsWith("## ")) return "heading";
  if (["***", "* * *", "---"].includes(t)) return "separator";
  if (t.startsWith("<!--") && t.endsWith("-->")) return "comment";
  return "paragraph";
}

// ---------------------------------------------------------------- the text

const zone = () => $("#text");
const textarea = i => zone().querySelector(`textarea[data-i="${i}"]`);

function fit(ta) { ta.style.height = "auto"; ta.style.height = ta.scrollHeight + "px"; }
function fitAll() {
  const tas = [...zone().querySelectorAll("textarea.block")];
  tas.forEach(ta => { ta.style.height = "auto"; });
  const h = tas.map(ta => ta.scrollHeight);
  tas.forEach((ta, k) => { ta.style.height = h[k] + "px"; });
}

function render() {
  if (!st.blocks.length) st.blocks = [""];
  const actions = $("#actions");
  document.body.append(actions);            // take it out before emptying the zone
  actions.hidden = true;
  zone().replaceChildren(...st.blocks.map((b, i) => {
    const ta = el("textarea", { class: `block ${kind(b)}`, rows: 1, spellcheck: "true",
                                "aria-label": `Block ${i + 1}`, "data-i": i });
    ta.value = b;
    return el("div", { class: "block-row", "data-i": i },
      el("div", { class: "gutter", title: `Block ${i + 1}` }, String(i + 1)),
      el("div", { class: "block-body" }, ta),
      el("aside", { class: "margin", "aria-label": `Margin of block ${i + 1}` }));
  }));
  fitAll();
  renderMargins(true);
}

function focusBlock(i, pos = 0) {
  const ta = textarea(Math.max(0, Math.min(i, st.blocks.length - 1)));
  if (!ta) return;
  ta.focus();
  const p = Math.min(pos, ta.value.length);
  ta.setSelectionRange(p, p);
}

function placeActions(i) {
  const row = zone().querySelector(`.block-row[data-i="${i}"]`);
  if (!row) return;
  zone().querySelectorAll(".block-row.focus").forEach(r => r.classList.remove("focus"));
  row.classList.add("focus");
  const actions = $("#actions");
  if (actions.parentElement !== row.querySelector(".block-body")) row.querySelector(".block-body").append(actions);
  actions.hidden = false;
}

function split(i, ta) {
  const v = ta.value;
  const before = v.slice(0, ta.selectionStart).replace(/\s+$/, "");
  const after = v.slice(ta.selectionEnd).replace(/^\s+/, "");
  st.blocks.splice(i, 1, before, after);
  render(); focusBlock(i + 1, 0); changed();
}

function merge(i) {               // block i joins block i-1
  const prev = st.blocks[i - 1], cur = st.blocks[i];
  const link = prev && cur ? " " : "";
  st.blocks.splice(i - 1, 2, prev + link + cur);
  render(); focusBlock(i - 1, prev.length + link.length); changed();
}

function paste(e, i, ta) {
  const t = (e.clipboardData || window.clipboardData).getData("text").replace(/\r\n/g, "\n");
  if (!/\n[ \t]*\n/.test(t)) return;           // a single paragraph: ordinary paste
  e.preventDefault();
  const pieces = t.split(/\n[ \t]*\n/).map(s => s.trim()).filter(Boolean);
  const v = ta.value, a = ta.selectionStart, b = ta.selectionEnd;
  const head = (v.slice(0, a) + pieces[0]).replace(/\s+$/, "");
  const rest = pieces.slice(1);
  rest[rest.length - 1] += v.slice(b);
  st.blocks.splice(i, 1, head, ...rest);
  render(); focusBlock(i + rest.length, st.blocks[i + rest.length].length - v.slice(b).length); changed();
}

function wireText() {
  const z = zone();
  z.addEventListener("input", e => {
    const ta = e.target.closest("textarea.block");
    if (!ta) return;
    const i = +ta.dataset.i;
    st.blocks[i] = ta.value;
    ta.className = `block ${kind(ta.value)}`;
    fit(ta); changed(); reportCurrent();
  });
  z.addEventListener("keydown", e => {
    const ta = e.target.closest("textarea.block");
    if (!ta) return;
    const i = +ta.dataset.i, a = ta.selectionStart, b = ta.selectionEnd, n = ta.value.length;
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault(); send(e.shiftKey ? "continue" : "improve"); return;
    }
    if (e.key === "Enter" && !e.shiftKey && !e.altKey) { e.preventDefault(); split(i, ta); return; }
    if (e.key === "Backspace" && a === 0 && b === 0 && i > 0) { e.preventDefault(); merge(i); return; }
    if (e.key === "Delete" && a === n && b === n && i < st.blocks.length - 1) { e.preventDefault(); merge(i + 1); return; }
    if (e.key === "ArrowUp" && a === 0 && b === 0 && i > 0) {
      e.preventDefault(); focusBlock(i - 1, st.blocks[i - 1].length); return;
    }
    if (e.key === "ArrowDown" && a === n && b === n && i < st.blocks.length - 1) {
      e.preventDefault(); focusBlock(i + 1, 0);
    }
  });
  z.addEventListener("paste", e => {
    const ta = e.target.closest("textarea.block");
    if (ta) paste(e, +ta.dataset.i, ta);
  });
  z.addEventListener("focusin", e => {
    const ta = e.target.closest("textarea.block");
    if (!ta) return;
    st.focus = +ta.dataset.i;
    placeActions(st.focus); reportCurrent();
  });
  for (const ev of ["select", "mouseup", "keyup"]) z.addEventListener(ev, e => {
    if (e.target.closest("textarea.block")) reportCurrent();
  });
  window.addEventListener("resize", debounce(fitAll, 150));
}

// ---------------------------------------------------------------- saving

function saveState(text, alert = false) {
  const s = $("#save-state");
  s.textContent = text;
  s.classList.toggle("alert", alert);
}
function showWords(n) { if (typeof n === "number") $("#words").textContent = `${n.toLocaleString()} words`; }

function changed() {
  st.dirty = true;
  saveState("Modified…");
  clearTimeout(st.timer);
  st.timer = setTimeout(() => save(), 1200);
}

function save(force = false) {
  clearTimeout(st.timer);
  if (st.saving) { st.again = true; return st.saving; }
  if (!st.dirty && !force) return Promise.resolve();
  const blocks = st.blocks.slice();
  st.dirty = false;
  saveState("Saving…");
  st.saving = (async () => {
    const r = await api.post("/api/chapter", { id: st.id, blocks, hash: st.hash, force });
    st.version++;
    if (r.code === 409) { st.dirty = true; showConflict(); saveState("Conflict", true); return; }
    if (!r.ok) { st.dirty = true; saveState("Save failed", true); return; }
    st.hash = r.hash;
    hideConflict();
    saveState("Saved " + clock());
    showWords(r.words);
    if (!st.dirty && JSON.stringify(r.blocks) !== JSON.stringify(blocks)) {
      st.blocks = r.blocks; render();       // the server split a block
    }
  })().catch(() => { st.dirty = true; saveState("Server unreachable", true); })
     .finally(() => {
       st.saving = null;
       if (st.again) { st.again = false; if (st.dirty) save(); }
     });
  return st.saving;
}

async function saveNow() {
  if (st.saving) await st.saving;
  if (st.dirty) await save();
}

function showConflict() { $("#conflict").hidden = false; }
function hideConflict() { $("#conflict").hidden = true; }

window.addEventListener("pagehide", () => {
  if (!st.dirty || !st.id) return;
  fetch("/api/chapter", { method: "POST", keepalive: true, headers: { "Content-Type": "application/json" },
                          body: JSON.stringify({ id: st.id, blocks: st.blocks, hash: st.hash }) });
});

// ---------------------------------------------------------------- where the writer is

const reportCurrent = debounce(() => {
  if (!st.id) return;
  const ta = textarea(st.focus);
  api.post("/api/current", {
    chapter: st.id, block: st.focus >= 0 ? st.focus + 1 : null, settings,
    selection: ta ? ta.value.slice(ta.selectionStart, ta.selectionEnd) : "",
  });
}, 500);

// ---------------------------------------------------------------- requests

async function send(action, extra = {}) {
  const i = extra.i ?? st.focus;
  if (i < 0 || i >= st.blocks.length) return toast("Place the cursor in a paragraph first.");
  const ta = textarea(i);
  const selection = ta ? ta.value.slice(ta.selectionStart, ta.selectionEnd).trim() : "";
  const field = $("#request-direction");
  const direction = extra.direction ?? field.value.trim();
  if (action === "ask" && !direction) { field.focus(); return toast("Write your question in the field, then “Ask”."); }
  if (!st.blocks[i].trim() && action !== "continue" && action !== "ask")
    return toast("This paragraph is empty: “Continue” proposes what comes next, “Ask” asks a question.");
  await saveNow();                          // the request is made on the saved text
  const r = await api.post("/api/request", {
    chapter: st.id, block: i + 1, action, direction, settings,
    excerpt: extra.excerpt ?? (action === "continue" ? "" : selection),
    paragraph: st.blocks[i], previous: extra.previous || "",
  });
  if (!r.ok) return toast("Request refused: " + (r.error || r.code));
  if (extra.direction === undefined) field.value = "";
  st.requests.push({ ...r, status: "pending" });
  renderMargins();
}

async function setStatus(id, status) { await api.post("/api/status", { id, status }); }

// ---------------------------------------------------------------- the margin

function locate(p) {
  const b = st.blocks, n = (p.block || 1) - 1;
  if (p.anchor) {
    if (b[n] === p.anchor) return { i: n, sure: true };
    const k = b.indexOf(p.anchor);
    if (k >= 0) return { i: k, sure: true };
  }
  if (p.target === "selection" && p.excerpt) {
    if (b[n] && b[n].includes(p.excerpt)) return { i: n, sure: true };
    const k = b.findIndex(x => x.includes(p.excerpt));
    if (k >= 0) return { i: k, sure: true };
  }
  return { i: Math.max(0, Math.min(n, b.length - 1)), sure: !p.anchor };
}

function renderMargins(all = false) {
  if (all) st.cards.clear();
  const byBlock = new Map();
  const add = (i, id, sig, make) => {
    if (!byBlock.has(i)) byBlock.set(i, []);
    let c = st.cards.get(id);
    if (!c || c.sig !== sig) { c = { sig, node: make() }; st.cards.set(id, c); }
    byBlock.get(i).push(c.node);
  };
  const answered = new Set(st.proposals.map(p => p.request).filter(Boolean));
  for (const d of st.requests) {
    if (d.status === "answered" || answered.has(d.id)) continue;
    const i = Math.max(0, Math.min(d.block - 1, st.blocks.length - 1));
    add(i, d.id, JSON.stringify([d.status, st.bridge]), () => requestCard(d));
  }
  for (const p of st.proposals) {
    const ap = st.applied.get(p.id);
    if (p.status !== "new" && !ap) continue;
    const s = ap ? { i: ap.i, sure: true } : locate(p);
    add(s.i, p.id, JSON.stringify([p, s, !!ap, ap ? 0 : st.blocks[s.i]]), () => proposalCard(p, s.i, s.sure));
  }
  zone().querySelectorAll(".block-row").forEach(r => {
    const margin = r.querySelector(".margin");
    const wanted = byBlock.get(+r.dataset.i) || [];
    const current = [...margin.children];
    if (wanted.length !== current.length || wanted.some((n, k) => n !== current[k])) margin.replaceChildren(...wanted);
    r.classList.toggle("has-margin", wanted.length > 0);
  });
}

function requestCard(d) {
  const waiting = d.status !== "sent";
  const noBridge = waiting && !st.bridge;
  const c = el("div", { class: "card request", "data-id": d.id },
    el("div", { class: "head" }, el("span", { class: "label" }, NAMES[d.action] || d.action),
       el("span", { class: "when" }, clock(d.created))),
    d.excerpt ? el("blockquote", {}, `“${short(d.excerpt, 160)}”`) : null,
    d.direction ? el("div", { class: "message" }, "Direction: " + d.direction) : null,
    el("div", { class: "waiting" + (noBridge ? " stopped" : "") },
       noBridge ? "The bridge is not connected: paste the request into the conversation."
                : waiting ? "Sending to Claude…" : "Claude is thinking…"));
  const buttons = el("div", { class: "buttons" });
  if (noBridge) buttons.append(button("Copy the request", () => copy(d.prompt, c), { class: "primary" }));
  buttons.append(button("Withdraw", async () => {
    await setStatus(d.id, "dismissed");
    st.requests = st.requests.filter(x => x.id !== d.id); renderMargins();
  }));
  c.append(buttons);
  return c;
}

async function copy(text, card) {
  try { await navigator.clipboard.writeText(text); toast("Request copied: paste it into the conversation."); }
  catch {
    const t = el("textarea", { class: "copy", readonly: true });
    t.value = text; card.append(t); t.focus(); t.select();
    toast("Copy blocked here: press Ctrl+C on the selected text.");
  }
}

function tokens(s) { return s.match(/\s+|[\p{L}\p{N}’'-]+|[^\s\p{L}\p{N}]/gu) || []; }
function diff(a, b) {
  const A = tokens(a), B = tokens(b), n = A.length, m = B.length;
  if (!n || n * m > 2000000) return [{ t: "=", s: b }];   // ~700 words on each side
  const L = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--)
    L[i][j] = A[i] === B[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const out = [];
  const push = (t, s) => { const d = out[out.length - 1]; if (d && d.t === t) d.s += s; else out.push({ t, s }); };
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (A[i] === B[j]) { push("=", A[i]); i++; j++; }
    else if (L[i + 1][j] >= L[i][j + 1]) push("-", A[i++]);
    else push("+", B[j++]);
  }
  while (i < n) push("-", A[i++]);
  while (j < m) push("+", B[j++]);
  return group(out);
}
// A short word left unchanged between two changes chops up the reading
// ("the̶Nobody who̶that"): it joins both the removed run and the added run.
function group(ops) {
  const out = [];
  let removed = "", added = "";
  const flush = () => {
    if (removed) out.push({ t: "-", s: removed });
    if (added) out.push({ t: "+", s: added });
    removed = added = "";
  };
  ops.forEach((o, k) => {
    if (o.t === "-") removed += o.s;
    else if (o.t === "+") added += o.s;
    else {
      const between = (removed || added) && k + 1 < ops.length && ops[k + 1].t !== "=";
      const small = o.s.trim().length <= 3 || (o.s.length <= 12 && removed.length + added.length > 30);
      if (between && small) { removed += o.s; added += o.s; }
      else { flush(); out.push(o); }
    }
  });
  flush();
  return out;
}
function renderDiff(a, b) {
  const f = el("div", { class: "diff" });
  for (const d of diff(a, b)) f.append(d.t === "=" ? d.s : el(d.t === "+" ? "ins" : "del", {}, d.s));
  return f;
}

function proposalCard(p, i, sure) {
  const ap = st.applied.get(p.id);
  const variants = st.requests.find(d => d.id === p.request)?.action === "variants";
  const label = !(p.proposals || []).length ? "Notes"
    : variants ? "Variants" : (LABELS[p.target] || "Proposal");
  const c = el("div", { class: `card proposal target-${p.target || "paragraph"}`, "data-id": p.id },
    el("div", { class: "head" },
       el("span", { class: "label" }, label),
       p.request ? null : el("span", { class: "badge", title: "Asked in the conversation" }, "conversation"),
       el("span", { class: "when" }, clock(p.created))));
  if (ap) {
    c.append(el("div", { class: "message" }, "Applied to the text."),
             el("div", { class: "buttons" },
                button("Undo", () => undoApply(p.id)),
                button("Close", () => { st.applied.delete(p.id); renderMargins(); })));
    return c;
  }
  if (!sure) c.append(el("div", { class: "warning" }, "The paragraph has changed since the request: check before applying."));
  if (p.message) c.append(el("p", { class: "message" }, p.message));
  const base = p.target === "selection" ? (p.excerpt || "") : p.target === "after" ? "" : st.blocks[i];
  (p.proposals || []).forEach(prop => {
    const text = prop.text || "";
    const body = base ? renderDiff(base, text) : el("div", { class: "plain" }, text);
    const option = el("div", { class: "option" }, body,
      prop.why ? el("div", { class: "why" }, prop.why) : null);
    const buttons = el("div", { class: "buttons" },
      button(p.target === "after" ? "Insert after" : "Replace", () => apply(p, i, text), { class: "primary" }),
      button("Edit", () => editOption(option, p, i, text)),
      button("Retry…", () => retry(option, p, i, text)));
    option.append(buttons);
    c.append(option);
  });
  if ((p.notes || []).length) {
    c.append(el("ul", { class: "notes" }, p.notes.map(n => el("li", {},
      n.rule ? el("span", { class: "rule" }, n.rule) : null, n.text || "",
      n.excerpt ? [" ", el("q", {}, short(n.excerpt, 90))] : null,
      n.excerpt ? button("Show", () => show(i, n.excerpt)) : null))));
  }
  const end = el("div", { class: "buttons" });
  if (!(p.proposals || []).length) end.append(button("Seen", () => closeProposal(p.id, "applied")));
  end.append(button("Dismiss", () => closeProposal(p.id, "dismissed")));
  c.append(end);
  return c;
}

async function closeProposal(id, status) {
  const p = st.proposals.find(x => x.id === id);
  if (p) p.status = status;
  renderMargins();
  await setStatus(id, status);
}

function replaceIn(ta, a, b, text) {
  ta.focus();
  ta.setSelectionRange(a, b);
  let ok = false;
  try { ok = document.execCommand("insertText", false, text); } catch { ok = false; }
  if (!ok || ta.value.slice(a, a + text.length) !== text) {
    ta.setRangeText(text, a, b, "end");
    st.blocks[+ta.dataset.i] = ta.value; fit(ta); changed();
  }
}

function apply(p, i, text) {
  const ta = textarea(i);
  if (!ta) return;
  const before = st.blocks[i];
  let inserted = null;
  if (p.target === "selection") {
    const pos = before.indexOf(p.excerpt || "\u0000");
    if (!p.excerpt || pos < 0) return toast("The targeted passage is no longer in the paragraph: “Edit”, then paste it by hand.");
    replaceIn(ta, pos, pos + p.excerpt.length, text);
  } else if (p.target === "after") {
    inserted = text.split(/\n[ \t]*\n/).map(s => s.trim()).filter(Boolean);
    st.blocks.splice(i + 1, 0, ...inserted);
    render(); focusBlock(i + inserted.length, 1e9); changed();
  } else {
    replaceIn(ta, 0, before.length, text);
  }
  st.applied.set(p.id, { i, before, after: st.blocks[i], inserted });
  p.status = "applied";
  setStatus(p.id, "applied");
  renderMargins();
}

function undoApply(id) {
  const x = st.applied.get(id);
  if (!x) return;
  if (x.inserted) {
    const n = x.inserted.length;
    if (JSON.stringify(st.blocks.slice(x.i + 1, x.i + 1 + n)) !== JSON.stringify(x.inserted))
      return toast("The inserted continuation has been edited since: undo it by hand.");
    st.blocks.splice(x.i + 1, n);
    render(); focusBlock(x.i, 1e9); changed();
  } else {
    const k = st.blocks[x.i] === x.after ? x.i : st.blocks.indexOf(x.after);
    if (k < 0) return toast("The paragraph has been edited since: undo by hand (Ctrl+Z in the paragraph).");
    const ta = textarea(k);
    replaceIn(ta, 0, ta.value.length, x.before);
  }
  st.applied.delete(id);
  const p = st.proposals.find(q => q.id === id);
  if (p) p.status = "new";
  setStatus(id, "new");
  renderMargins();
}

function editOption(option, p, i, text) {
  const t = el("textarea", { class: "edit", spellcheck: "true" });
  t.value = text;
  option.replaceChildren(t, el("div", { class: "buttons" },
    button("Apply my version", () => apply(p, i, t.value), { class: "primary" }),
    button("Cancel", () => { st.cards.delete(p.id); renderMargins(); })));
  t.focus();
}

function retry(option, p, i, text) {
  if (option.querySelector(".retry")) return option.querySelector(".retry input").focus();
  const field = el("input", { placeholder: "Your new direction for this proposal…", autocomplete: "off" });
  const go = async () => {
    if (!field.value.trim()) return field.focus();
    await send("retry", { i, direction: field.value.trim(), previous: text, excerpt: p.excerpt || "" });
    closeProposal(p.id, "dismissed");
  };
  field.addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); go(); } });
  option.append(el("div", { class: "retry" }, field, button("Retry", go, { class: "primary" })));
  field.focus();
}

function show(i, excerpt) {
  const ta = textarea(i);
  if (!ta) return;
  const pos = ta.value.indexOf(excerpt);
  ta.focus();
  if (pos >= 0) ta.setSelectionRange(pos, pos + excerpt.length);
  else toast("The passage is no longer in the paragraph.");
}

// ---------------------------------------------------------------- listening to the server

function showBridge(active) {
  if (active === st.bridge) return;
  st.bridge = active;
  const b = $("#bridge");
  b.classList.toggle("active", active);
  b.textContent = active ? "Claude connected" : "No bridge";
  b.title = active ? "Your requests go into the conversation"
                   : "The Atelier mod is not loaded: requests are copied by hand";
  renderMargins();
}

async function poll() {
  if (!st.id) return;
  const id = st.id, version = st.version;
  let n;
  try { n = await api.get(`/api/updates?chapter=${encodeURIComponent(id)}`); }
  catch { showBridge(false); return; }
  if (id !== st.id) return;
  showBridge(n.bridge.active);
  const sig = JSON.stringify([n.requests, n.proposals]);
  if (sig !== st.signature) {
    const known = new Set(st.proposals.map(p => p.id));
    const fresh = n.proposals.filter(p => !known.has(p.id) && p.status === "new");
    st.requests = n.requests; st.proposals = n.proposals; st.signature = sig;
    renderMargins();
    if (!st.first && fresh.length) {
      const p = fresh[fresh.length - 1];
      const see = () => zone().querySelector(`.card[data-id="${p.id}"]`)?.scrollIntoView({ behavior: "smooth", block: "center" });
      toast(p.request ? "Claude answered in the margin." : "Arrived from the conversation.", { text: "Show", fn: see });
    }
  }
  st.first = false;
  if (n.hash !== st.hash && version === st.version && !st.saving) {
    if (st.dirty) showConflict();
    else { await loadChapter(id, { keep: true }); toast("Reloaded: the file changed on disk."); }
  }
}

// ---------------------------------------------------------------- chapters and settings

async function loadChapter(id, { keep = false } = {}) {
  await saveNow();
  const r = await api.get(`/api/chapter?id=${encodeURIComponent(id)}`);
  const focus = st.focus, ta = textarea(focus), pos = ta ? ta.selectionStart : 0;
  Object.assign(st, { id, blocks: r.blocks.length ? r.blocks : [""], hash: r.hash,
                      dirty: false, focus: -1, applied: new Map(), version: st.version + 1 });
  if (!keep) Object.assign(st, { requests: [], proposals: [], signature: "", first: true });
  $("#chapter").value = id;
  $("#chapter-direction").value = st.directions[id] || "";
  showWords(r.words);
  history.replaceState(null, "", "#" + id);
  store("atelier.chapter", id);
  render();
  hideConflict();
  saveState("Up to date");
  if (keep && focus >= 0) focusBlock(focus, pos);
  reportCurrent();   // the `state` tool must know which chapter is open, even without a click
  poll();
}

function wireSettings() {
  const sw = $("#s-style");
  sw.checked = !!settings.style;
  sw.addEventListener("change", () => { settings.style = sw.checked; store("atelier.settings", settings); reportCurrent(); });
  const seg = document.querySelectorAll(".segment button");
  const paint = () => seg.forEach(b => b.setAttribute("aria-pressed", String(b.dataset.level === settings.level)));
  seg.forEach(b => b.addEventListener("click", () => {
    settings.level = b.dataset.level; store("atelier.settings", settings); paint(); reportCurrent();
  }));
  paint();

  const dir = $("#chapter-direction");
  const setDirection = debounce((id, value) => api.post("/api/direction", { chapter: id, direction: value }), 700);
  dir.addEventListener("input", () => { st.directions[st.id] = dir.value; setDirection(st.id, dir.value); });

  const actions = $("#actions");
  actions.addEventListener("mousedown", e => { if (e.target.closest("button")) e.preventDefault(); });
  actions.addEventListener("click", e => {
    const b = e.target.closest("button[data-action]");
    if (b) send(b.dataset.action);
  });
  $("#request-direction").addEventListener("keydown", e => {
    if (e.key === "Enter") { e.preventDefault(); send(e.ctrlKey ? "ask" : "improve"); }
    if (e.key === "Escape") focusBlock(st.focus, textarea(st.focus)?.selectionEnd ?? 0);
  });

  $("#chapter").addEventListener("change", e => loadChapter(e.target.value));
  $("#keep-mine").addEventListener("click", () => save(true));
  $("#take-disk").addEventListener("click", () => { st.dirty = false; loadChapter(st.id); });
}

let toastTimer;
function toast(text, action) {
  const t = $("#toast");
  t.replaceChildren(el("span", {}, text), action ? button(action.text, () => { action.fn(); t.hidden = true; }) : null);
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 4500);
}

async function start() {
  wireText();
  wireSettings();
  const r = await api.get("/api/chapters");
  st.chapters = r.chapters;
  st.directions = r.directions || {};
  $("#chapter").replaceChildren(...r.chapters.map(c =>
    el("option", { value: c.id }, c.title ? `${c.title}` : c.id)));
  if (!r.chapters.length) { saveState("No chapter in " + r.root, true); return; }
  const wanted = [location.hash.slice(1), load("atelier.chapter", "")].find(x => r.chapters.some(c => c.id === x));
  await loadChapter(wanted || r.chapters[0].id);
  setInterval(poll, 1000);
}

start().catch(e => saveState("Error: " + e.message, true));
