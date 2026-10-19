import * as path from 'path';
import * as vscode from 'vscode';
import { agentCommand } from './agent';
import { OutlineNode, openSteps, parseOutline } from './outline';
import { findRefs, projectOf } from './refs';
import { builtinTypes, Claim, claims, findCalls, indexSymbols, inPath, inTypePosition, symbolName, typeSpans } from './symbols';

// @paths resolve from the project: the folder holding .llmd/, else the workspace folder, like Claude Code's @ mentions.
function rootOf(doc: vscode.TextDocument): vscode.Uri {
  const project = projectOf(doc.uri.fsPath);
  if (project) return vscode.Uri.file(project);
  const ws = vscode.workspace.getWorkspaceFolder(doc.uri);
  return ws ? ws.uri : vscode.Uri.file(path.dirname(doc.uri.fsPath));
}

async function statOrNull(uri: vscode.Uri): Promise<vscode.FileStat | null> {
  try {
    return await vscode.workspace.fs.stat(uri);
  } catch {
    return null;
  }
}

async function scan(doc: vscode.TextDocument) {
  const root = rootOf(doc);
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
    const symbol = new vscode.DocumentSymbol(n.name, n.detail, SYMBOL_KIND[n.kind], range, name);
    symbol.children = toSymbols(n.children, doc);
    return symbol;
  });
}

const indexOf = (doc: vscode.TextDocument) => indexSymbols(parseOutline(doc.getText()));

export function findDefinition(doc: vscode.TextDocument, pos: vscode.Position): vscode.Location | undefined {
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

export function completeNames(doc: vscode.TextDocument, pos: vscode.Position): vscode.CompletionItem[] {
  const text = doc.lineAt(pos).text;
  if (inPath(text, pos.character)) return [];
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
    const range = new vscode.Range(c.line, c.start, c.line, c.end);
    return [new vscode.Diagnostic(range, `${c.name} has no member '${c.member}'`, vscode.DiagnosticSeverity.Warning)];
  });
}

// Symbol names per code file, from its language's own extension. Dropped when the file is saved.
const codeSymbols = new Map<string, Promise<Set<string> | undefined>>();

function symbolsOf(uri: vscode.Uri): Promise<Set<string> | undefined> {
  const key = uri.toString();
  let names = codeSymbols.get(key);
  if (!names) {
    names = (async () => {
      const found = await vscode.commands.executeCommand<(vscode.DocumentSymbol | vscode.SymbolInformation)[] | undefined>(
        'vscode.executeDocumentSymbolProvider', uri);
      if (!found?.length) return undefined; // no provider, or it isn't ready yet: no verdict
      const set = new Set<string>();
      const walk = (symbols: (vscode.DocumentSymbol | vscode.SymbolInformation)[]) => symbols.forEach((s) => {
        set.add(symbolName(s.name));
        if ('children' in s) walk(s.children);
      });
      walk(found);
      return set;
    })();
    codeSymbols.set(key, names);
    names.then((set) => set || codeSymbols.delete(key)); // ask again next time rather than remember "no answer"
  }
  return names;
}

const driftProblem = (doc: vscode.TextDocument, c: Claim) => {
  const line = doc.lineAt(c.line);
  const range = new vscode.Range(c.line, line.firstNonWhitespaceCharacterIndex, c.line, line.text.length);
  return new vscode.Diagnostic(range, `${c.path} has no '${c.name}'`, vscode.DiagnosticSeverity.Warning);
};

