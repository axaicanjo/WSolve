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

/* ---------- worker ---------- */
const worker = new Worker('worker.js');
worker.postMessage({ type: 'init', words: WORDS });
worker.onmessage = (e) => {
  const m = e.data;
  if (m.type === 'progress') { $('bootbar').style.width = m.p + '%'; return; }
  if (m.type === 'ready') {
    ready = true;
    $('boot').style.display = 'none';
    compute();
    return;
  }
  if (m.token !== token) return;           // stale
  busy = false;
  if (m.type === 'result') { last = m; focusWord = m.pick; render(); }
  if (m.type === 'groupsOnly') { last.groups = m.groups; focusWord = m.pick; render(); }
};

function compute() {
  if (!ready) return;
  busy = true; token++;
  cntEl.textContent = 'working…';
  worker.postMessage({ type: 'compute', history: HIST, focus: null, token });
}
function regroup(word) {
  if (!ready || busy) return;
  busy = true; token++;
  worker.postMessage({ type: 'groups', history: HIST, word, token });
}

/* ---------- helpers ---------- */
const enc = m => m[0] * 81 + m[1] * 27 + m[2] * 9 + m[3] * 3 + m[4];
const nf = n => n.toLocaleString('en-US');
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
    for (let i = 0; i < 5; i++) {
      const t = el('div', 'tile filled g' + h.marks[i], h.guess[i]);
      row.appendChild(t);
    }
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
    if (ri === 2) {
      const k = el('button', 'k wide', 'Enter');
      k.onclick = submit; row.appendChild(k);
    }
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
  window.scrollTo(0, 0);
  $('main').scrollTop = $('main').scrollHeight;
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

/* ---------- output ---------- */
function wordChips(list, container, cap) {
  const show = list.slice(0, cap);
  for (const w of show) {
    const c = el('span', 'w tap' + (ADDED.has(w) ? ' added' : ''), w);
    c.onclick = () => loadGuess(w);
    container.appendChild(c);
  }
  if (list.length > cap) {
    const more = el('span', 'w tap', '+' + nf(list.length - cap) + ' more');
    more.onclick = () => {
      more.remove();
      for (const w of list.slice(cap)) {
        const c = el('span', 'w tap' + (ADDED.has(w) ? ' added' : ''), w);
        c.onclick = () => loadGuess(w);
        container.appendChild(c);
      }
    };
    container.appendChild(more);
  }
}

function render() {
  outEl.textContent = '';
  if (!last) return;
  cntEl.innerHTML = '<b>' + nf(last.count) + '</b> left';

  /* solved button for the guess just made */
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
    p.appendChild(el('div', 'sub', 'No word in the 2,458-word list matches every clue you entered. Most likely a tile colour is wrong, or the real answer is not in this list. Tap Undo to change the last guess.'));
    outEl.appendChild(p);
    return;
  }

  /* possible solutions */
  const p1 = el('div', 'panel');
  p1.appendChild(el('h2', null, HIST.length ? 'Possible solutions' : 'Starting pool'));
  p1.appendChild(el('div', 'big', nf(last.count)));
  p1.appendChild(el('div', 'sub', last.count === 1
    ? 'Only one word fits — that is the answer.'
    : 'words still consistent with every clue. Green-outlined words are the 143 added candidates. Tap any word to load it as your next guess.'));
  const wrap = el('div', 'wordwrap');
  wordChips(last.words, wrap, 240);
  p1.appendChild(wrap);
  outEl.appendChild(p1);

  if (last.count === 1) return;

  /* suggestions */
  const p2 = el('div', 'panel');
  p2.appendChild(el('h2', null, HIST.length ? 'Best next guess' : 'Best opening guess'));
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
      if (ev.target.className === 'go') { loadGuess(s.word); return; }
      if (s.word === focusWord) { loadGuess(s.word); return; }
      regroup(s.word);
    };
    p2.appendChild(row);
  });
  p2.appendChild(el('div', 'sub', 'Ranked by information gained (entropy). Tap a row to see how it splits the pool; tap USE to play it.'));
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
      for (let i = 0; i < 5; i++) {
        const t = el('i', 'g' + g.pattern[i], focusWord[i]);
        mini.appendChild(t);
      }
      head.appendChild(mini);
      const n = el('span', 'n');
      n.innerHTML = '<b>' + nf(g.words.length) + '</b> word' + (g.words.length === 1 ? '' : 's');
      head.appendChild(n);
      const caret = el('span', 'caret', '▾');
      head.appendChild(caret);
      const body = el('div', 'grpbody');
      const bw = el('div', 'wordwrap');
      wordChips(g.words, bw, 120);
      body.appendChild(bw);
      head.onclick = () => box.classList.toggle('open');
      box.appendChild(head); box.appendChild(body);
      if (g.words.length <= 6) box.classList.add('open');
      p3.appendChild(box);
    });
    if (last.groups.length > cap) {
      p3.appendChild(el('div', 'sub', '+' + (last.groups.length - cap) + ' smaller outcome groups not shown.'));
    }
    p3.appendChild(el('div', 'sub', 'Each group is one colour pattern Wordle could show you, and the words that would still be possible after it.'));
    outEl.appendChild(p3);
  }
}

/* ---------- boot ---------- */
renderBoard();
renderKeyboard();
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}
