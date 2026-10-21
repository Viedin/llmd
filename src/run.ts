import { ChildProcess, execFile, spawn } from 'child_process';
import { randomUUID } from 'crypto';
import * as path from 'path';
import * as vscode from 'vscode';
import { AGENTS, AgentId, agentArgs, Part, render, startedIn, stepPrompt, terminalArgs } from './agent';
import { freshSpans, missing, onDidChangeCode, typeSpansOf, whereNames } from './code';
import { openSteps, questionsOf, stepSection } from './outline';
import { projectOf } from './refs';
import { themeCss } from './theme';

// A step's run. Implement or Plan turns the spec's editor into the step's own chat, in the same spot: the step stays on the
// left, live as the agent edits it, and the conversation is on the right. Each step is one fresh session of the agent, Claude
// or Codex, run headless. The plan is intent and the code is the proof: once the agent ticks the step and the code has what
// it lists, Done takes it out of the spec, and the run becomes its review.

// @paths resolve from the project: the folder holding .llmd/, else the workspace folder, like Claude Code's @ mentions.
export function rootOf(uri: vscode.Uri): vscode.Uri {
  const project = projectOf(uri.fsPath);
  if (project) return vscode.Uri.file(project);
  const ws = vscode.workspace.getWorkspaceFolder(uri);
  return ws ? ws.uri : vscode.Uri.file(path.dirname(uri.fsPath));
}

// The agent picked in the settings: its id, its name and the command that starts it, split into words.
// shortcut: the command's flags can't hold quoted spaces
export function agent() {
  const settings = vscode.workspace.getConfiguration('llmd');
  const id: AgentId = settings.get('agent') === 'codex' ? 'codex' : 'claude';
  const [program, ...flags] = (settings.get<string>(`${id}Command`) || AGENTS[id].command).trim().split(/\s+/);
  return { id, name: AGENTS[id].name, program, flags };
}

// Where a step's session with an agent is kept. Claude's is under the key it always had.
const sessionKey = (id: AgentId, key: string) => `session ${id === 'claude' ? '' : id + ' '}${key}`;

interface Message {
  who: 'you' | 'claude';
  parts: { kind: Part['kind']; html: string; file?: string; allow?: string[]; allowed?: boolean }[];
}

// One file's changes since the step's run started, from git, with its old and new lines highlighted.
interface Diff {
  path: string;
  name: string;
  file: string; // its path in the repository
  status: string; // git's A, M or D
  diff: string;
  added: number;
  removed: number;
  old: string[]; // the old side's lines as HTML, in the diff's order: context and removed lines
  new: string[]; // the new side's: context and added lines
}

export interface Run {
  spec: vscode.Uri;
  step: string;
  messages: Message[];
  before?: string[]; // the step's lines when its first run started, so you see what the agent changed
  last?: string[]; // the step's lines when it was last seen in the spec, shown once it's out of it
  mode?: 'implement' | 'plan';
  done?: boolean; // the step is built and out of the spec: the run is its review
  base?: string; // the git tree of the working tree when the step's first run started, if it was a repository then
  repo?: { top: string; base: string }; // the repository and the tree its diffs are from, once they're read
  diffs?: Diff[];
  drafting?: boolean; // the agent is writing the commit message
  committed?: string; // "<hash> <subject>" once the step's changes are committed
  child?: ChildProcess;
  pty?: Pty; // the agent's CLI, when the step runs in a terminal
  screen?: string; // what it wrote, for the tab to draw again
  size?: [number, number]; // the terminal's columns and rows in the tab
  stopped?: boolean;
  panel?: vscode.WebviewPanel;
}

// A process in a terminal of its own, from node-pty.
interface Pty {
  onData(listener: (data: string) => void): void;
  onExit(listener: (e: { exitCode: number }) => void): void;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
}

const terminalMode = () => vscode.workspace.getConfiguration('llmd').get('runIn') === 'terminal';

export const runs = new Map<string, Run>(); // "<spec uri>#<step>" → its run
let state: vscode.Memento; // per step: its session with each agent and its run (messages and the step as it was)
let media: vscode.Uri;
let log: vscode.LogOutputChannel; // the LLMD output channel: what the runs' tabs report, like how Accept's animation went

export const runKey = (spec: vscode.Uri, step: string) => `${spec.toString()}#${step}`;
export const specPath = (uri: vscode.Uri) => path.relative(rootOf(uri).fsPath, uri.fsPath).split(path.sep).join('/');
const escape = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

export function runOf(spec: vscode.Uri, step: string): Run {
  const key = runKey(spec, step);
  let run = runs.get(key);
  if (!run) {
    const saved = state.get<Pick<Run, 'messages' | 'before' | 'last' | 'mode' | 'done' | 'base' | 'committed'>>('run ' + key);
    runs.set(key, (run = { spec, step, messages: [], ...saved }));
  }
  return run;
}

// A step with a run to go back to: one that's open, working, or has talked before. A done run is history, not the run of
// a step that has its title now.
export const hasRun = (spec: vscode.Uri, step: string) => {
  const key = runKey(spec, step);
  const run = runs.get(key) ?? state.get<Pick<Run, 'done'>>('run ' + key);
  return !!run && !run.done;
};

// A new step with a done step's title, like another "Test", starts its own run: a fresh chat and session.
function restart(run: Run) {
  if (!run.done) return;
  Object.assign(run, { messages: [], before: undefined, last: undefined, mode: undefined, done: undefined, base: undefined, repo: undefined,
    diffs: undefined, committed: undefined });
  for (const id of Object.keys(AGENTS) as AgentId[]) state.update(sessionKey(id, runKey(run.spec, run.step)), undefined);
  save(run);
  post(run);
}