// Types and methods that done steps declare but the code no longer has.
export async function driftProblems(doc: vscode.TextDocument): Promise<vscode.Diagnostic[]> {
  const root = rootOf(doc);
  const files = new Map<string, Promise<Set<string> | undefined>>();
  const problems: vscode.Diagnostic[] = [];
  for (const c of claims(parseOutline(doc.getText()))) {
    if (!files.has(c.path)) {
      const uri = vscode.Uri.joinPath(root, c.path);
      // Missing files already warn; folder units like Go packages aren't checked.
      files.set(c.path, statOrNull(uri).then((stat) => (stat && stat.type & vscode.FileType.File ? symbolsOf(uri) : undefined)));
    }
    const names = await files.get(c.path)!;
    if (names && !names.has(c.name)) problems.push(driftProblem(doc, c));
  }
  return problems;
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

// Enter on an empty "- " or "* " steps out one level and keeps the bullet, so a method's logic ends in its next sibling;
// at the outermost level it drops the bullet. Any other Enter is a normal one.
async function enter(editor: vscode.TextEditor) {
  const pos = editor.selection.active;
  const line = editor.document.lineAt(pos.line);
  const empty = line.text.match(/^( *)([-*])\s*$/); // shortcut: assumes space indentation, which the language defaults to
  if (editor.selection.isEmpty && empty && pos.character === line.text.length) {
    const outer = empty[1].slice(2);
    await editor.edit((e) => e.replace(line.range, outer && `${outer}${empty[2]} `));
    return;
  }
  await vscode.commands.executeCommand('type', { source: 'keyboard', text: '\n' });
}

// Starts the agent in a new terminal, at the project root, on one step of the saved spec.
async function implement(uri: vscode.Uri, step: string) {
  const doc = await vscode.workspace.openTextDocument(uri);
  if (doc.isUntitled) return vscode.window.showWarningMessage('Save the spec first, so the agent can read it.');
  await doc.save();
  const root = rootOf(doc);
  const file = path.relative(root.fsPath, doc.uri.fsPath).split(path.sep).join('/');
  const command = vscode.workspace.getConfiguration('llmd').get<string>('agentCommand') || 'claude';
  const terminal = vscode.window.createTerminal({ name: `LLMD: ${step}`, cwd: root });
  terminal.show();
  terminal.sendText(agentCommand(command, step, file, vscode.env.shell));
}

export function activate(context: vscode.ExtensionContext) {
  const selector: vscode.DocumentSelector = { language: 'llmd' };
  const diagnostics = vscode.languages.createDiagnosticCollection('llmd');

  // Drift is worked out on open and on save. In between, its warnings follow their lines but nothing new is flagged,
  // so a half-typed name in Current state doesn't warn.
  const drift = new Map<string, Set<string>>(); // spec → drift messages from its last check
  const check = async (doc: vscode.TextDocument) => {
    if (doc.languageId !== 'llmd') return;
    const known = drift.get(doc.uri.toString()) ?? new Set();
    const drifted = claims(parseOutline(doc.getText())).map((c) => driftProblem(doc, c)).filter((d) => known.has(d.message));
    diagnostics.set(doc.uri, [...(await scan(doc)).problems, ...callProblems(doc), ...drifted]);
  };
  const checkDrift = async (doc: vscode.TextDocument) => {
    if (doc.languageId !== 'llmd') return;
    drift.set(doc.uri.toString(), new Set((await driftProblems(doc)).map((d) => d.message)));
    await check(doc);
  };
  vscode.workspace.textDocuments.forEach(checkDrift);

  const dim = vscode.window.createTextEditorDecorationType({ opacity: '0.5' });
  const decorate = (editor: vscode.TextEditor) => {
    if (editor.document.languageId !== 'llmd') return;
    editor.setDecorations(dim, doneLines(editor.document.getText()).map((i) => editor.document.lineAt(i).range));
  };
  vscode.window.visibleTextEditors.forEach(decorate);

  context.subscriptions.push(
    diagnostics,
    dim,
    vscode.workspace.onDidOpenTextDocument(checkDrift),
    vscode.workspace.onDidSaveTextDocument((saved) => {
      codeSymbols.delete(saved.uri.toString());
      vscode.workspace.textDocuments.forEach(checkDrift);
    }),
    vscode.workspace.onDidChangeTextDocument((e) => {
      check(e.document);
      vscode.window.visibleTextEditors.filter((ed) => ed.document === e.document).forEach(decorate);
    }),
    vscode.workspace.onDidCloseTextDocument((doc) => {
      diagnostics.delete(doc.uri);
      drift.delete(doc.uri.toString());
    }),
    vscode.window.onDidChangeVisibleTextEditors((editors) => editors.forEach(decorate)),
    vscode.commands.registerCommand('llmd.enter', () => {
      const editor = vscode.window.activeTextEditor;
      return editor ? enter(editor) : vscode.commands.executeCommand('type', { source: 'keyboard', text: '\n' });
    }),

    vscode.commands.registerCommand('llmd.implement', implement),
    vscode.languages.registerCodeLensProvider(selector, {
      provideCodeLenses: (doc) => openSteps(doc.getText()).map((s) => new vscode.CodeLens(doc.lineAt(s.line).range,
        { title: '$(play) Implement', tooltip: 'Run the agent on this step', command: 'llmd.implement', arguments: [doc.uri, s.title] })),
    }),

    vscode.languages.registerDocumentSymbolProvider(selector, {
      provideDocumentSymbols: (doc) => toSymbols(parseOutline(doc.getText()), doc),
    }),

    vscode.languages.registerDefinitionProvider(selector, { provideDefinition: findDefinition }),
    vscode.languages.registerCompletionItemProvider(selector, { provideCompletionItems: completeNames }, '.', ':'),
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
            const listed = await vscode.workspace.fs.readDirectory(vscode.Uri.joinPath(rootOf(doc), dir));
            entries = listed.filter(([name]) => name !== '.git').map(([name, type]) => {
              const isDir = (type & vscode.FileType.Directory) !== 0;
              return [name + (isDir ? '/' : ''), isDir];
            });
          } catch {
            return;
          }
        } else {
          // Right after @ or +, search the whole project: typing "book" finds cmd/internal/models/book.go.
          entries = await projectPaths(rootOf(doc));
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
