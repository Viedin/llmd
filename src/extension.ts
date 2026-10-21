import * as path from 'path';
import * as vscode from 'vscode';
import { CALLABLE, codeHover, CodeSymbol, CONTAINERS, missing, onDidChangeCode, searchTypes, symbolOf, symbolsOf, typeNamed, TYPES, watchCode } from './code';
import { OutlineNode, openSteps, parseOutline, placeIn, Segment, stepSection } from './outline';
import { done, hasRun, initRuns, nextSteps, onDidChangeRuns, openRun, rootOf, runKey, runs, runStep } from './run';
import { findRefs } from './refs';
import { builtinTypes, Claim, claims, closest, findCalls, indexSymbols, inPath, inTypePosition, isNew, ownerAbove, receiverOf, symbolName, typeSpans, typeWords, unitsOf } from './symbols';

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

// Where a claimed type or method's name sits on its line.
function nameRange(doc: vscode.TextDocument, c: Claim): vscode.Range {
  const line = doc.lineAt(c.line);
  const start = line.text.indexOf(c.name, line.firstNonWhitespaceCharacterIndex);
  return new vscode.Range(c.line, start, c.line, start + c.name.length);
}

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
  const ranges: vscode.Range[] = [];
  for (const c of claims(parseOutline(doc.getText()))) {
    if (isNew(c, c.newFile ? undefined : await codeOf(doc, c.path))) ranges.push(nameRange(doc, c));
  }
  return ranges;
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

// The spec's, the language's and the code's types in field types and signatures.
async function typeTokens(doc: vscode.TextDocument): Promise<vscode.SemanticTokens> {
  const text = doc.getText();
  const nodes = parseOutline(text);
  const names = [...new Set(typeWords(text, nodes).map((w) => w.name))];
  const code = (await Promise.all(names.map(async (name) => (await codeType(doc, name)) && name))).filter((n): n is string => !!n);
  const tokens = new vscode.SemanticTokensBuilder(typeLegend);
  for (const s of typeSpans(text, nodes, code)) tokens.push(s.line, s.start, s.end - s.start, 0);
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
      await vscode.workspace.applyEdit(edit);
    }
    at = place.at;
  }
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
  const decorate = async (editor: vscode.TextEditor) => {
    const doc = editor.document;
    if (doc.languageId !== 'llmd') return;
    editor.setDecorations(dim, doneLines(doc.getText()).map((i) => doc.lineAt(i).range));
    const version = doc.version;
    const ranges = await newRanges(doc);
    if (doc.version === version) editor.setDecorations(fresh, ranges); // a newer edit decorates for itself
  };
  vscode.window.visibleTextEditors.forEach(decorate);
  const lensChanges = new vscode.EventEmitter<void>(); // a run started or ended, or the code changed under a built step

  context.subscriptions.push(
    diagnostics,
    dim,
    fresh,
    lensChanges,
    onDidChangeRuns(() => lensChanges.fire()),
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
    vscode.languages.registerCodeLensProvider(selector, {
      onDidChangeCodeLenses: lensChanges.event,
      provideCodeLenses: async (doc) => {
        const text = doc.getText();
        const lenses: vscode.CodeLens[] = [];
        // A step that has a run gets a way back to it, which says when the agent is still working there.
        const back = (range: vscode.Range, step: string) => {
          if (!hasRun(doc.uri, step)) return;
          const working = !!runs.get(runKey(doc.uri, step))?.child;
          lenses.push(new vscode.CodeLens(range, { title: working ? '$(loading~spin) Working…' : '$(comment-discussion) Run', tooltip: "Open this step's run", command: 'llmd.run', arguments: [doc.uri, step] }));
        };
        for (const s of openSteps(text)) {
          const range = doc.lineAt(s.line).range;
          // Once a step has a run, Implement and Plan are in its run's bar, so the lens just goes back there.
          if (hasRun(doc.uri, s.title)) back(range, s.title);
          else lenses.push(
            new vscode.CodeLens(range, { title: '$(play) Implement', tooltip: 'Run the agent on this step', command: 'llmd.implement', arguments: [doc.uri, s.title] }),
            new vscode.CodeLens(range, { title: '$(lightbulb) Plan', tooltip: 'Talk this step through with the agent, without writing code', command: 'llmd.plan', arguments: [doc.uri, s.title] }),
          );
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
          back(range, step);
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
