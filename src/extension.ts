import * as path from 'path';
import * as vscode from 'vscode';
import { codeHover, missing, onDidChangeCode, symbolsOf, watchCode } from './code';
import { OutlineNode, openSteps, parseOutline, stepSection } from './outline';
import { done, hasRun, initRuns, onDidChangeRuns, openRun, rootOf, runKey, runs, runStep } from './run';
import { findRefs } from './refs';
import { builtinTypes, Claim, claims, closest, findCalls, indexSymbols, inPath, inTypePosition, isNew, typeSpans, unitAbove } from './symbols';

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

// The types and methods the spec plans that the code doesn't have yet: under a + unit, or missing from their @ file.
export async function newRanges(doc: vscode.TextDocument): Promise<vscode.Range[]> {
  const ranges: vscode.Range[] = [];
  for (const c of claims(parseOutline(doc.getText()))) {
    if (isNew(c, c.newFile ? undefined : await codeOf(doc, c.path))) ranges.push(nameRange(doc, c));
  }
  return ranges;
}

// On a type or method the code has: its real hover. On one it doesn't have yet: that it's new.
async function hover(doc: vscode.TextDocument, pos: vscode.Position): Promise<vscode.Hover | undefined> {
  const c = claimAt(doc, pos);
  if (!c) return;
  const range = nameRange(doc, c);
  if (c.newFile) return new vscode.Hover(`New: \`${c.path}\` is a new file`, range);
  const names = await codeOf(doc, c.path);
  const symbol = names?.get(c.name);
  if (!symbol) return names && new vscode.Hover(`New: \`${c.path}\` has no \`${c.name}\` yet`, range);
  const md = await codeHover(symbol.at);
  return md && new vscode.Hover(md, range);
}

// Ctrl+click on a type or method the code has opens it in its file; on a name in a logic line, its line in the spec.
export async function findDefinition(doc: vscode.TextDocument, pos: vscode.Position): Promise<vscode.Location | undefined> {
  const c = claimAt(doc, pos);
  const symbol = c && (await codeOf(doc, c.path))?.get(c.name);
  if (symbol) return symbol.at;
  const range = doc.getWordRangeAtPosition(pos, /[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)?/);
  if (!range || inPath(doc.lineAt(pos).text, pos.character)) return; // @paths open the file instead
  const [name, member] = doc.getText(range).split('.');
  const declared = indexOf(doc).get(name);
  if (!declared) return;
  const onMember = member !== undefined && pos.character > range.start.character + name.length;
  const line = onMember ? declared.members.get(member) : declared.line;
  if (line === undefined) return;
  return new vscode.Location(doc.uri, new vscode.Position(line, doc.lineAt(line).firstNonWhitespaceCharacterIndex));
}

const CALLABLE = new Set([vscode.SymbolKind.Method, vscode.SymbolKind.Function, vscode.SymbolKind.Constructor]);
const TYPES = new Set([vscode.SymbolKind.Class, vscode.SymbolKind.Interface, vscode.SymbolKind.Struct, vscode.SymbolKind.Enum]);
const symbolAt = new WeakMap<vscode.CompletionItem, vscode.Location>(); // where a completion's symbol is, for its docs

// The unit's real types and methods, written the spec's way: "save()" and ": Store".
async function codeCompletions(doc: vscode.TextDocument, unit: string): Promise<vscode.CompletionItem[]> {
  return [...((await codeOf(doc, unit)) ?? [])].map(([name, s]) => {
    const kind = CALLABLE.has(s.kind) ? vscode.CompletionItemKind.Method : TYPES.has(s.kind) ? vscode.CompletionItemKind.Class : vscode.CompletionItemKind.Field;
    const item = new vscode.CompletionItem(name, kind);
    item.insertText = CALLABLE.has(s.kind) ? `${name}()` : TYPES.has(s.kind) ? `: ${name}` : name;
    item.detail = s.detail || unit;
    symbolAt.set(item, s.at);
    return item;
  });
}

// A completion of a real symbol gets its docs when it's picked out in the list.
async function resolveCompletion(item: vscode.CompletionItem) {
  const at = symbolAt.get(item);
  if (at) item.documentation = await codeHover(at);
  return item;
}

export async function completeNames(doc: vscode.TextDocument, pos: vscode.Position): Promise<vscode.CompletionItem[]> {
  const text = doc.lineAt(pos).text;
  if (inPath(text, pos.character)) return [];
  // A new line under a unit offers what its file really has.
  const unit = /^\s*-\s+\w*$/.test(text.slice(0, pos.character)) && unitAbove(doc.getText(), pos.line);
  const code = unit ? await codeCompletions(doc, unit) : [];
  if (code.length) return code;
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
  if (inTypePosition(text, pos.character)) {
    const declared = [...index].filter(([, d]) => d.kind === 'type').map(([name]) => new vscode.CompletionItem(name, vscode.CompletionItemKind.Class));
    const builtin = builtinTypes(doc.getText()).filter((t) => !index.has(t)).map((t) => new vscode.CompletionItem(t, vscode.CompletionItemKind.TypeParameter));
    declared.forEach((i) => (i.sortText = '0' + i.label)); // the spec's own types first
    return [...declared, ...builtin];
  }
  if (text.slice(0, pos.character).endsWith(':')) return [];
  return [...index].map(([name, d]) =>
    new vscode.CompletionItem(name, d.kind === 'type' ? vscode.CompletionItemKind.Class : vscode.CompletionItemKind.File));
}

const typeLegend = new vscode.SemanticTokensLegend(['type']);

function typeTokens(doc: vscode.TextDocument): vscode.SemanticTokens {
  const text = doc.getText();
  const tokens = new vscode.SemanticTokensBuilder(typeLegend);
  for (const s of typeSpans(text, parseOutline(text))) tokens.push(s.line, s.start, s.end - s.start, 0);
  return tokens.build();
}

const SKIP = new Set(['.git', 'node_modules', 'out', 'dist', 'build', 'bin', 'obj', '.vscode-test']);

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
    vscode.languages.registerDocumentSemanticTokensProvider(selector, { provideDocumentSemanticTokens: typeTokens }, typeLegend),

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
