// A step's run. The extension posts the whole state after every change; this draws it and sends back what you do.
// It opens as the spec's editor did, the step alone, then slides into two columns: the live step and the conversation.
const vscode = acquireVsCodeApi();
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
let state;
let follow = true; // keep the conversation scrolled to the newest message
const openDiffs = new Set(); // files whose changes you unfolded
let changesOpen = true; // the Changes section, until you fold it
let moving = false; // the Accept transition is playing

window.addEventListener('message', (e) => {
  if (e.data.type === 'commitMessage') return void ($('message').value = e.data.text);
  const finishing = state && !reviewing(state) && reviewing(e.data);
  state = e.data;
  vscode.setState({ key: state.key }); // so the tab comes back on this step after a reload
  // Done: the changes move over to where the conversation was and become the main view, animated by the browser. Updates
  // that come in while it plays wait for it: redrawing replaces the elements it is moving, which cuts it off.
  if (moving) return;
  if (finishing && !document.startViewTransition) log('done: no view transitions here, so no animation');
  if (finishing && document.startViewTransition) {
    moving = true;
    log(`done: transition starts${document.hidden ? ', but the tab is hidden' : ''}`);
    const move = document.startViewTransition(draw);
    move.ready.then(() => log('done: transition playing'), (e) => log(`done: transition skipped: ${e}`));
    move.finished.finally(() => {
      moving = false;
      log('done: transition done');
      draw(); // the latest state, held back while it moved
    });
  } else draw();
  // The morph: drawn once as the editor it replaces, then opened up next frame so the columns animate.
  if (document.body.classList.contains('writing')) requestAnimationFrame(() => setTimeout(() => document.body.classList.replace('writing', 'running'), 80));
});

// Into the LLMD output channel: what a webview does is otherwise invisible.
const log = (text) => vscode.postMessage({ type: 'log', text });
window.addEventListener('error', (e) => log(`error: ${e.message}`));

// Once the step is done, the run is the review of what it changed.
const reviewing = (s) => !!s.done;

function draw() {
  drawBar();
  drawStep();
  drawChat();
  const input = $('input');
  input.placeholder = state.working ? 'Claude is working. Type your next message…' : 'Reply to Claude, or ask about this step';
  const send = $('send');
  send.textContent = state.working ? '■' : '↑';
  send.title = state.working ? 'Stop' : 'Send (Enter)';
  send.classList.toggle('stop', state.working);
}

function status() {
  if (state.working) return ['busy', state.mode === 'plan' ? 'Planning' : 'Implementing'];
  if (state.done) return ['done', 'Done'];
  if (state.ticked) return ['wait', state.missing.length ? 'Ticked, not in the code yet' : 'Built, review and mark done'];
  if (state.messages.length) return ['wait', state.mode === 'plan' ? 'Plan ready, your turn' : 'Waiting for you'];
  return ['idle', 'Not started'];
}

function drawBar() {
  const [kind, text] = status();
  const open = !state.working && !state.ticked && !state.done;
  // Done is there once Claude ticked the step and the code has everything it lists.
  const finish = !state.working && state.ticked && !state.missing.length && !state.done;
  $('bar').innerHTML = `<span class="crumb">${esc(state.file)}</span><span class="sep">›</span><h1>${esc(state.step)}</h1>
    <span class="status ${kind}"><span class="pip"></span>${esc(text)}</span><span class="grow"></span>
    ${open ? '<button class="primary" data-act="implement">▶ Implement</button><button data-act="plan">Plan</button>' : ''}
    ${finish ? '<button class="primary" data-act="done" title="Take the step out of the spec: the code has it now">✓ Done</button>' : ''}
    ${state.working ? '<button data-act="stop">■ Stop</button>' : ''}
    ${state.done ? '' : '<button data-act="edit" title="Back to the spec, at this step">Edit spec</button>'}`;
}