const save = (run: Run) =>
  state.update('run ' + runKey(run.spec, run.step), { messages: run.messages, before: run.before, last: run.last, mode: run.mode, done: run.done, base: run.base,
    committed: run.committed });

// Markdown through VS Code's own renderer, the one the markdown preview uses; plain text if it isn't there.
async function toHtml(part: Part) {
  if (part.kind !== 'text') return { kind: part.kind, html: escape(part.text), file: part.file, allow: part.allow };
  try {
    const html = await vscode.commands.executeCommand<string>('markdown.api.render', part.text);
    return { kind: part.kind, html: html.replace(/<span id="markdown-mermaid"[^>]*><\/span>\s*/, '') }; // the preview's mermaid config, not content
  } catch {
    return { kind: part.kind, html: `<p>${escape(part.text)}</p>` };
  }
}

// The spec as you see it: the editor's text while it has unsaved edits, else the file, which the agent edits. Not the
// editor's otherwise: an editor keeps a deleted spec's text, and the step would look like it's still there.
async function specText(uri: vscode.Uri): Promise<string | undefined> {
  const open = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
  return open?.isDirty ? open.getText() : readFile(uri);
}

const colored = new Map<string, { text: string; marks: Promise<[number, number, number, string][]> }>(); // by spec

// What the editor colors in a spec beyond its grammar, as [line, start, end, class]: the code's types, and the names the
// code doesn't have yet. Kept until the spec's text or the code changes.
function marksOf(spec: vscode.Uri, text: string) {
  let hit = colored.get(spec.toString());
  if (hit?.text !== text) {
    const root = rootOf(spec);
    const marks = Promise.all([typeSpansOf(root, text), freshSpans(root, text)]).then(([types, fresh]) => [
      ...types.map((s) => [s.line, s.start, s.end, 't-sem-type'] as [number, number, number, string]),
      ...fresh.map((s) => [s.line, s.start, s.end, 't-new'] as [number, number, number, string]),
    ]);
    colored.set(spec.toString(), (hit = { text, marks }));
  }
  return hit.marks;
}

// The file of the color theme you have on.
export function themeFile(): string | undefined {
  const auto = vscode.workspace.getConfiguration('window').get<boolean>('autoDetectColorScheme');
  const kind = vscode.window.activeColorTheme.kind;
  const setting = !auto ? 'colorTheme' : kind === vscode.ColorThemeKind.Light ? 'preferredLightColorTheme'
    : kind === vscode.ColorThemeKind.HighContrast ? 'preferredHighContrastColorTheme'
    : kind === vscode.ColorThemeKind.HighContrastLight ? 'preferredHighContrastLightColorTheme' : 'preferredDarkColorTheme';
  const id = vscode.workspace.getConfiguration('workbench').get<string>(setting);
  for (const ext of vscode.extensions.all) {
    const theme = (ext.packageJSON?.contributes?.themes ?? []).find((t: any) => t.id === id || t.label === id);
    if (theme?.path) return path.join(ext.extensionPath, theme.path);
  }
}

// The step on the left in the editor's colors, which the theme's file has.
const postTheme = (run: Run) => run.panel?.webview.postMessage({ type: 'theme', css: themeCss(themeFile()) });

async function post(run: Run) {
  const text = await specText(run.spec);
  // A done run shows the step as it was, whatever has its title in the spec now.
  const section = text === undefined || run.done ? undefined : stepSection(text, run.step);
  if (section) run.last = section.lines;
  // A ticked step that left its spec, taken out by hand, is done too.
  if (!section && !run.done && run.last && /^##\s+\[[xX]\]/.test(run.last[0])) {
    run.done = true;
    save(run);
  }
  if (!run.panel) return;
  const root = rootOf(run.spec).fsPath;
  const ticked = !!section?.done;
  run.panel.webview.postMessage({
    key: runKey(run.spec, run.step),
    step: run.step,
    file: specPath(run.spec),
    lines: section?.lines ?? run.last ?? [],
    // The editor's colors beyond the grammar, for the step's lines as they are now.
    marks: section ? (await marksOf(run.spec, text!)).filter(([l]) => l >= section.line && l < section.line + section.lines.length)
      .map(([l, s, e, c]) => [l - section.line, s, e, c]) : [],
    questions: section ? questionsOf(section.lines.join('\n')) : [], // to answer by clicking, as in the editor
    before: run.before,
    ticked,
    missing: ticked && !run.child ? await missing(rootOf(run.spec), section!.lines) : [], // what the code doesn't back yet
    done: !!run.done,
    mode: run.mode,
    working: !!run.child,
    terminal: terminalMode(),
    live: !!run.pty, // its terminal is open: you talk to the agent there, and can still pick answers and click Done
    agent: agent().name,
    drafting: !!run.drafting,
    committed: run.committed,
    next: run.done ? (await nextSteps(rootOf(run.spec))).slice(0, 8) : [],
    messages: run.messages,
    git: !!run.repo,
    diffs: run.diffs ?? [],
    files: edited(run).map((f) => ({ path: f, name: path.relative(root, f) })),
  });
}

// The files the agent edited in this run, the spec itself left out: the step on the left shows that.
const edited = (run: Run) => [...new Set(run.messages.flatMap((m) => m.parts.map((p) => p.file)))]
  .filter((f): f is string => !!f && !/[\\/]\.llmd[\\/]/.test(f));

