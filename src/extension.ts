import * as path from 'path';
import * as vscode from 'vscode';
import { CALLABLE, codeHover, CodeSymbol, CONTAINERS, freshSpans, missing, onDidChangeCode, searchTypes, symbolOf, symbolsOf, typeNamed, TYPES, typeSpansOf, watchCode } from './code';
import { OutlineNode, openSteps, parseOutline, placeIn, questionAt, questionsOf, Segment, stepSection } from './outline';
import { answersIn, answersPrompt } from './agent';
import { agent, askOnce, done, initRuns, nextSteps, openRun, rootOf, runStep, specPath, why } from './run';
import { findRefs } from './refs';
import { builtinTypes, Claim, claims, claimSpan, closest, findCalls, indexSymbols, inPath, inTypePosition, ownerAbove, receiverOf, Span, symbolName, unitsOf } from './symbols';

async function statOrNull(uri: vscode.Uri): Promise<vscode.FileStat | null> {
  try {
    return await vscode.workspace.fs.stat(uri);
  } catch {
    return null;
  }
}

async function scan(doc: vscode.TextDocument) {
  const root = rootOf(doc.uri);
  const links: vscode.DocumentLink[] = [];
  const problems: vscode.Diagnostic[] = [];
  for (const ref of findRefs(doc.getText())) {
    const range = new vscode.Range(doc.positionAt(ref.start), doc.positionAt(ref.end));
    const target = vscode.Uri.joinPath(root, ref.path);
    const stat = await statOrNull(target);
    if (!stat) problems.push(new vscode.Diagnostic(range, `No file or folder '${ref.path}'`, vscode.DiagnosticSeverity.Warning));
    else if (stat.type & vscode.FileType.File) links.push(new vscode.DocumentLink(range, target));
  }
  return { links, problems };
}

const SYMBOL_KIND: Record<OutlineNode['kind'], vscode.SymbolKind> = {
  heading: vscode.SymbolKind.String,
  unit: vscode.SymbolKind.File,
  type: vscode.SymbolKind.Class,
  method: vscode.SymbolKind.Method,
  field: vscode.SymbolKind.Field,
};

export function toSymbols(nodes: OutlineNode[], doc: vscode.TextDocument): vscode.DocumentSymbol[] {
  return nodes.map((n) => {
    const line = doc.lineAt(n.line);
    const name = line.range.with(line.range.start.translate(0, line.firstNonWhitespaceCharacterIndex));
    const range = new vscode.Range(name.start, doc.lineAt(n.endLine).range.end);
    const symbol = new vscode.DocumentSymbol(n.name || '…', n.detail, SYMBOL_KIND[n.kind], range, name); // "## " while you type
    symbol.children = toSymbols(n.children, doc);
    return symbol;
  });
}

const indexOf = (doc: vscode.TextDocument) => indexSymbols(parseOutline(doc.getText()));

const toRange = (s: Span) => new vscode.Range(s.line, s.start, s.line, s.end);

// Where a claimed type or method's name sits on its line.
const nameRange = (doc: vscode.TextDocument, c: Claim) => toRange(claimSpan(doc.getText().split('\n'), c));

// The type or method the cursor is on the name of, where the spec lists it under its unit.
const claimAt = (doc: vscode.TextDocument, pos: vscode.Position) =>
  claims(parseOutline(doc.getText())).find((c) => c.line === pos.line && nameRange(doc, c).contains(pos));

const codeOf = (doc: vscode.TextDocument, path: string) => symbolsOf(vscode.Uri.joinPath(rootOf(doc.uri), path));

// The types of the files the spec lists, by name, with the file.
async function codeTypes(doc: vscode.TextDocument): Promise<[string, CodeSymbol, string][]> {
  const found: [string, CodeSymbol, string][] = [];
  for (const unit of new Set(unitsOf(parseOutline(doc.getText())))) {
    for (const [name, s] of (await codeOf(doc, unit)) ?? []) if (TYPES.has(s.kind)) found.push([name, s, unit]);
  }
  return found;
}

// The code's type of this name: in a file the spec lists, else anywhere in the project.
const codeType = (doc: vscode.TextDocument, name: string) => typeNamed(rootOf(doc.uri), unitsOf(parseOutline(doc.getText())), name);