// The step as it is in the spec now, with what changed since its run started: added lines green, removed ones struck.
function drawStep() {
  const rows = state.before ? diff(state.before, state.lines) : state.lines.map((t) => ['same', t]);
  let n = 0;
  const lines = rows.map(([change, text]) =>
    `<div class="row ${change}"><span class="num">${change === 'del' ? '' : ++n}</span><span class="mark">${change === 'add' ? '+' : change === 'del' ? '−' : ''}</span>${line(text)}</div>`).join('');
  const changes = state.git ? diffs() : state.files.length
    ? `<div class="changes"><h2>Changed files</h2><p class="hint">Not a git repository, so only the names. Run <code>git init</code> and commit, and the next step shows its changes here.</p>${state.files.map((f) => `<button class="file" data-act="file" data-path="${esc(f.path)}">${esc(f.name)}</button>`).join('')}</div>`
    : '';
  // Once it's done, what the step changed is the main view, with the commit and what to build next.
  const review = reviewing(state);
  if (review && !document.body.classList.contains('reviewing')) state.diffs.forEach((d) => openDiffs.add(d.path));
  document.body.classList.toggle('reviewing', review);
  if (review) drawReview(state.git ? diffs() : changes);
  // A tick the code doesn't back says what's missing, under the step.
  const note = state.done ? '<p class="note">Done, and out of the spec: the code has it now. The lines above are how the step looked.</p>'
    : state.missing.length ? `<p class="note missing">Ticked, but not in the code yet:</p><ul class="missing">${state.missing.map((m) => `<li>${esc(m)}</li>`).join('')}</ul>` : '';
  $('step').innerHTML = `${review ? next() : ''}<div class="code${state.done ? ' folded' : ''}">${lines}</div>${note}${review ? '' : changes}`;
}

function drawReview(changes) {
  $('commit').hidden = !state.git || !state.diffs.length || !!state.committed;
  const write = $('commit').querySelector('[data-act="write"]');
  write.disabled = state.drafting || !state.done; // the commit waits for the step to be done
  $('commitButton').disabled = !state.done;
  write.textContent = state.drafting ? 'Claude is writing…' : '✨ Write with Claude';
  $('committed').innerHTML = state.committed ? `<span class="tick">✓</span> Committed <code>${esc(state.committed)}</code>` : '';
  $('landed').innerHTML = changes || `<p class="hint">${state.git ? 'No files changed since the step\'s run started, so there\'s nothing to commit.' : 'Not a git repository, so there are no changes to show or commit.'}</p>`;
}

// What to build next, above the step you just finished: the open steps, then a new feature.
function next() {
  return '<div class="nextup"><h2>Next</h2>' + state.next.map((n) =>
    `<button class="next" data-act="next" data-spec="${esc(n.spec)}" data-step="${esc(n.step)}"><span>▶</span>${esc(n.step)}<span class="where">${esc(n.where)}</span></button>`).join('') +
    '<button class="next" data-act="newFeature"><span>+</span>New feature</button></div>';
}

// The step's changes, a section you can fold, one foldable file each: git's diff since the run started, highlighted.
function diffs() {
  if (!state.diffs.length) return '';
  const total = (key) => state.diffs.reduce((n, d) => n + d[key], 0);
  return `<details class="changes"${changesOpen ? ' open' : ''}><summary><span class="chev">›</span>Changes
    <span class="stat"><span class="plus">+${total('added')}</span> <span class="minus">−${total('removed')}</span></span><span class="grow"></span>
    <button class="link" data-act="changes" title="All the changes in VS Code's diff editor">Open all</button>
    <button class="link" data-act="refresh" title="Read the changes from git again">Refresh</button></summary>` +
    state.diffs.map((d) => `<details class="diff" data-path="${esc(d.path)}"${openDiffs.has(d.path) ? ' open' : ''}>
      <summary><span class="chev">›</span><span class="name">${esc(d.name)}</span><span class="stat"><span class="plus">+${d.added}</span> <span class="minus">−${d.removed}</span></span>
      <button class="link" data-act="file" data-path="${esc(d.path)}" title="This file's changes in VS Code's diff editor">Open</button></summary>${hunks(d)}</details>`).join('') + '</details>';
}