// git in the project: its output, or undefined when it fails, as outside a repository.
function git(cwd: string, args: string[], env?: NodeJS.ProcessEnv): Promise<string | undefined> {
  return new Promise((resolve) => execFile('git', args, { cwd, env, maxBuffer: 64 << 20 }, (err, stdout) => resolve(err ? undefined : stdout)));
}

// The working tree as a git tree: uncommitted and untracked files in, ignored ones out. It goes through an index of its
// own, so yours stays as it is. undefined outside a repository.
// ponytail: hashes every file that isn't ignored, so a big folder missing from .gitignore makes it slow
async function snapshot(cwd: string): Promise<string | undefined> {
  const index = (await git(cwd, ['rev-parse', '--git-path', 'llmd-index']))?.trim();
  if (!index) return undefined;
  const env = { ...process.env, GIT_INDEX_FILE: path.resolve(cwd, index) };
  if ((await git(cwd, ['add', '-A'], env)) === undefined) return undefined;
  return (await git(cwd, ['write-tree'], env))?.trim();
}

// Code highlighted by the markdown preview's renderer, one line of HTML each. A span the highlighter runs over several
// lines, like a block comment, is closed at each line's end and opened again on the next.
async function highlight(lines: string[], lang: string): Promise<string[]> {
  const text = lines.join('\n');
  const fence = '`'.repeat(Math.max(3, ...(text.match(/`+/g) ?? []).map((m) => m.length + 1)));
  let html: string[] = [];
  try {
    if (lines.length <= 2000) { // ponytail: a bigger diff stays plain
      const out = await vscode.commands.executeCommand<string>('markdown.api.render', `${fence}${lang}\n${text}\n${fence}`);
      html = (out.match(/<code[^>]*>([\s\S]*?)<\/code>/)?.[1] ?? '').replace(/\n$/, '').split('\n');
    }
  } catch {}
  if (html.length !== lines.length) return lines.map(escape);
  const open: string[] = [];
  return html.map((l) => {
    const line = open.join('') + l;
    for (const tag of l.match(/<span[^>]*>|<\/span>/g) ?? []) tag === '</span>' ? open.pop() : open.push(tag);
    return line + '</span>'.repeat(open.length);
  });
}

// Every file changed since the step's first run, the .llmd specs left out: the step on the left shows those. A run that
// started before its folder was a repository counts from the last commit.
async function updateDiffs(run: Run) {
  const root = rootOf(run.spec).fsPath;
  const top = (await git(root, ['rev-parse', '--show-toplevel']))?.trim();
  const prefix = (await git(root, ['rev-parse', '--show-prefix']))?.trim() ?? ''; // the project's folder in the repository
  const now = top && (await snapshot(top));
  if (!top || !now) return;
  const base = run.base || (await git(top, ['rev-parse', '-q', '--verify', 'HEAD^{tree}']))?.trim() || '4b825dc642cb6eb9a060e54bf8d69288fbee4904'; // git's empty tree
  run.repo = { top, base };
  const list = (await git(top, ['diff', '--name-status', '--no-renames', '-z', base, now]))?.split('\0') ?? [];
  const files: [string, string][] = [];
  // Your local Claude permissions aren't the step's either, and they stay out of its commit.
  const skip = /(^|\/)\.llmd\/|(^|\/)\.claude\/settings\.local\.json$/;
  for (let i = 0; i + 1 < list.length; i += 2) if (!skip.test(list[i + 1])) files.push([list[i], list[i + 1]]);
  run.diffs = await Promise.all(files.map(async ([status, file]): Promise<Diff> => {
    const diff = (await git(top, ['--literal-pathspecs', 'diff', '--no-color', '--no-ext-diff', base, now, '--', file])) ?? '';
    const old: string[] = [];
    const neu: string[] = [];
    let inHunk = false;
    let context = 0;
    for (const l of diff.split('\n')) {
      if (l.startsWith('@@')) inHunk = true;
      else if (inHunk && l[0] === ' ') old.push(l.slice(1)), neu.push(l.slice(1)), context++;
      else if (inHunk && l[0] === '-') old.push(l.slice(1));
      else if (inHunk && l[0] === '+') neu.push(l.slice(1));
    }
    const lang = path.extname(file).slice(1) || path.basename(file).toLowerCase(); // Makefile, Dockerfile
    const name = path.posix.relative(prefix, file);
    return {
      path: path.join(root, name), name, file, status, diff,
      added: neu.length - context, removed: old.length - context, old: await highlight(old, lang), new: await highlight(neu, lang),
    };
  }));
}

// Adds rules to the project's .claude/settings.local.json, where Claude Code keeps what you've allowed.
export async function allow(run: Run, rules: string[]) {
  const file = vscode.Uri.joinPath(rootOf(run.spec), '.claude', 'settings.local.json');
  const text = await readFile(file);
  let settings: { permissions?: { allow?: string[] } };
  try {
    settings = text ? JSON.parse(text) : {};
  } catch {
    vscode.window.showErrorMessage(`Couldn't read ${file.fsPath}, so nothing was allowed. Fix it, or allow the command there.`);
    return false;
  }
  const allowed = ((settings.permissions ??= {}).allow ??= []);
  for (const rule of rules) if (!allowed.includes(rule)) allowed.push(rule);
  await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(file, '..'));
  await vscode.workspace.fs.writeFile(file, Buffer.from(JSON.stringify(settings, null, 2) + '\n'));
  return true;
}

// Turns the spec's editor into the step's run: its tab opens in the spec's own column, in front of the spec.
export function openRun(spec: vscode.Uri, step: string): Run {
  const run = runOf(spec, step);
  if (run.panel) {
    run.panel.reveal();
    return run;
  }
  const column = vscode.window.visibleTextEditors.find((e) => e.document.uri.toString() === spec.toString())?.viewColumn;
  const panel = vscode.window.createWebviewPanel('llmd.run', step, column ?? vscode.ViewColumn.Active,
    { enableScripts: true, retainContextWhenHidden: true });
  show(run, panel);
  return run;
}

function show(run: Run, panel: vscode.WebviewPanel) {
  run.panel = panel;
  panel.title = run.step;
  panel.iconPath = vscode.Uri.joinPath(media, '..', 'images', 'file.svg');
  // Code in the run is colored like code in the markdown preview, by its renderer and with its stylesheet.
  const markdown = vscode.extensions.getExtension('vscode.markdown-language-features')?.extensionUri;
  const hljs = markdown && vscode.Uri.joinPath(markdown, 'media');
  // A step run in a terminal is drawn by xterm.js, from the extension's node_modules.
  const xterm = vscode.Uri.joinPath(media, '..', 'node_modules', '@xterm');
  panel.webview.options = { enableScripts: true, localResourceRoots: hljs ? [media, xterm, hljs] : [media, xterm] };
  const nonce = [...Array(32)].map(() => Math.random().toString(36)[2]).join('');
  // The nonce in the address too: the webview caches by it, and an update installs over the same version's files.
  const asset = (name: string) => `${panel.webview.asWebviewUri(vscode.Uri.joinPath(media, name))}?${nonce}`;
  const lib = (file: string) => panel.webview.asWebviewUri(vscode.Uri.joinPath(xterm, file));
  // Inline styles for xterm.js, which sizes the terminal with <style> elements of its own.
  const csp = `default-src 'none'; style-src ${panel.webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; img-src ${panel.webview.cspSource} https: data:;`;
  panel.webview.html = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">${hljs ? `<link rel="stylesheet" href="${panel.webview.asWebviewUri(vscode.Uri.joinPath(hljs, 'highlight.css'))}">` : ''}
<link rel="stylesheet" href="${lib('xterm/css/xterm.css')}"><link rel="stylesheet" href="${asset('run.css')}"></head>
<body class="writing"><header id="bar"></header><section id="step"></section>
<main id="chat"><div id="log"></div><div id="term"></div><form id="composer"><textarea id="input" rows="1"></textarea><button id="send" type="submit"></button></form></main>
<section id="review"><form id="commit"><textarea id="message" rows="3" placeholder="Commit message"></textarea><div class="actions">
<button type="button" data-act="write">✨ Write with Claude</button><span class="grow"></span><button class="primary" id="commitButton" type="submit">Commit</button></div></form>
<p id="committed"></p><div id="landed"></div></section>
<script nonce="${nonce}" src="${lib('xterm/lib/xterm.js')}"></script><script nonce="${nonce}" src="${lib('addon-fit/lib/addon-fit.js')}"></script>
<script nonce="${nonce}" src="${asset('tokens.js')}"></script><script nonce="${nonce}" src="${asset('run.js')}"></script></body></html>`;
  panel.webview.onDidReceiveMessage(async (m) => {
    if (m.type === 'log') return log.info(`${run.step}: ${m.text}`);
    // The step's terminal: everything it wrote for a tab that draws it now, then your keys and its size.
    if (m.type === 'attach') {
      return panel.webview.postMessage({ type: 'pty', full: true,
        data: run.screen ?? `\x1b[90mClick ▶ Implement or Plan to start ${agent().name} on this step, here.\x1b[0m\r\n` });
    }
    if (m.type === 'input') return run.pty?.write(m.data);
    if (m.type === 'resize') {
      run.size = [m.cols, m.rows];
      return run.pty?.resize(m.cols, m.rows);
    }
    if (m.type === 'ready') postTheme(run);
    if (m.type === 'ready' || m.type === 'refresh') return updateDiffs(run).then(() => post(run));
    if (m.type === 'allow') {
      const part = run.messages[m.message]?.parts[m.part];
      if (!part?.allow || part.allowed || !(await allow(run, part.allow))) return;
      part.allowed = true;
      save(run);
      return post(run);
    }
    if (m.type === 'continue') {
      const rules = run.messages.flatMap((msg) => msg.parts.filter((p) => p.allowed).flatMap((p) => p.allow ?? []));
      return send(run, `I allowed ${[...new Set(rules)].join(', ')}. Run what was refused again and carry on with the step.`);
    }
    if (m.type === 'send') return send(run, m.text);
    if (m.type === 'run') return runStep(m.mode, run.spec, run.step);
    if (m.type === 'stop') return stop(run);
    if (m.type === 'edit') return editSpec(run);
    if (m.type === 'done') return done(run);
    if (m.type === 'file') return openChanges(run, m.path);
    if (m.type === 'changes') return openChanges(run);
    if (m.type === 'write') return writeMessage(run);
    if (m.type === 'commit') return commit(run, m.text);
    if (m.type === 'next') return restart(openRun(vscode.Uri.parse(m.spec), m.step));
    if (m.type === 'newFeature') return newFeature();
    if (m.type === 'decide') {
      const section = stepSection((await specText(run.spec)) ?? '', run.step);
      return section && vscode.commands.executeCommand('llmd.decide', run.spec, section.line + m.line, m.answer);
    }
  });
  // The step's terminal is in its tab, so closing the tab ends the agent's CLI. A headless run goes on.
  panel.onDidDispose(() => {
    run.panel = undefined;
    if (run.pty) stop(run);
  });
}

// The step's changes in VS Code's own diff editor: one file, or all of them in its multi-file one. The old side is the
// file in the tree the diffs are from, read through the llmd-base scheme.
export async function openChanges(run: Run, file?: string) {
  const sides = (run.diffs ?? []).filter((d) => !file || d.path === file).map((d) => {
    const uri = vscode.Uri.file(d.path);
    const old = d.status === 'A' ? undefined : uri.with({ scheme: 'llmd-base', query: JSON.stringify({ ...run.repo, file: d.file }) });
    return [uri, old, d.status === 'D' ? undefined : uri] as const;
  });
  if (!file) return vscode.commands.executeCommand('vscode.changes', `${run.step}: changes`, sides);
  const [uri, old, now] = sides[0] ?? [vscode.Uri.file(file)]; // outside a repository there's only the file
  return old && now
    ? vscode.commands.executeCommand('vscode.diff', old, now, `${path.basename(uri.fsPath)} (${run.step})`)
    : vscode.window.showTextDocument(old ?? uri);
}

// One question to the agent, in a session of its own: its answer, or why there's none, like "Selected model is at
// capacity." With `readOnly` it may read the project but change nothing.
export async function askOnce(root: vscode.Uri, prompt: string, readOnly = false): Promise<{ answer?: string; error?: string }> {
  const { id, program, flags } = agent();
  const { args, input } = agentArgs(id, prompt, undefined, readOnly);
  const { out, failed } = await new Promise<{ out: string; failed?: string }>((resolve) => {
    const child = execFile(program, [...flags, ...args], { cwd: root.fsPath, maxBuffer: 16 << 20 }, (err, stdout, stderr) =>
      resolve({ out: stdout ?? '', failed: err ? String(stderr ?? '').trim().split('\n').at(-1) || err.message : undefined }));
    child.stdin?.end(input); // claude -p waits for stdin to end; codex reads the prompt from it
  });
  const events = out.split('\n').map((l) => {
    try {
      return JSON.parse(l);
    } catch {
      return undefined;
    }
  });
  // Claude's answer is its result; Codex's, its last message of a turn that didn't fail.
  const answer = id === 'claude' ? events.find((e) => e?.type === 'result' && !e.is_error)?.result
    : events.some((e) => e?.type === 'turn.failed') ? undefined
    : events.filter((e) => e?.type === 'item.completed' && e.item?.type === 'agent_message').at(-1)?.item.text;
  if (answer) return { answer };
  // Why, as the run would show it: the agent's last error, else what the program said as it failed.
  return { error: events.flatMap((e) => render(e, root.fsPath)).filter((p) => p.kind === 'error').at(-1)?.text ?? failed };
}

// The end of a sentence about what failed: ": <why>." when the agent said why, else ".".
export const why = (error?: string) => (error?.trim() ? `: ${error.trim().replace(/\.?$/, '.')}` : '.');

// The agent writes the commit message for a done step, from the step and its diff, in a one-off headless run.
export async function writeMessage(run: Run) {
  if (run.drafting) return;
  const root = rootOf(run.spec).fsPath;
  const recent = (await git(root, ['log', '--format=%s', '-10'])) ?? '';
  const diff = (run.diffs ?? []).map((d) => d.diff).join('\n').slice(0, 20000); // ponytail: a huge diff is cut
  const prompt = `Write the git commit message for this step, which is built and done:\n\n${(run.last ?? []).join('\n')}\n\n` +
    `Its changes:\n${diff}\n\n` + (recent.trim() ? `Match the style of the repository's recent commits:\n${recent}\n` : '') +
    'Reply with only the message: a subject line, then a blank line and a short body only if it helps. No code fences, and no tools.';
  run.drafting = true;
  await post(run);
  const { answer: result, error } = await askOnce(rootOf(run.spec), prompt, true);
  run.drafting = false;
  await post(run);
  if (!result) return vscode.window.showErrorMessage(`${agent().name} couldn't write the commit message${why(error)} Write it yourself, or try again.`);
  const text = result.replace(/^```\w*\n|\n?```\s*$/g, '').trim();
  run.panel?.webview.postMessage({ type: 'commitMessage', text });
  return text;
}

// Commits what the done step changed: the files in Changes, and its spec, which the step left, or which went with it. Only
// those paths, so whatever else you have staged stays staged and out of the commit.
export async function commit(run: Run, message: string) {
  if (!message.trim() || !run.done || run.committed) return;
  const root = rootOf(run.spec).fsPath;
  const diffs = run.diffs ?? [];
  const spec = (await readFile(run.spec)) !== undefined ? [specPath(run.spec)] : [];
  // A deleted file git never tracked has nothing to commit, and naming it would fail the whole commit.
  const deleted = [...diffs.filter((d) => d.status === 'D').map((d) => d.name), ...(spec.length ? [] : [specPath(run.spec)])];
  const tracked = deleted.length ? ((await git(root, ['--literal-pathspecs', 'ls-files', '-z', '--', ...deleted])) ?? '').split('\0') : [];
  const paths = [...diffs.filter((d) => d.status !== 'D').map((d) => d.name), ...tracked.filter(Boolean), ...spec];
  if (!paths.length) return; // "git commit --" with no paths would take everything you have staged
  const failed = (args: string[]) => new Promise<string | undefined>((resolve) => execFile('git', ['--literal-pathspecs', ...args], { cwd: root },
    (err, _out, stderr) => resolve(err ? stderr.trim() || err.message : undefined)));
  const problem = (await failed(['add', '-A', '--', ...paths])) ?? (await failed(['commit', '-q', '-m', message.trim(), '--', ...paths]));
  if (problem) return vscode.window.showErrorMessage(`The commit failed: ${problem}`);
  run.committed = ((await git(root, ['log', '-1', '--format=%h %s'])) ?? '').trim();
  save(run);
  await post(run);
}

// The open steps to build next, from the project's plans.
export async function nextSteps(root: vscode.Uri) {
  const next: { spec: string; step: string; where: string }[] = [];
  const folder = vscode.Uri.joinPath(root, '.llmd');
  for (const f of (await readDirectory(folder)).filter((f) => f.endsWith('.llmd'))) {
    const uri = vscode.Uri.joinPath(folder, f);
    for (const s of openSteps((await readFile(uri)) ?? '')) next.push({ spec: uri.toString(), step: s.title, where: f });
  }
  return next;
}

// Back to writing: the spec's editor, in the run's column, at the step.
async function editSpec(run: Run) {
  const text = (await specText(run.spec)) ?? '';
  const line = new vscode.Position(stepSection(text, run.step)?.line ?? 0, 0);
  return vscode.window.showTextDocument(run.spec, { viewColumn: run.panel?.viewColumn, selection: new vscode.Range(line, line) });
}

export function send(run: Run, text: string) {
  // The spec's selected lines go along, so "is this enough?" is about what you're looking at.
  const editor = vscode.window.visibleTextEditors.find((e) => e.document.uri.toString() === run.spec.toString() && !e.selection.isEmpty);
  const sel = editor?.selection;
  const selected = sel ? `\nSelected in the spec, lines ${sel.start.line + 1}-${sel.end.line + 1}:\n${editor!.document.getText(sel)}` : '';
  return ask(run, text, `${text}\n\n(This is about the step "${run.step}" in ${specPath(run.spec)}. ` +
    `Once it's built, tick it but leave it in the spec: I mark it done here.${selected})`);
}

export async function runStep(mode: 'implement' | 'plan', spec: vscode.Uri, step: string) {
  // Where the step's names are in the code goes along, so the agent doesn't search for them. A slow language server
  // doesn't hold the run up.
  const lines = stepSection((await specText(spec)) ?? '', step)?.lines ?? [];
  const where = await Promise.race([whereNames(rootOf(spec), lines), new Promise<string>((r) => setTimeout(() => r(''), 3000))]);
  // You mark the step done yourself, in the run, so the agent stops at the tick.
  const leave = mode === 'implement' ? ". When it's built, tick it but leave it in the spec: I review it and mark it done." : '';
  const prompt = stepPrompt(mode, step, specPath(spec)) + leave + (where && '\n\n' + where);
  if (vscode.workspace.getConfiguration('llmd').get('runIn') === 'terminal') return inTerminal(mode, spec, step, prompt);
  const run = openRun(spec, step);
  restart(run);
  run.mode = mode;
  return ask(run, `${mode === 'plan' ? 'Plan' : 'Implement'} "${step}"`, prompt);
}

// VS Code's own node-pty, the one its terminal runs on: the agent's CLI needs a real terminal, and a native module of
// LLMD's own would need a build for every platform. Its code is in VS Code's asar, which Electron reads, unless a build
// has none.
// ponytail: an internal of VS Code's; if it moves, bundle node-pty with a build per platform
function nodePty(): { spawn(file: string, args: string[], options: object): Pty } | undefined {
  for (const dir of ['node_modules.asar', 'node_modules']) {
    try {
      return require(path.join(vscode.env.appRoot, dir, 'node-pty'));
    } catch (e) {
      log.warn(`node-pty from ${dir}: ${e instanceof Error ? e.message : e}`);
    }
  }
}

// The step's run with the agent's own CLI in the conversation's place, when LLMD's settings say so: a real terminal,
// drawn by xterm.js in the run. You talk to the agent there, and pick a ?'s answers in the step on the left. Claude goes
// on in the step's session, so the step's chat and its terminal are one conversation.
// ponytail: Codex starts a new session each time; its CLI can't be told the id to start under
async function inTerminal(mode: 'implement' | 'plan', spec: vscode.Uri, step: string, prompt: string) {
  const run = openRun(spec, step);
  if (run.pty) return; // it's open: go on in it
  const pty = nodePty();
  // Not awaited: the message's promise only settles once you close it.
  if (!pty) return void vscode.window.showErrorMessage("Couldn't load VS Code's terminal, so the step can't run in one. Set Run In to LLMD's chat in LLMD's settings.");
  restart(run);
  run.mode = mode;
  const doc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === spec.toString());
  if (doc?.isDirty) await doc.save();
  // What the step's changes count from, as in the chat.
  if (!run.before) run.before = stepSection((await specText(spec)) ?? '', step)?.lines;
  if (!run.base) run.base = await snapshot(rootOf(spec).fsPath);
  save(run);

  const { id, name, program, flags } = agent();
  const sessionAt = sessionKey(id, runKey(spec, step));
  const session = state.get<string>(sessionAt);
  const fresh = session ?? randomUUID();
  if (id === 'claude' && !session) state.update(sessionAt, fresh);
  const [cols, rows] = run.size ?? [80, 24];
  const child = pty.spawn(program, terminalArgs(id, flags, prompt, fresh, !!session), { name: 'xterm-256color', cols, rows, cwd: rootOf(spec).fsPath, env: process.env });
  run.pty = child;
  run.stopped = false;
  run.screen = '';
  run.panel?.webview.postMessage({ type: 'pty', full: true, data: '' });
  child.onData((data) => {
    run.screen = (run.screen + data).slice(-(1 << 20)); // ponytail: the last MB, for a tab that draws it again
    run.panel?.webview.postMessage({ type: 'pty', data });
  });
  child.onExit(({ exitCode }) => {
    run.pty = undefined;
    // Claude ends with an error when it can't resume the session, like one it has cleaned up: the next start is a fresh one.
    if (id === 'claude' && exitCode && !run.stopped) state.update(sessionAt, undefined);
    const note = `\r\n\x1b[90m${name} exited${exitCode ? ` with code ${exitCode}` : ''}.\x1b[0m\r\n`;
    run.screen += note;
    run.panel?.webview.postMessage({ type: 'pty', data: note });
    updateDiffs(run).then(() => post(run));
  });
  await post(run);
}

function stop(run: Run) {
  if (!run.child && !run.pty) return;
  run.stopped = true;
  run.child?.kill();
  run.pty?.kill();
}

// One message of the step's chat: a headless run of the agent at the project root, its answer streamed into the run.
async function ask(run: Run, text: string, prompt: string) {
  const { id, name, program, flags } = agent();
  if (run.child) return vscode.window.showInformationMessage(`${name} is still working on this step. Wait for it, or stop it.`);
  const key = runKey(run.spec, run.step);
  const doc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === run.spec.toString());
  if (doc?.isDirty) await doc.save();
  if (!run.before) run.before = stepSection((await specText(run.spec)) ?? '', run.step)?.lines;
  if (!run.messages.length) run.base = await snapshot(rootOf(run.spec).fsPath); // where the step's changes start from

  const reply: Message = { who: 'claude', parts: [] };
  run.messages.push({ who: 'you', parts: [{ kind: 'text', html: `<p>${escape(text).replace(/\n/g, '<br>')}</p>` }] }, reply);
  let queue: Promise<unknown> = Promise.resolve(); // keeps the parts in order while markdown renders
  const add = (parts: Part[]) => (queue = queue.then(async () => {
    for (const p of parts) reply.parts.push(await toHtml(p));
    await post(run);
  }));

  const root = rootOf(run.spec).fsPath;
  const sessionAt = sessionKey(id, key);
  const session = state.get<string>(sessionAt);
  const { args, input } = agentArgs(id, prompt, session);
  // ponytail: no shell, so on Windows an npm-installed claude.cmd or codex.cmd won't start; a native .exe does
  const child = spawn(program, [...flags, ...args], { cwd: root, stdio: ['pipe', 'pipe', 'pipe'] });
  child.stdin.on('error', () => {}); // a program that never started, or exits without reading it
  child.stdin.end(input); // claude -p waits for stdin to end before starting; codex reads the prompt from it
  run.child = child;
  run.stopped = false;
  await post(run);

  let started = false; // the agent reports its session before anything else; a resume of a missing session never does
  let pending = '';
  let errors = '';
  child.stdout.on('data', (chunk) => {
    const lines = (pending + chunk).split('\n');
    pending = lines.pop()!;
    for (const line of lines) {
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      const reported = startedIn(event);
      if (reported) {
        started = true;
        state.update(sessionAt, reported);
      }
      const parts = render(event, root);
      if (parts.length) add(parts);
    }
  });
  child.stderr.on('data', (chunk) => (errors += chunk));
  let ended = false;
  const end = (problem?: string) => {
    if (ended) return;
    ended = true;
    const notes: Part[] = [];
    if (session && !started) {
      state.update(sessionAt, undefined);
      notes.push({ kind: 'error', text: 'The chat could not be resumed, so your next message starts a new one.' });
    }
    if (run.stopped) notes.push({ kind: 'error', text: 'Stopped.' });
    else if (problem) notes.push({ kind: 'error', text: problem });
    add(notes);
    queue = queue.then(async () => {
      await updateDiffs(run); // before the run counts as finished, so its changes are there when it is
      run.child = undefined;
      await post(run);
      save(run); // ponytail: each step's whole run in workspace state; trim it if runs get huge
    });
  };
  child.on('error', (e) => end(`Couldn't start ${program}: ${e.message}. Install it, or pick another agent in LLMD's settings.`));
  child.on('close', (code) => end(code && !reply.parts.length ? errors.trim().slice(-1500) || `${program} exited with code ${code}` : undefined));
}

async function readFile(uri: vscode.Uri): Promise<string | undefined> {
  try {
    return Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
  } catch {
    return undefined;
  }
}

// The lang: line the project's specs use, for a new feature.
async function langOf(root: vscode.Uri): Promise<string | undefined> {
  for (const f of await vscode.workspace.findFiles(new vscode.RelativePattern(root, '.llmd/**/*.llmd'), undefined, 20)) {
    const lang = (await readFile(f))?.match(/^lang:.*$/m)?.[0];
    if (lang) return lang;
  }
}

// The project to work in: the one of the spec you're in, else the first folder open.
function project(): vscode.Uri | undefined {
  const active = vscode.window.activeTextEditor?.document.uri;
  return active?.scheme === 'file' && vscode.workspace.getWorkspaceFolder(active) ? rootOf(active) : vscode.workspace.workspaceFolders?.[0]?.uri;
}

// A new feature is a plan, .llmd/<name>.llmd, with its first ## step. It opens on the line under the step, ready to write.
async function newFeature() {
  const root = project();
  if (!root) return vscode.window.showWarningMessage('Open a project folder first, so the feature has a project to go into.');
  const plans = vscode.Uri.joinPath(root, '.llmd');
  const name = (await vscode.window.showInputBox({ prompt: 'Name of the feature, the title of its step', placeHolder: 'Export readings as CSV' }))?.trim();
  const slug = name?.toLowerCase().replace(/[^\w]+/g, '-').replace(/^-|-$/g, '');
  if (!name || !slug) return;
  await vscode.workspace.fs.createDirectory(plans);
  let uri = vscode.Uri.joinPath(plans, slug + '.llmd');
  for (let i = 2; (await readFile(uri)) !== undefined; i++) uri = vscode.Uri.joinPath(plans, `${slug}-${i}.llmd`);
  const lang = await langOf(root);
  await vscode.workspace.fs.writeFile(uri, Buffer.from(`${lang ? lang + '\n\n' : ''}## ${name}\n\n`));
  const doc = await vscode.workspace.openTextDocument(uri);
  const at = new vscode.Position(doc.lineCount - 1, 0);
  return vscode.window.showTextDocument(doc, { selection: new vscode.Range(at, at) });
}

async function readDirectory(uri: vscode.Uri): Promise<string[]> {
  try {
    return (await vscode.workspace.fs.readDirectory(uri)).map(([name]) => name);
  } catch {
    return [];
  }
}

// Takes the built step out of its spec, once the agent ticked it and the code has everything it lists, and the spec with its
// last step. Its run is the review.
export async function done(run: Run) {
  if (run.child) return;
  // The file is the truth: the agent edits it on disk, and the editor may not have caught up. Only your unsaved edits go first.
  const open = vscode.workspace.textDocuments.find((d) => d.uri.toString() === run.spec.toString());
  if (open?.isDirty) await open.save();
  const text = (await readFile(run.spec)) ?? '';
  const section = stepSection(text, run.step);
  if (!section) {
    await post(run); // a ticked step that's gone was taken out already, which post takes as done
    if (!run.done) vscode.window.showWarningMessage(`"${run.step}" isn't in ${specPath(run.spec)} anymore, so there's nothing to finish.`);
    return;
  }
  // Not awaited: the message's promise only settles once you close it.
  if (!section.done) return void vscode.window.showWarningMessage(`"${run.step}" isn't ticked yet. ${agent().name} ticks it once it's built.`);
  const gaps = await missing(rootOf(run.spec), section.lines);
  if (gaps.length) return void vscode.window.showWarningMessage(`"${run.step}" isn't in the code yet: ${gaps.join(', ')}.`);
  const lines = text.split(/\r?\n/);
  lines.splice(section.line, section.lines.length);
  const rest = lines.join('\n').replace(/\n{3,}/g, '\n\n');
  if (/^##\s/m.test(rest)) await vscode.workspace.fs.writeFile(run.spec, Buffer.from(rest));
  else {
    const tabs = vscode.window.tabGroups.all.flatMap((g) => g.tabs)
      .filter((t) => t.input instanceof vscode.TabInputText && t.input.uri.toString() === run.spec.toString());
    await vscode.window.tabGroups.close(tabs);
    await vscode.workspace.fs.delete(run.spec);
  }
  stop(run); // the step's terminal, if it's open: the run is history now
  run.done = true;
  run.last = section.lines;
  save(run);
  await updateDiffs(run); // what the agent changed in its terminal, which no message of the chat read in
  await post(run);
}

export function initRuns(context: vscode.ExtensionContext) {
  state = context.workspaceState;
  media = vscode.Uri.joinPath(context.extensionUri, 'media');
  log = vscode.window.createOutputChannel('LLMD', { log: true });
  context.subscriptions.push(log);
  // The step on the left stays live: edits in the editor, and the agent's edits on disk.
  const refresh = (uri: vscode.Uri) => runs.forEach((r) => r.spec.toString() === uri.toString() && post(r));
  const specs = vscode.workspace.createFileSystemWatcher('**/*.llmd');
  context.subscriptions.push(
    specs,
    specs.onDidChange(refresh),
    specs.onDidDelete(refresh),
    specs.onDidCreate(refresh),
    onDidChangeCode(() => {
      colored.clear();
      runs.forEach((r) => post(r));
    }),
    vscode.window.onDidChangeActiveColorTheme(() => runs.forEach(postTheme)),
    vscode.workspace.onDidChangeTextDocument((e) => e.document.languageId === 'llmd' && refresh(e.document.uri)),
    vscode.workspace.registerTextDocumentContentProvider('llmd-base', {
      provideTextDocumentContent: async (uri) => {
        const { top, base, file } = JSON.parse(uri.query) as { top: string; base: string; file: string };
        return (await git(top, ['show', `${base}:${file}`])) ?? '';
      },
    }),
    vscode.commands.registerCommand('llmd.newFeature', newFeature),
    vscode.commands.registerCommand('llmd.run', (spec: vscode.Uri, step: string) => openRun(spec, step)),
    // After a reload, a run's tab comes back on its step.
    vscode.window.registerWebviewPanelSerializer('llmd.run', {
      deserializeWebviewPanel: async (panel, saved?: { key?: string }) => {
        const at = saved?.key?.indexOf('#') ?? -1;
        if (!saved?.key || at < 0) return panel.dispose();
        show(runOf(vscode.Uri.parse(saved.key.slice(0, at)), saved.key.slice(at + 1)), panel);
      },
    }),
  );
}