// The word the cursor is on that may name a type: in a signature, a logic line or a free line, not in a path or heading.
function typeWordAt(doc: vscode.TextDocument, pos: vscode.Position) {
  const line = doc.lineAt(pos).text;
  const range = doc.getWordRangeAtPosition(pos, /(?<![\w.])[A-Za-z_]\w*(?![\w.])/); // not sql.DB's parts
  if (!range || inPath(line, pos.character) || /^\s*#/.test(line)) return;
  return { name: doc.getText(range), range };
}

// The types and methods the spec plans that the code doesn't have yet: under a + unit, or missing from their @ file.
export async function newRanges(doc: vscode.TextDocument): Promise<vscode.Range[]> {
  return (await freshSpans(rootOf(doc.uri), doc.getText())).map(toRange);
}

// On a type or method the code has, anywhere in a line: its real hover. On one it doesn't have yet: that it's new.
async function hover(doc: vscode.TextDocument, pos: vscode.Position): Promise<vscode.Hover | undefined> {
  const c = claimAt(doc, pos);
  if (!c) {
    const word = typeWordAt(doc, pos);
    const type = word && (await codeType(doc, word.name));
    const md = type && (await codeHover(type.at));
    return md && new vscode.Hover(md, word.range);
  }
  const range = nameRange(doc, c);
  if (c.newFile) return new vscode.Hover(`New: \`${c.path}\` is a new file`, range);
  const names = await codeOf(doc, c.path);
  const symbol = symbolOf(names, c);
  if (!symbol) return names && new vscode.Hover(`New: \`${c.path}\` has no \`${c.name}\` yet`, range);
  const md = await codeHover(symbol.at);
  return md && new vscode.Hover(md, range);
}

// Ctrl+click on a type or method the code has, listed under its file, opens it there. Any other name goes to where the
// spec declares it, else to the code's type of that name.
export async function findDefinition(doc: vscode.TextDocument, pos: vscode.Position): Promise<vscode.Location | undefined> {
  const c = claimAt(doc, pos);
  const symbol = c && symbolOf(await codeOf(doc, c.path), c);
  if (symbol) return symbol.at;
  const range = doc.getWordRangeAtPosition(pos, /[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)?/);
  if (!range || inPath(doc.lineAt(pos).text, pos.character)) return; // @paths open the file instead
  const [name, member] = doc.getText(range).split('.');
  const declared = indexOf(doc).get(name);
  const onMember = member !== undefined && pos.character > range.start.character + name.length;
  const line = onMember ? declared?.members.get(member) : declared?.line;
  if (line !== undefined) return new vscode.Location(doc.uri, new vscode.Position(line, doc.lineAt(line).firstNonWhitespaceCharacterIndex));
  const word = !c && typeWordAt(doc, pos);
  return word ? (await codeType(doc, word.name))?.at : undefined;
}

const symbolAt = new WeakMap<vscode.CompletionItem, vscode.Location>(); // where a completion's symbol is, for its docs

// A real symbol as a completion, by default written the spec's way: "save()" and ": Store".
function codeCompletion(name: string, s: CodeSymbol, where: string, insert = CALLABLE.has(s.kind) ? `${name}()` : TYPES.has(s.kind) ? `: ${name}` : name) {
  const kind = CALLABLE.has(s.kind) ? vscode.CompletionItemKind.Method : TYPES.has(s.kind) ? vscode.CompletionItemKind.Class : vscode.CompletionItemKind.Field;
  const item = new vscode.CompletionItem(name, kind);
  item.insertText = insert;
  item.detail = s.detail || where;
  symbolAt.set(item, s.at);
  return item;
}

// A completion of a real symbol gets its docs when it's picked out in the list.
async function resolveCompletion(item: vscode.CompletionItem) {
  const at = symbolAt.get(item);
  if (at) item.documentation = await codeHover(at);
  return item;
}

// The types to offer where one goes: those of the files the spec lists and the spec's own first, then the rest of the
// project's that its language's search finds for the word you're typing, then the built-in ones. The list asks again as
// you type, for that search.
async function typeCompletions(doc: vscode.TextDocument, before: string, builtin: boolean): Promise<vscode.CompletionList> {
  const pad = /(^|[^(<[]):$/.test(before) ? ' ' : ''; // ": Store", and "(:Store)" as typed
  const word = before.match(/\w*$/)![0];
  const root = rootOf(doc.uri);
  const seen = new Set<string>();
  const items: vscode.CompletionItem[] = [];
  const add = (item: vscode.CompletionItem, group: string) => {
    const name = item.label as string;
    if (seen.has(name)) return;
    seen.add(name);
    item.insertText ??= pad + name;
    item.sortText = group + name;
    items.push(item);
  };
  for (const [name, s, unit] of await codeTypes(doc)) add(codeCompletion(name, s, unit, pad + name), '0');
  for (const [name, d] of indexOf(doc)) if (d.kind === 'type') add(new vscode.CompletionItem(name, vscode.CompletionItemKind.Class), '0');
  for (const s of (word && (await searchTypes(root, word))) || []) {
    const name = symbolName(s.name);
    add(codeCompletion(name, { kind: s.kind, detail: '', at: s.location, members: new Map() }, path.relative(root.fsPath, s.location.uri.fsPath), pad + name), '1');
  }
  if (builtin) for (const t of builtinTypes(doc.getText())) add(new vscode.CompletionItem(t, vscode.CompletionItemKind.TypeParameter), '2');
  return new vscode.CompletionList(items, true);
}

export async function completeNames(doc: vscode.TextDocument, pos: vscode.Position): Promise<vscode.CompletionItem[] | vscode.CompletionList> {
  const text = doc.lineAt(pos).text;
  if (inPath(text, pos.character)) return [];
  // After a ":" the types, anywhere in a line. A new line under a unit offers what its file really has, and under one of
  // its types, that type's members.
  const before = text.slice(0, pos.character);
  if (/(?<![\w:]):\s*\w*$/.test(before)) return typeCompletions(doc, before, inTypePosition(text, pos.character));
  const owner = /^\s*-\s+\w*$/.test(before) && ownerAbove(doc.getText(), pos.line);
  if (owner) {
    const names = await codeOf(doc, owner.unit);
    const code = [...((owner.type ? names?.get(owner.type)?.members : names) ?? [])].map(([name, s]) => codeCompletion(name, s, owner.unit));
    if (code.length) return code;
  }
  const index = indexOf(doc);
  const dot = text.slice(0, pos.character).match(/(?<![\w.])([A-Za-z_]\w*)\.(\w*)$/);
  if (dot) {
    const declared = index.get(dot[1]);
    if (!declared) return [];
    return [...declared.members].map(([member, line]) => {
      const kind = doc.lineAt(line).text.includes('(') ? vscode.CompletionItemKind.Method : vscode.CompletionItemKind.Field;
      return new vscode.CompletionItem(member, kind);
    });
  }
  if (inTypePosition(text, pos.character)) return typeCompletions(doc, before, true);
  if (text.slice(0, pos.character).endsWith(':')) return [];
  return [...index].map(([name, d]) =>
    new vscode.CompletionItem(name, d.kind === 'type' ? vscode.CompletionItemKind.Class : vscode.CompletionItemKind.File));
}

const typeLegend = new vscode.SemanticTokensLegend(['type']);

// The spec's, the language's and the code's types in field types, signatures and after a ":".
async function typeTokens(doc: vscode.TextDocument): Promise<vscode.SemanticTokens> {
  const tokens = new vscode.SemanticTokensBuilder(typeLegend);
  for (const s of await typeSpansOf(rootOf(doc.uri), doc.getText())) tokens.push(s.line, s.start, s.end - s.start, 0);
  return tokens.build();
}

// What the cursor is on in a code file, as the spec writes it: the file, the types around it, and the method or other
// member it's in. Just the file when its language gives no symbols.
async function segmentsAt(doc: vscode.TextDocument, pos: vscode.Position, unit: string): Promise<Segment[]> {
  const path: Segment[] = [{ kind: 'unit', name: unit, text: '@' + unit }];
  let list: (vscode.DocumentSymbol | vscode.SymbolInformation)[] = [];
  try {
    list = (await vscode.commands.executeCommand<typeof list>('vscode.executeDocumentSymbolProvider', doc.uri)) ?? [];
  } catch {}
  for (;;) {
    // ponytail: only providers that nest their symbols, which today's do
    const s = list.find((s): s is vscode.DocumentSymbol => 'children' in s && s.range.contains(pos));
    if (!s) return path;
    const name = symbolName(s.name);
    const receiver = receiverOf(s.name);
    if (receiver) path.push({ kind: 'type', name: receiver, text: ': ' + receiver });
    if (TYPES.has(s.kind)) path.push({ kind: 'type', name, text: ': ' + name });
    else if (CALLABLE.has(s.kind)) return [...path, { kind: 'method', name, text: `- ${name}()` }];
    else if (!CONTAINERS.has(s.kind)) return [...path, { kind: 'line', name, text: '- ' + name }];
    list = s.children;
  }
}

// The step to add to: the one under the cursor in a spec you can see, else one of the project's open steps you pick.
async function pickStep(root: vscode.Uri): Promise<{ doc: vscode.TextDocument; line: number } | undefined> {
  for (const editor of vscode.window.visibleTextEditors) {
    if (editor.document.languageId !== 'llmd') continue;
    for (let i = editor.selection.active.line; i >= 0; i--) {
      const text = editor.document.lineAt(i).text;
      if (/^##\s/.test(text)) return { doc: editor.document, line: i };
      if (/^#\s/.test(text)) break;
    }
  }
  const steps = await nextSteps(root);
  if (!steps.length) return void vscode.window.showInformationMessage('No open steps to add it to. Make one with LLMD: New feature.');
  const picked = steps.length === 1 ? steps[0]
    : (await vscode.window.showQuickPick(steps.map((s) => ({ label: s.step, description: s.where, s })), { placeHolder: 'Add it to which step?' }))?.s;
  if (!picked) return;
  const doc = await vscode.workspace.openTextDocument(vscode.Uri.parse(picked.spec));
  const line = stepSection(doc.getText(), picked.step)?.line;
  return line === undefined ? undefined : { doc, line };
}

// Puts what you're on in the code into a step: from the editor, the method or type under the cursor; from the Explorer,
// the files and folders you picked. What the step already lists is used, not repeated.
async function addToStep(uri?: vscode.Uri, picked?: vscode.Uri[]) {
  const editor = vscode.window.activeTextEditor;
  const targets = Array.isArray(picked) && picked.length ? picked : [uri instanceof vscode.Uri ? uri : editor?.document.uri].filter((u): u is vscode.Uri => !!u);
  if (!targets.length) return;
  const step = await pickStep(rootOf(targets[0]));
  if (!step) return;
  const { doc } = step;
  const root = rootOf(doc.uri);
  let at = step.line;
  let added = false;
  let listed = false; // something it already has
  for (const target of targets) {
    const rel = path.relative(root.fsPath, target.fsPath).split(path.sep).join('/');
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
      vscode.window.showWarningMessage(`${path.basename(target.fsPath)} isn't in the project of ${path.basename(doc.uri.fsPath)}.`);
      continue;
    }
    const folder = ((await statOrNull(target))?.type ?? 0) & vscode.FileType.Directory;
    const inEditor = !Array.isArray(picked) && editor?.document.uri.toString() === target.toString();
    const segments = folder ? [{ kind: 'unit' as const, name: rel + '/', text: `@${rel}/` }]
      : inEditor ? await segmentsAt(editor!.document, editor!.selection.active, rel) : [{ kind: 'unit' as const, name: rel, text: '@' + rel }];
    const place = placeIn(doc.getText(), step.line, segments);
    if (place.lines.length) {
      const edit = new vscode.WorkspaceEdit();
      edit.insert(doc.uri, doc.lineAt(place.after).range.end, '\n' + place.lines.join('\n'));
      if (await vscode.workspace.applyEdit(edit)) added = true;
    } else listed = true;
    at = place.at;
  }
  // The step may list it all already: it's shown where it is, which would look like nothing happened.
  if (listed && !added) vscode.window.showInformationMessage(`"${doc.lineAt(step.line).text.replace(/^##\s+(?:\[[ xX]\]\s*)?/, '')}" already lists it.`);
  const end = doc.lineAt(at).range.end;
  const shown = vscode.window.visibleTextEditors.find((e) => e.document === doc);
  await vscode.window.showTextDocument(doc, { viewColumn: shown?.viewColumn ?? vscode.ViewColumn.Beside, selection: new vscode.Range(end, end) });
}

const SKIP = new Set(['.git', '.llmd', 'node_modules', 'out', 'dist', 'build', 'bin', 'obj', '.vscode-test']);

// Every file and folder under root, as "a/b/c.go" and "a/b/", for @ search.
// ponytail: walks the disk on each @ and stops at 5000 entries; cache it if big repos feel slow.
async function projectPaths(root: vscode.Uri): Promise<[string, boolean][]> {
  const found: [string, boolean][] = [];
  const queue = [''];
  while (queue.length && found.length < 5000) {
    const dir = queue.shift()!;
    let entries: [string, vscode.FileType][];
    try {
      entries = await vscode.workspace.fs.readDirectory(vscode.Uri.joinPath(root, dir));
    } catch {
      continue;
    }
    for (const [name, type] of entries) {
      if (SKIP.has(name)) continue;
      const isDir = (type & vscode.FileType.Directory) !== 0;
      found.push([dir + name + (isDir ? '/' : ''), isDir]);
      if (isDir) queue.push(dir + name + '/');
    }
  }
  return found;
}

export function callProblems(doc: vscode.TextDocument): vscode.Diagnostic[] {
  const index = indexOf(doc);
  return findCalls(doc.getText()).flatMap((c) => {
    const declared = index.get(c.name);
    // shortcut: only types are checked; unit names collide with prose like "extension.ts"
    if (declared?.kind !== 'type' || declared.members.has(c.member)) return [];
    // Only likely typos: inherited members (DbContext.Database) and file names in prose (BookService.cs) aren't.
    const meant = closest(c.member, declared.members.keys());
    if (!meant) return [];
    const range = new vscode.Range(c.line, c.start, c.line, c.end);
    return [new vscode.Diagnostic(range, `${c.name} has no member '${c.member}'. Did you mean '${meant}'?`, vscode.DiagnosticSeverity.Warning)];
  });
}

// Every line of a done step (## [x] down to the next heading of the same or a higher level),
// plus [x] methods and the deeper-indented lines under them.
export function doneLines(text: string): number[] {
  const lines: number[] = [];
  let doneIndent = -1;
  let doneStep = 0; // heading level of the done step we're in, 0 when none
  let inFence = false;
  text.split('\n').forEach((line, i) => {
    const fence = /^\s*(```|~~~)/.test(line);
    if (fence) inFence = !inFence;
    const heading = !inFence && !fence && line.match(/^(#{1,6})\s+(\[[xX]\])?/);
    if (heading) {
      if (doneStep && heading[1].length <= doneStep) doneStep = 0;
      if (!doneStep && heading[2]) doneStep = heading[1].length;
      doneIndent = -1;
    }
    if (doneStep) {
      lines.push(i);
      return;
    }
    const indent = line.search(/\S/);
    if (indent === -1 || heading) return;
    if (doneIndent >= 0 && indent > doneIndent) {
      lines.push(i);
      return;
    }
    doneIndent = /^\s*-\s+\[[xX]\]/.test(line) ? indent : -1;
    if (doneIndent >= 0) lines.push(i);
  });
  return lines;
}

// Answers a ? in the spec with one of its answers: it and its answers become "// decided: <question> <answer>" where it was.
async function decide(uri: vscode.Uri, line: number, answer: string) {
  const doc = await vscode.workspace.openTextDocument(uri);
  const q = questionsOf(doc.getText()).find((q) => q.line === line);
  if (!q) return;
  answer = answer.replace(/\s*\(recommended\)\s*$/i, '');
  const indent = doc.lineAt(line).text.match(/^\s*/)![0];
  const asked = q.question && (/[?:.]$/.test(q.question) ? q.question : q.question + ':');
  const edit = new vscode.WorkspaceEdit();
  edit.replace(uri, new vscode.Range(line, 0, q.end, doc.lineAt(q.end).text.length), `${indent}// decided: ${asked ? asked + ' ' : ''}${answer}`);
  await vscode.workspace.applyEdit(edit);
}

const answering = new Set<string>(); // "<spec uri>#<question>" while the agent writes its answers
const answered = new vscode.EventEmitter<void>(); // the agent started or finished answering one

// Has the agent write the answers to a ? under it, to pick from: it reads the step, and the code the step points to, but
// changes nothing.
async function suggest(uri: vscode.Uri, line: number) {
  const doc = await vscode.workspace.openTextDocument(uri);
  const text = doc.getText();
  const q = questionsOf(text).find((q) => q.line === line);
  const key = `${uri}#${q?.question}`;
  if (!q || answering.has(key)) return;
  let heading = line;
  while (heading >= 0 && !/^##\s/.test(doc.lineAt(heading).text)) heading--;
  const step = heading < 0 ? undefined : stepSection(text, doc.lineAt(heading).text.replace(/^##\s+(?:\[[ xX]\]\s*)?/, '').trim());
  answering.add(key);
  answered.fire();
  const { name } = agent();
  const { answer, error } = await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: `${name} is answering` }, () =>
    askOnce(rootOf(uri), answersPrompt(specPath(uri), step?.lines ?? text.split('\n'), q.question), true));
  answering.delete(key);
  answered.fire();
  const answers = answersIn(answer ?? '');
  if (!answers.length) return void vscode.window.showErrorMessage(`${name} didn't answer "${q.question}"${why(error)} Try again, or write your own.`);
  // You may have written on while the agent thought: the question is the one by that text nearest to where it was.
  const now = questionsOf(doc.getText()).filter((x) => x.question === q.question).sort((a, b) => Math.abs(a.line - line) - Math.abs(b.line - line))[0];
  if (!now) return;
  const indent = ' '.repeat(doc.lineAt(now.line).firstNonWhitespaceCharacterIndex + 2);
  const edit = new vscode.WorkspaceEdit();
  edit.insert(uri, doc.lineAt(now.end).range.end, answers.map((a) => `\n${indent}- ${a}`).join(''));
  await vscode.workspace.applyEdit(edit);
}

const KEY = process.platform === 'darwin' ? '⌘↵' : 'Ctrl+Enter';

// What ⌘↵ does on the cursor's line, for its hint: pick the answer it's on, ask the agent for answers, or choose one.
function onQuestion(editor: vscode.TextEditor): string | undefined {
  const at = editor.document.languageId === 'llmd' ? questionAt(editor.document.getText(), editor.selection.active.line) : undefined;
  return !at ? undefined : at.answer ? 'pick this answer' : at.question.answers.length ? 'choose an answer' : `ask ${agent().name} for answers`;
}

// ⌘↵ on a question or an answer: the keyboard's way to answer it.
async function answerHere(editor: vscode.TextEditor) {
  const doc = editor.document;
  const at = questionAt(doc.getText(), editor.selection.active.line);
  if (!at) return;
  const { question, answer } = at;
  if (answer) return decide(doc.uri, question.line, answer.text);
  if (!question.answers.length) return suggest(doc.uri, question.line);
  const picked = await vscode.window.showQuickPick(question.answers.map((a) => ({
    label: (a.recommended ? '$(star-full) ' : '') + a.choice,
    description: a.tradeoff,
    answer: a,
  })), { placeHolder: question.question || 'Pick an answer' });
  if (picked) return decide(doc.uri, question.line, picked.answer.text);
}

// Enter on an empty "- ", "* " or "! " steps out one level and keeps the bullet, so a method's logic ends in its next sibling;
// at the outermost level it drops the bullet. Any other Enter is a normal one.
async function enter(editor: vscode.TextEditor) {
  const pos = editor.selection.active;
  const line = editor.document.lineAt(pos.line);
  const empty = line.text.match(/^( *)([-*!])\s*$/); // shortcut: assumes space indentation, which the language defaults to
  if (editor.selection.isEmpty && empty && pos.character === line.text.length) {
    const outer = empty[1].slice(2);
    await editor.edit((e) => e.replace(line.range, outer && `${outer}${empty[2]} `));
    return;
  }
  await vscode.commands.executeCommand('type', { source: 'keyboard', text: '\n' });
}

export function activate(context: vscode.ExtensionContext) {
  const selector: vscode.DocumentSelector = { language: 'llmd' };
  const diagnostics = vscode.languages.createDiagnosticCollection('llmd');

  initRuns(context);
  watchCode(context);

  const check = async (doc: vscode.TextDocument) => {
    if (doc.languageId !== 'llmd') return;
    diagnostics.set(doc.uri, [...(await scan(doc)).problems, ...callProblems(doc)]);
  };
  vscode.workspace.textDocuments.forEach(check);

  // Done steps are dimmed, and what the step adds to the code is colored as new.
  const dim = vscode.window.createTextEditorDecorationType({ opacity: '0.5' });
  const fresh = vscode.window.createTextEditorDecorationType({ color: new vscode.ThemeColor('gitDecoration.addedResourceForeground') });
  // A ? waits on you, a ! has to pass.
  const asks = vscode.window.createTextEditorDecorationType({ color: new vscode.ThemeColor('editorWarning.foreground'), fontWeight: 'bold' });
  const checks = vscode.window.createTextEditorDecorationType({ color: new vscode.ThemeColor('testing.iconPassed'), fontWeight: 'bold' });
  // On a question or an answer, what ⌘↵ does there, at the end of the line; the key works only there.
  const hint = vscode.window.createTextEditorDecorationType({ after: { color: new vscode.ThemeColor('editorCodeLens.foreground'), margin: '0 0 0 2em' } });
  const showHint = (editor: vscode.TextEditor) => {
    const what = onQuestion(editor);
    vscode.commands.executeCommand('setContext', 'llmd.onQuestion', !!what);
    if (editor.document.languageId !== 'llmd') return;
    // The selection lags behind an edit that made the file shorter, like the agent's on disk.
    const end = editor.document.lineAt(editor.document.validatePosition(editor.selection.active).line).range.end;
    editor.setDecorations(hint, what ? [{ range: new vscode.Range(end, end), renderOptions: { after: { contentText: `${KEY} ${what}` } } }] : []);
  };
  const decorate = async (editor: vscode.TextEditor) => {
    const doc = editor.document;
    if (doc.languageId !== 'llmd') return;
    // Done steps, and the trade-offs of a question's answers, so the choices stand out.
    const tradeoffs = questionsOf(doc.getText()).flatMap((q) => q.answers).map((a) => new vscode.Range(a.line, a.why, a.line, doc.lineAt(a.line).text.length));
    editor.setDecorations(dim, [...doneLines(doc.getText()).map((i) => doc.lineAt(i).range), ...tradeoffs]);
    if (editor === vscode.window.activeTextEditor) showHint(editor);
    const marks = (re: RegExp) => doc.getText().split('\n').flatMap((l, i) => {
      const at = l.search(re);
      return at < 0 ? [] : [new vscode.Range(i, at, i, at + 1)];
    });
    editor.setDecorations(asks, marks(/(?<=^\s*(?:-\s+)?)\?/));
    editor.setDecorations(checks, marks(/(?<=^\s*(?:-\s+)?)!(?=\s|$)/));
    const version = doc.version;
    const ranges = await newRanges(doc);
    if (doc.version === version) editor.setDecorations(fresh, ranges); // a newer edit decorates for itself
  };
  vscode.window.visibleTextEditors.forEach(decorate);
  const lensChanges = new vscode.EventEmitter<void>(); // the code changed under a built step, the agent is answering a ?, or it's another agent

  context.subscriptions.push(
    diagnostics,
    dim,
    fresh,
    asks,
    checks,
    hint,
    vscode.window.onDidChangeTextEditorSelection((e) => showHint(e.textEditor)),
    vscode.window.onDidChangeActiveTextEditor((editor) => editor ? showHint(editor) : vscode.commands.executeCommand('setContext', 'llmd.onQuestion', false)),
    vscode.commands.registerCommand('llmd.answer', () => vscode.window.activeTextEditor && answerHere(vscode.window.activeTextEditor)),
    lensChanges,
    onDidChangeCode(() => {
      lensChanges.fire();
      vscode.window.visibleTextEditors.forEach(decorate);
    }),
    vscode.workspace.onDidOpenTextDocument(check),
    vscode.workspace.onDidChangeTextDocument((e) => {
      check(e.document);
      vscode.window.visibleTextEditors.filter((ed) => ed.document === e.document).forEach(decorate);
    }),
    vscode.workspace.onDidCloseTextDocument((doc) => diagnostics.delete(doc.uri)),
    vscode.window.onDidChangeVisibleTextEditors((editors) => editors.forEach(decorate)),
    vscode.commands.registerCommand('llmd.enter', () => {
      const editor = vscode.window.activeTextEditor;
      return editor ? enter(editor) : vscode.commands.executeCommand('type', { source: 'keyboard', text: '\n' });
    }),

    vscode.commands.registerCommand('llmd.implement', (uri: vscode.Uri, step: string) => runStep('implement', uri, step)),
    vscode.commands.registerCommand('llmd.plan', (uri: vscode.Uri, step: string) => runStep('plan', uri, step)),
    vscode.commands.registerCommand('llmd.done', (spec: vscode.Uri, step: string) => done(openRun(spec, step))),
    vscode.commands.registerCommand('llmd.addToStep', addToStep),
    vscode.commands.registerCommand('llmd.decide', decide),
    vscode.commands.registerCommand('llmd.suggest', suggest),
    vscode.commands.registerCommand('llmd.settings', () => vscode.commands.executeCommand('workbench.action.openSettings', '@ext:viedin.llmd')),
    vscode.workspace.onDidChangeConfiguration((e) => e.affectsConfiguration('llmd.agent') && lensChanges.fire()),
    answered,
    answered.event(() => lensChanges.fire()),
    vscode.languages.registerCodeLensProvider(selector, {
      onDidChangeCodeLenses: lensChanges.event,
      provideCodeLenses: async (doc) => {
        const text = doc.getText();
        const lenses: vscode.CodeLens[] = [];
        // Implement and Plan start right away, in the step's run, which goes on with what you told it there before.
        for (const s of openSteps(text)) {
          const range = doc.lineAt(s.line).range;
          lenses.push(
            new vscode.CodeLens(range, { title: '$(play) Implement', tooltip: 'Run the agent on this step', command: 'llmd.implement', arguments: [doc.uri, s.title] }),
            new vscode.CodeLens(range, { title: '$(lightbulb) Plan', tooltip: 'Write what is unclear into the step as questions, without writing code', command: 'llmd.plan', arguments: [doc.uri, s.title] }),
          );
        }
        // A ? gets its answers to pick. With none yet, the agent can write them.
        const { name } = agent();
        for (const q of questionsOf(text)) {
          const range = doc.lineAt(q.line).range;
          if (!q.answers.length) lenses.push(new vscode.CodeLens(range, answering.has(`${doc.uri}#${q.question}`)
            ? { title: `$(loading~spin) ${name} is answering…`, command: '' }
            : { title: `$(sparkle) Ask ${name}`, tooltip: `${name} reads the step and its code, and writes answers to pick from`, command: 'llmd.suggest', arguments: [doc.uri, q.line] }));
          for (const a of q.answers) {
            const title = (a.recommended ? '$(star-full) ' : '') + (a.choice.length > 32 ? a.choice.slice(0, 31) + '…' : a.choice);
            lenses.push(new vscode.CodeLens(range, { title, tooltip: `Decide: ${a.text}`, command: 'llmd.decide', arguments: [doc.uri, q.line, a.text] }));
          }
        }
        // A built step waits for you. Done takes it out of the spec, once the code has everything the step lists.
        for (const [i, line] of text.split(/\r?\n/).entries()) {
          const step = line.match(/^##\s+\[[xX]\]\s*(.*?)\s*$/)?.[1];
          if (step === undefined) continue;
          const range = doc.lineAt(i).range;
          const gaps = await missing(rootOf(doc.uri), stepSection(text, step)?.lines ?? []);
          lenses.push(new vscode.CodeLens(range, gaps.length
            ? { title: `$(warning) Not in the code yet: ${gaps[0]}${gaps.length > 1 ? ` and ${gaps.length - 1} more` : ''}`, tooltip: gaps.join('\n'), command: '' }
            : { title: '$(check) Done', tooltip: 'Take this step out of the spec: the code has it now', command: 'llmd.done', arguments: [doc.uri, step] }));
        }
        return lenses;
      },
    }),

    vscode.languages.registerDocumentSymbolProvider(selector, {
      provideDocumentSymbols: (doc) => toSymbols(parseOutline(doc.getText()), doc),
    }),

    vscode.languages.registerDefinitionProvider(selector, { provideDefinition: findDefinition }),
    vscode.languages.registerHoverProvider(selector, { provideHover: hover }),
    vscode.languages.registerCompletionItemProvider(selector, { provideCompletionItems: completeNames, resolveCompletionItem: resolveCompletion }, '.', ':'),
    vscode.languages.registerDocumentSemanticTokensProvider(selector, { onDidChangeSemanticTokens: onDidChangeCode, provideDocumentSemanticTokens: typeTokens }, typeLegend),

    // A file dragged in from the Explorer, with Shift held, goes in as @path.
    vscode.languages.registerDocumentDropEditProvider(selector, {
      async provideDocumentDropEdits(doc, _pos, data) {
        const root = rootOf(doc.uri);
        const refs: string[] = [];
        for (const line of ((await data.get('text/uri-list')?.asString()) ?? '').split(/\r?\n/)) {
          if (!line.trim()) continue;
          const uri = vscode.Uri.parse(line.trim());
          const rel = path.relative(root.fsPath, uri.fsPath).split(path.sep).join('/');
          if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) continue;
          const folder = ((await statOrNull(uri))?.type ?? 0) & vscode.FileType.Directory;
          refs.push('@' + rel + (folder ? '/' : ''));
        }
        return refs.length ? new vscode.DocumentDropEdit(refs.join('\n')) : undefined;
      },
    }),

    vscode.languages.registerDocumentLinkProvider(selector, {
      provideDocumentLinks: async (doc) => (await scan(doc)).links,
    }),

    vscode.languages.registerCompletionItemProvider(selector, {
      async provideCompletionItems(doc, pos) {
        const before = doc.lineAt(pos).text.slice(0, pos.character);
        const m = before.match(/(?:^\s*\+|(?<![\w@])@)([\w\-./]*)$/); // @path anywhere, +path at the start of a line
        if (!m) return;
        const typed = m[1];
        const dir = typed.slice(0, typed.lastIndexOf('/') + 1);
        let entries: [string, boolean][];
        if (dir) {
          // After a "/", walk into that folder one level at a time.
          try {
            const listed = await vscode.workspace.fs.readDirectory(vscode.Uri.joinPath(rootOf(doc.uri), dir));
            entries = listed.filter(([name]) => name !== '.git').map(([name, type]) => {
              const isDir = (type & vscode.FileType.Directory) !== 0;
              return [name + (isDir ? '/' : ''), isDir];
            });
          } catch {
            return;
          }
        } else {
          // Right after @ or +, search the whole project: typing "book" finds cmd/internal/models/book.go.
          entries = await projectPaths(rootOf(doc.uri));
        }
        const replace = new vscode.Range(pos.translate(0, -(typed.length - dir.length)), pos);
        return entries.map(([name, isDir]) => {
          const item = new vscode.CompletionItem(name, isDir ? vscode.CompletionItemKind.Folder : vscode.CompletionItemKind.File);
          item.range = replace;
          item.sortText = (name.slice(0, -1).includes('/') ? '1' : '0') + (isDir ? '0' : '1') + name; // top level first
          // Keep the list open so you can walk into the folder.
          if (isDir) item.command = { command: 'editor.action.triggerSuggest', title: '' };
          return item;
        });
      },
    }, '@', '/', '+')
  );
}