// A unified diff as rows: hunk headers, then each line with its old or new number, its code highlighted by the extension.
// File headers are left out.
function hunks(d) {
  const rows = [];
  let a = 0;
  let b = 0;
  let [i, j] = [0, 0]; // the next highlighted old and new line
  let inHunk = false;
  for (const l of d.diff.split('\n')) {
    const h = l.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)/);
    if (h) {
      [a, b, inHunk] = [Number(h[1]), Number(h[2]), true];
      rows.push(`<div class="drow hunk"><span></span><span></span><span>${esc(h[3].trim() || '…')}</span></div>`);
    } else if (inHunk && l.startsWith('+')) rows.push(`<div class="drow add"><span></span><span>${b++}</span><span>${d.new[j++] || ' '}</span></div>`);
    else if (inHunk && l.startsWith('-')) rows.push(`<div class="drow del"><span>${a++}</span><span></span><span>${d.old[i++] || ' '}</span></div>`);
    else if (inHunk && l.startsWith(' ')) i++, rows.push(`<div class="drow"><span>${a++}</span><span>${b++}</span><span>${d.new[j++] || ' '}</span></div>`);
  }
  if (!rows.length) rows.push('<div class="drow hunk"><span></span><span></span><span>No text changes to show</span></div>');
  // ponytail: very long diffs are cut; Open shows the rest in the editor
  const shown = rows.length > 400 ? rows.slice(0, 400).concat('<div class="drow hunk"><span></span><span></span><span>… more in Open</span></div>') : rows;
  return `<div class="dlines">${shown.join('')}</div>`;
}

// One spec line, colored like the editor colors .llmd files.
function line(text) {
  if (!text.trim()) return '<span class="l"></span>';
  const kind = /^\s*\/\//.test(text) ? 'comment' : /^\s*\?/.test(text) ? 'question' : /^\s*!\s/.test(text) ? 'check'
    : /^\s*\*\s/.test(text) ? 'free' : /^\s*~?[@+][\w\-./]+\s*$/.test(text) ? 'unit' : /^\s*(?:-\s+)?:\s*\w/.test(text) ? 'type'
    : /^#/.test(text) ? 'heading' : /^\s*-\s+~/.test(text) ? 'removed' : 'plain';
  let html = esc(text).replace(/(^|[^\w@])(@[\w\-./]+)/g, '$1<span class="ref">$2</span>');
  if (kind === 'plain') html = html.replace(/^(\s*-\s+(?:\[[ xX]\]\s+)?(?:\([^)]*\)\s*)?)([A-Za-z_]\w*)(?=\()/, '$1<span class="method">$2</span>');
  if (kind === 'heading') html = html.replace(/\[[xX]\]/, '<span class="tick">✓</span>');
  return `<span class="l k-${kind}">${html}</span>`;
}

// Line diff by longest common subsequence: [change, text] rows, change being 'same', 'add' or 'del'.
function diff(a, b) {
  const t = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) t[i][j] = a[i] === b[j] ? t[i + 1][j + 1] + 1 : Math.max(t[i + 1][j], t[i][j + 1]);
  const rows = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) rows.push(['same', b[j++]]), i++;
    else if (t[i + 1][j] >= t[i][j + 1]) rows.push(['del', a[i++]]);
    else rows.push(['add', b[j++]]);
  }
  while (i < a.length) rows.push(['del', a[i++]]);
  while (j < b.length) rows.push(['add', b[j++]]);
  return rows;
}

function drawChat() {
  const log = $('log');
  const messages = state.messages.map((m, i) => `<div class="msg ${m.who}">${parts(m.parts, i, i === state.messages.length - 1)}</div>`).join('');
  log.innerHTML = (messages || `<div class="empty"><p>Ask Claude about this step, or click <b>▶ Implement</b> to build it.</p></div>`) +
    (state.working ? '<div class="working"><span></span><span></span><span></span></div>' : '');
  if (follow) log.scrollTop = log.scrollHeight;
}

