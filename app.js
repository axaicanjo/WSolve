/* Wordle Solver — UI */
'use strict';

const WORDS = [];
for (let i = 0; i < WORDBLOB.length; i += 5) WORDS.push(WORDBLOB.substr(i, 5));
const ADDED = new Set(ADDED_IDX.map(i => WORDS[i]));

const $ = id => document.getElementById(id);
const boardEl = $('board'), outEl = $('out'), hintEl = $('hint'), cntEl = $('cnt');

let HIST = [];           // [{guess:'raise', pattern:int, marks:[0..2]x5}]
let input = '';          // letters typed in the active row
let marks = [0, 0, 0, 0, 0];
let last = null;         // last worker result
let focusWord = null;    // which suggestion the groups panel is showing
let token = 0, busy = false, ready = false;

/* ---------- settings ---------- */
const LS = {
  get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }
};
let useHist = LS.get('ws_useHist', false);
let rho = LS.get('ws_rho', 0.03);

/* ---------- answer history ----------
   past.json holds one entry per puzzle number (index 0 = 19 Jun 2021).
   On top of that the app asks the NYT's own endpoint for any days the file
   is missing, and remembers what it learns. */
const LAUNCH = Date.UTC(2021, 5, 19);
const DAY = 86400000;
const dayNum = d => Math.round((Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) - LAUNCH) / DAY);
const numDate = n => new Date(LAUNCH + n * DAY);
const iso = n => numDate(n).toISOString().slice(0, 10);
const fmtDate = n => numDate(n).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: '2-digit', timeZone: 'UTC' });

const TODAYNUM = dayNum(new Date());
const HISTORY = new Map();      // puzzle number -> word, strictly BEFORE today
let histSource = 'none';        // none | file | live
let liveOk = null;              // null = untried, true/false after an attempt

/* Today's puzzle is deliberately never recorded. The archive is a record of
   what the answer has already been; if today's answer leaked into it, the
   solver would file today's word under "previously an answer", age it at zero
   days and weight it down to nothing — steering away from the correct word. */
const isPast = n => n >= 0 && n < TODAYNUM;

async function loadHistory() {
  try {
    const r = await fetch('past.json', { cache: 'no-cache' });
    if (r.ok) {
      const j = await r.json();
      (j.words || []).forEach((w, i) => { if (w && isPast(i)) HISTORY.set(i, String(w).toLowerCase()); });
      if (HISTORY.size) histSource = 'file';
    }
  } catch (e) { /* file absent — fine */ }
  for (const [k, v] of Object.entries(LS.get('ws_extra', {}))) if (isPast(+k)) HISTORY.set(+k, v);
  if (HISTORY.size && histSource === 'none') histSource = 'file';
  pushHistory();
  topUp();
}

const nytUrl = n => 'https://www.nytimes.com/svc/wordle/v2/' + iso(n) + '.json';

async function fetchDay(n) {
  const r = await fetch(nytUrl(n), { cache: 'no-store' });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const j = await r.json();
  const w = (j.solution || j.answer || '').toLowerCase();
  if (!/^[a-z]{5}$/.test(w)) throw new Error('bad payload');
  const num = Number.isInteger(j.days_since_launch) ? j.days_since_launch : n;
  return [num, w];
}

function remember(num, word) {
  if (!isPast(num)) return;                 // never store today's answer
  HISTORY.set(num, word);
  const extra = LS.get('ws_extra', {});
  extra[num] = word;
  LS.set('ws_extra', extra);
}

/* A short line of plain-English status, shown in the history panel. It lives in
   a variable rather than on the button, because renderStatus() rebuilds the
   panel from scratch and would otherwise wipe whatever the button was saying. */
let histMsg = '';
function setMsg(m) { histMsg = m; renderStatus(); }
const why = e => (e && e.message ? e.message : String(e)) || 'no reason given';

/* Opportunistically fill any gap the file has, most recent first, without
   hammering. past.json is the real source — the daily GitHub task keeps it
   current — so this is a bonus, not a requirement. The NYT endpoint sends no
   CORS headers, so from a browser it normally fails; that is expected and
   deliberately silent. If the archive really is behind, the subtitle already
   says so ("N days behind"), which is the honest signal. */
async function topUp() {
  const missing = [];
  for (let n = TODAYNUM - 1; n >= 0 && missing.length < 40; n--) if (!HISTORY.has(n)) missing.push(n);
  if (!missing.length) { liveOk = null; renderStatus(); return; }
  let got = 0;
  for (const n of missing) {
    try {
      const [num, w] = await fetchDay(n);
      remember(num, w); got++; liveOk = true;
    } catch (e) {
      if (got === 0) { liveOk = false; break; }   // blocked or offline — stop trying
    }
    await new Promise(r => setTimeout(r, 120));
  }
  if (got) { histSource = 'live'; pushHistory(); }
  renderStatus();
}

/* full backfill straight from the NYT, for when the workflow has not run */
let backfilling = false;
async function backfill() {
  if (backfilling) return;
  backfilling = true;
  const missing = [];
  for (let n = TODAYNUM - 1; n >= 0; n--) if (!HISTORY.has(n)) missing.push(n);
  let got = 0, failed = 0, lastErr = '', tick = 0;
  setMsg('Starting… 0 of ' + nf(missing.length) + ' days. Keep this screen open.');
  for (const n of missing) {
    try { const [num, w] = await fetchDay(n); remember(num, w); got++; failed = 0; }
    catch (e) { failed++; lastErr = why(e); if (failed >= 5) break; }
    if (++tick % 20 === 0) {
      histMsg = 'Fetching… ' + nf(got) + ' of ' + nf(missing.length) + ' days. Keep this screen open.';
      renderStatus();
    }
    await new Promise(r => setTimeout(r, 50));
  }
  backfilling = false;
  liveOk = got > 0;
  if (got) { histSource = 'live'; pushHistory(); }
  setMsg(got
    ? 'Done — fetched ' + nf(got) + ' days of answers.'
    : 'The New York Times refused the request (' + lastErr + '). This browser is not allowed to ask it directly, so the history has to be built by the daily task on GitHub instead.');
  if (got) compute();
}

let histMatched = 0;
function pushHistory() {
  if (!ready || !HISTORY.size) return;
  worker.postMessage({ type: 'history', pairs: [...HISTORY].map(([n, w]) => [w, n]), todayNum: TODAYNUM });
}

/* ---------- worker ---------- */
const worker = new Worker('worker.js');
worker.postMessage({ type: 'init', words: WORDS });
worker.onmessage = (e) => {
  const m = e.data;
  if (m.type === 'progress') { $('bootbar').style.width = m.p + '%'; return; }
  if (m.type === 'ready') {
    ready = true;
    $('boot').style.display = 'none';
    pushHistory();
    compute();
    return;
  }
  if (m.type === 'historyOk') { histMatched = m.matched; renderStatus(); if (ready) compute(); return; }
  if (m.token !== token) return;           // stale
  busy = false;
  if (m.type === 'result') { last = m; focusWord = m.pick; render(); }
  if (m.type === 'groupsOnly') { last.groups = m.groups; focusWord = m.pick; render(); }
};

function compute() {
  if (!ready) return;
  busy = true; token++;
  cntEl.textContent = 'working…';
  worker.postMessage({ type: 'compute', history: HIST, focus: null, useHist, rho, token });
}
function regroup(word) {
  if (!ready || busy) return;
  busy = true; token++;
  worker.postMessage({ type: 'groups', history: HIST, word, useHist, token });
}

/* ---------- helpers ---------- */
const enc = m => m[0] * 81 + m[1] * 27 + m[2] * 9 + m[3] * 3 + m[4];
const nf = n => n.toLocaleString('en-US');
function pct(p) {
  if (!(p > 1e-9)) return '0%';
  const v = p * 100;
  if (v >= 10) return v.toFixed(0) + '%';
  if (v >= 1) return v.toFixed(1) + '%';
  if (v >= 0.01) return v.toFixed(2) + '%';
  return '<0.01%';
}
function el(tag, cls, txt) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (txt != null) e.textContent = txt;
  return e;
}

/* ---------- board ---------- */
function renderBoard() {
  boardEl.textContent = '';
  HIST.forEach((h, ri) => {
    const row = el('div', 'row');
    row.appendChild(el('span', 'rowtag', String(ri + 1)));
    for (let i = 0; i < 5; i++) row.appendChild(el('div', 'tile filled g' + h.marks[i], h.guess[i]));
    boardEl.appendChild(row);
  });
  if (HIST.length < 8) {
    const row = el('div', 'row active');
    row.appendChild(el('span', 'rowtag', String(HIST.length + 1)));
    for (let i = 0; i < 5; i++) {
      const ch = input[i] || '';
      const t = el('div', 'tile' + (ch ? ' filled g' + marks[i] : ''), ch);
      if (ch) t.onclick = () => { marks[i] = (marks[i] + 1) % 3; renderBoard(); };
      row.appendChild(t);
    }
    boardEl.appendChild(row);
  }
  hintEl.textContent = input.length < 5
    ? 'Type your guess, then tap each letter to set its colour.'
    : 'Tap letters: grey → yellow → green. Then press ENTER.';
}