// A message's parts, with runs of more than three tool calls folded into one "N actions" line. A refused tool call
// gets Allow, which adds it to the project's Claude settings, and the last message gets Continue once something is allowed.
function parts(list, message, last) {
  const out = [];
  for (let i = 0; i < list.length;) {
    if (list[i].kind !== 'tool') {
      const p = list[i];
      const allow = p.allow ? (p.allowed
        ? '<span class="allowed">✓ Allowed</span>'
        : `<button class="allow" data-act="allow" data-message="${message}" data-part="${i}" title="Allow ${esc(p.allow.join(', '))}">Allow</button>`) : '';
      out.push(`<div class="part ${p.kind}">${p.html}${allow}</div>`);
      i++;
      continue;
    }
    let j = i;
    while (j < list.length && list[j].kind === 'tool') j++;
    const tools = list.slice(i, j).map((p) => `<div class="part tool">${p.html}</div>`).join('');
    out.push(j - i > 3 ? `<details class="tools"><summary>${j - i} actions <span>· ${list[j - 1].html}</span></summary>${tools}</details>` : tools);
    i = j;
  }
  if (last && !state.working && list.some((p) => p.allowed)) out.push('<button class="continue" data-act="continue">Continue with what you allowed</button>');
  return out.join('');
}

document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-act]');
  if (!el) return;
  if (el.closest('summary')) e.preventDefault(); // a button in a file's title doesn't fold the file
  const act = el.dataset.act;
  if (act === 'implement' || act === 'plan') {
    follow = true;
    vscode.postMessage({ type: 'run', mode: act });
  }
  if (act === 'stop') vscode.postMessage({ type: 'stop' });
  if (act === 'edit') vscode.postMessage({ type: 'edit' });
  if (act === 'done') vscode.postMessage({ type: 'done' });
  if (act === 'refresh') vscode.postMessage({ type: 'refresh' });
  if (act === 'changes') vscode.postMessage({ type: 'changes' });
  if (act === 'write') vscode.postMessage({ type: 'write' });
  if (act === 'next') vscode.postMessage({ type: 'next', spec: el.dataset.spec, step: el.dataset.step });
  if (act === 'newFeature') vscode.postMessage({ type: 'newFeature' });
  if (act === 'allow') vscode.postMessage({ type: 'allow', message: Number(el.dataset.message), part: Number(el.dataset.part) });
  if (act === 'continue') {
    follow = true;
    vscode.postMessage({ type: 'continue' });
  }
  if (act === 'file') vscode.postMessage({ type: 'file', path: el.dataset.path });
});

// Folded and unfolded stay that way when the run redraws.
document.addEventListener('toggle', (e) => {
  const d = e.target;
  if (d.matches?.('details.diff')) d.open ? openDiffs.add(d.dataset.path) : openDiffs.delete(d.dataset.path);
  if (d.matches?.('details.changes')) changesOpen = d.open;
}, true);

$('log').addEventListener('scroll', () => {
  const log = $('log');
  follow = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
});

const input = $('input');
const grow = () => {
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, 200) + 'px';
};
input.addEventListener('input', grow);
input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    $('composer').requestSubmit();
  }
});
$('composer').addEventListener('submit', (e) => {
  e.preventDefault();
  // While Claude works, the button stops it; Enter leaves your next message where it is.
  if (state?.working) return e.submitter === $('send') && vscode.postMessage({ type: 'stop' });
  const text = input.value.trim();
  if (!text) return;
  follow = true;
  vscode.postMessage({ type: 'send', text });
  input.value = '';
  grow();
});

// The commit: Cmd/Ctrl+Enter commits, Enter is a new line of the message.
$('message').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) $('commit').requestSubmit();
});
$('commit').addEventListener('submit', (e) => {
  e.preventDefault();
  const text = $('message').value.trim();
  if (text) vscode.postMessage({ type: 'commit', text });
});

vscode.postMessage({ type: 'ready' });