/* ---------- keyboard ---------- */
const ROWS = ['qwertyuiop', 'asdfghjkl', 'zxcvbnm'];
function renderKeyboard() {
  const kb = $('kb'); kb.textContent = '';
  const state = {};
  for (const h of HIST) for (let i = 0; i < 5; i++) {
    const c = h.guess[i], m = h.marks[i];
    if (state[c] === undefined || m > state[c]) state[c] = m;
  }
  ROWS.forEach((r, ri) => {
    const row = el('div', 'krow');
    if (ri === 2) { const k = el('button', 'k wide', 'Enter'); k.onclick = submit; row.appendChild(k); }
    for (const c of r) {
      const k = el('button', 'k', c);
      if (state[c] === 0) k.classList.add('dead');
      else if (state[c] === 1) k.style.background = 'var(--yellow)';
      else if (state[c] === 2) k.style.background = 'var(--green)';
      k.onclick = () => { if (input.length < 5) { input += c; marks[input.length - 1] = 0; renderBoard(); } };
      row.appendChild(k);
    }
    if (ri === 2) {
      const k = el('button', 'k wide', 'Del');
      k.onclick = () => { input = input.slice(0, -1); renderBoard(); };
      row.appendChild(k);
    }
    kb.appendChild(row);
  });
}

/* ---------- actions ---------- */
function submit() {
  if (input.length !== 5 || busy) return;
  HIST.push({ guess: input, marks: marks.slice(), pattern: enc(marks) });
  input = ''; marks = [0, 0, 0, 0, 0];
  renderBoard(); renderKeyboard();
  if (HIST[HIST.length - 1].pattern === 242) { solved(HIST[HIST.length - 1].guess); return; }
  compute();
}
function loadGuess(w) {
  input = w; marks = [0, 0, 0, 0, 0];
  renderBoard();
  $('main').scrollTop = 0;
}
function solved(word) {
  $('ovt').textContent = word.toUpperCase();
  $('ovs').textContent = 'Solved in ' + HIST.length + (HIST.length === 1 ? ' guess.' : ' guesses.');
  $('overlay').classList.add('show');
}
$('ovbtn').onclick = () => { $('overlay').classList.remove('show'); reset(); };
$('reset').onclick = reset;
$('undo').onclick = () => {
  if (input.length) { input = ''; marks = [0, 0, 0, 0, 0]; renderBoard(); return; }
  if (!HIST.length) return;
  HIST.pop(); renderBoard(); renderKeyboard(); compute();
};
function reset() {
  HIST = []; input = ''; marks = [0, 0, 0, 0, 0]; focusWord = null;
  renderBoard(); renderKeyboard(); compute();
}
document.addEventListener('keydown', e => {
  if (e.metaKey || e.ctrlKey) return;
  if (e.key === 'Enter') { submit(); e.preventDefault(); }
  else if (e.key === 'Backspace') { input = input.slice(0, -1); renderBoard(); e.preventDefault(); }
  else if (/^[a-zA-Z]$/.test(e.key) && input.length < 5) {
    input += e.key.toLowerCase(); marks[input.length - 1] = 0; renderBoard();
  }
});

/* ---------- history status + toggle ---------- */
function renderStatus() {
  const box = $('hist'); box.textContent = '';
  const top = el('div', 'histrow');
  const lab = el('div', 'histlab');
  lab.appendChild(el('span', 'histttl', 'Use Historic Info'));
  const sub = el('span', 'histsub');
  if (!HISTORY.size) {
    sub.textContent = 'No list of past answers loaded yet, so this is switched off.';
  } else {
    const known = HISTORY.size;
    let newest = -1; for (const n of HISTORY.keys()) if (n > newest) newest = n;
    sub.textContent = nf(known) + ' past answers to ' + fmtDate(newest) +
      ' · ' + nf(histMatched) + ' of them in this word list' +
      (histSource === 'live' ? ' · live' : ' · from file') +
      (newest < TODAYNUM - 1 ? ' · ' + (TODAYNUM - newest) + ' days behind' : '');
  }
  lab.appendChild(sub);
  top.appendChild(lab);

  const sw = el('button', 'switch' + (useHist ? ' on' : ''));
  sw.appendChild(el('i'));
  sw.setAttribute('aria-label', 'Use Historic Info');
  sw.onclick = () => {
    if (!HISTORY.size) return;
    useHist = !useHist; LS.set('ws_useHist', useHist);
    renderStatus(); compute();
  };
  if (!HISTORY.size) sw.classList.add('off');
  top.appendChild(sw);
  box.appendChild(top);

  if (useHist && HISTORY.size) {
    const r = el('div', 'sliderow');
    r.appendChild(el('span', 'slab', 'Chance the answer is a repeat'));
    const val = el('span', 'sval', (rho * 100).toFixed(0) + '%');
    r.appendChild(val);
    const s = document.createElement('input');
    s.type = 'range'; s.min = '0'; s.max = '25'; s.step = '1'; s.value = String(Math.round(rho * 100));
    s.oninput = () => { val.textContent = s.value + '%'; };
    s.onchange = () => { rho = +s.value / 100; LS.set('ws_rho', rho); compute(); };
    r.appendChild(s);
    box.appendChild(r);
    box.appendChild(el('div', 'histnote',
      'Observed rate since the NYT began recycling answers on 2 Feb 2026 is about 3%. Words used within the last year are treated as unavailable; older ones are weighted by age.'));
  }

  if (histMsg) box.appendChild(el('div', 'histmsg' + (/refused|not reach/.test(histMsg) ? ' bad' : ''), histMsg));

  // Offer a direct backfill whenever the archive is materially incomplete.
  const gaps = TODAYNUM - HISTORY.size;
  if (gaps > 30 && !backfilling) {
    const b = el('button', 'ghost',
      HISTORY.size ? 'Fetch the missing ' + nf(gaps) + ' days from the NYT' : 'Fetch history from the NYT now');
    b.onclick = () => { setMsg('Starting…'); backfill(); };
    box.appendChild(b);
  }
}

/* ---------- output ---------- */
function chip(w, lu, p) {
  const c = el('span', 'w tap' + (ADDED.has(w) ? ' added' : '') + (lu >= 0 ? ' used' : ''));
  c.appendChild(el('b', null, w));
  const meta = el('u', null, lu >= 0 ? fmtDate(lu) : (p != null ? pct(p) : ''));
  if (lu >= 0 && p != null) meta.textContent = fmtDate(lu) + ' · ' + pct(p);
  if (meta.textContent) c.appendChild(meta);
  c.onclick = () => loadGuess(w);
  return c;
}

function chipBlock(container, words, lus, probs, cap) {
  const add = (a, b) => {
    for (let i = a; i < b; i++) container.appendChild(chip(words[i], lus ? lus[i] : -1, probs ? probs[i] : null));
  };
  const n = Math.min(cap, words.length);
  add(0, n);
  if (words.length > n) {
    const more = el('span', 'w tap more', '+' + nf(words.length - n) + ' more');
    more.onclick = () => { more.remove(); add(n, words.length); };
    container.appendChild(more);
  }
}

function render() {
  outEl.textContent = '';
  if (!last) return;
  cntEl.innerHTML = '<b>' + nf(last.count) + '</b> left';

  if (HIST.length) {
    const g = HIST[HIST.length - 1].guess;
    const b = el('button', 'primary solvedbtn', '✓  ' + g.toUpperCase() + ' was the solution — finish');
    b.onclick = () => solved(g);
    outEl.appendChild(b);
  }

  if (last.count === 0) {
    const p = el('div', 'panel');
    p.appendChild(el('h2', null, 'No matches'));
    p.appendChild(el('div', 'big err', 'Nothing fits'));
    p.appendChild(el('div', 'sub', 'No word in the 2,486-word list matches every clue you entered. Most likely a tile colour is wrong, or the real answer is not in this list. Tap Undo to change the last guess.'));
    outEl.appendChild(p);
    return;
  }

  /* possible solutions, split into never-used and previously-used */
  const p1 = el('div', 'panel');
  p1.appendChild(el('h2', null, HIST.length ? 'Possible solutions' : 'Starting pool'));
  p1.appendChild(el('div', 'big', nf(last.count)));

  let split = last.words.length;
  for (let i = 0; i < last.lastUsed.length; i++) if (last.lastUsed[i] >= 0) { split = i; break; }
  /* Switching Use Historic Info off has to remove the distinction entirely —
     no two sections, no dates on the chips, no probabilities. The worker
     already returns a plain alphabetical pool with lastUsed all -1 in that
     case; this just picks the matching presentation. */
  const showHist = useHist && HISTORY.size > 0;
  const nNew = split, nUsed = last.words.length - split;
  let pNew = 0; for (let i = 0; i < split; i++) pNew += last.probs[i];

  p1.appendChild(el('div', 'sub', last.count === 1
    ? 'Only one word fits — that is the answer.'
    : (showHist
      ? 'Never-used words first, then previous answers oldest to most recent. Percentages are each word’s chance of being today’s answer. Tap a word to load it as your next guess.'
      : 'Words still consistent with every clue, alphabetically. Tap a word to load it as your next guess.')));

  if (!showHist) {
    const wrap = el('div', 'wordwrap');
    chipBlock(wrap, last.words, null, null, 240);
    p1.appendChild(wrap);
  } else {
    if (nNew) {
      p1.appendChild(el('div', 'seg', 'Never been an answer — ' + nf(nNew) + ' word' + (nNew === 1 ? '' : 's') + ' · ' + pct(pNew) + ' total'));
      const w1 = el('div', 'wordwrap');
      chipBlock(w1, last.words.slice(0, split), last.lastUsed.slice(0, split), last.probs.slice(0, split), 180);
      p1.appendChild(w1);
    }
    if (nUsed) {
      p1.appendChild(el('div', 'seg', 'Previously an answer — ' + nf(nUsed) + ' word' + (nUsed === 1 ? '' : 's') + ' · ' + pct(1 - pNew) + ' total · oldest first'));
      const w2 = el('div', 'wordwrap');
      chipBlock(w2, last.words.slice(split), last.lastUsed.slice(split), last.probs.slice(split), 180);
      p1.appendChild(w2);
    }
  }
  outEl.appendChild(p1);

  if (last.count === 1) return;

  /* suggestions */
  const p2 = el('div', 'panel');
  p2.appendChild(el('h2', null, (HIST.length ? 'Best next guess' : 'Best opening guess') + (useHist ? ' · historic weighting on' : '')));
  const hmax = last.suggestions[0].H || 1;
  last.suggestions.forEach((s, i) => {
    const row = el('div', 'sug' + (i === 0 ? ' best' : ''));
    row.appendChild(el('span', 'rank', String(i + 1)));
    row.appendChild(el('span', 'word', s.word));
    const meta = el('span', 'meta');
    meta.innerHTML = s.H.toFixed(3) + ' bits &middot; ~' + s.exp.toFixed(1) +
      ' left &middot; worst case ' + nf(s.worst) +
      (s.isCand ? ' &middot; <span style="color:#7ec06f">could be the answer</span>' : '');
    const bar = el('span', 'bar'); const fill = el('i');
    fill.style.width = Math.max(4, s.H / hmax * 100) + '%';
    bar.appendChild(fill); meta.appendChild(bar);
    row.appendChild(meta);
    row.appendChild(el('span', 'go', 'USE'));
    row.onclick = (ev) => {
      if (ev.target.className === 'go' || s.word === focusWord) { loadGuess(s.word); return; }
      regroup(s.word);
    };
    p2.appendChild(row);
  });
  p2.appendChild(el('div', 'sub', useHist
    ? 'Ranked by information gained, with each word weighted by its chance of being the answer. Tap a row to see how it splits the pool; tap USE to play it.'
    : 'Ranked by information gained (entropy), treating every remaining word as equally likely. Tap a row to see how it splits the pool; tap USE to play it.'));
  outEl.appendChild(p2);

  /* pattern groups */
  if (HIST.length && last.groups && last.groups.length) {
    const p3 = el('div', 'panel');
    p3.appendChild(el('h2', null, 'If you guess ' + focusWord.toUpperCase() + ' — ' + last.groups.length + ' outcomes'));
    const cap = 60;
    last.groups.slice(0, cap).forEach(g => {
      const box = el('div', 'grp');
      const head = el('div', 'grphead');
      const mini = el('div', 'mini');
      for (let i = 0; i < 5; i++) mini.appendChild(el('i', 'g' + g.pattern[i], focusWord[i]));
      head.appendChild(mini);
      const n = el('span', 'n');
      n.innerHTML = '<b>' + nf(g.words.length) + '</b> word' + (g.words.length === 1 ? '' : 's');
      head.appendChild(n);
      head.appendChild(el('span', 'caret', '▾'));
      const body = el('div', 'grpbody');
      const bw = el('div', 'wordwrap');
      chipBlock(bw, g.words, useHist && HISTORY.size ? g.lastUsed : null, null, 120);
      body.appendChild(bw);
      head.onclick = () => box.classList.toggle('open');
      box.appendChild(head); box.appendChild(body);
      if (g.words.length <= 6) box.classList.add('open');
      p3.appendChild(box);
    });
    if (last.groups.length > cap) p3.appendChild(el('div', 'sub', '+' + (last.groups.length - cap) + ' smaller outcome groups not shown.'));
    p3.appendChild(el('div', 'sub', 'Each group is one colour pattern Wordle could show you, and the words that would still be possible after it.'));
    outEl.appendChild(p3);
  }
}

/* ---------- boot ---------- */
renderBoard();
renderKeyboard();
renderStatus();
loadHistory();
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}
