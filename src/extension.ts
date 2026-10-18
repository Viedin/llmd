import * as path from 'path';
import * as vscode from 'vscode';
import { OutlineNode, parseOutline } from './outline';
import { findRefs } from './refs';
import { findCalls, indexSymbols, inPath } from './symbols';

// @paths resolve from the workspace folder, like Claude Code's @ mentions.
function rootOf(doc: vscode.TextDocument): vscode.Uri {
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
  return [...index].map(([name, d]) =>
    new vscode.CompletionItem(name, d.kind === 'type' ? vscode.CompletionItemKind.Class : vscode.CompletionItemKind.File));
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

// Lines of [x] methods plus the deeper-indented lines under them.
export function doneLines(text: string): number[] {
  const lines: number[] = [];
  let doneIndent = -1;
  text.split('\n').forEach((line, i) => {
    const indent = line.search(/\S/);
    if (indent === -1) return;
    if (doneIndent >= 0 && indent > doneIndent) {
      lines.push(i);
      return;
    }
    doneIndent = /^\s*-\s+\[[xX]\]/.test(line) ? indent : -1;
    if (doneIndent >= 0) lines.push(i);
  });
  return lines;
}

// Enter on an empty "- " drops the bullet and steps out one level; any other Enter is a normal one.
async function enter(editor: vscode.TextEditor) {
  const pos = editor.selection.active;
  const line = editor.document.lineAt(pos.line);
  const empty = line.text.match(/^( *)-\s*$/); // shortcut: assumes space indentation, which the language defaults to
  if (editor.selection.isEmpty && empty && pos.character === line.text.length) {
    await editor.edit((e) => e.replace(line.range, empty[1].slice(2)));
    return;
  }
  await vscode.commands.executeCommand('type', { source: 'keyboard', text: '\n' });
}

export function activate(context: vscode.ExtensionContext) {
  const selector: vscode.DocumentSelector = { language: 'llmd' };
  const diagnostics = vscode.languages.createDiagnosticCollection('llmd');

  const check = async (doc: vscode.TextDocument) => {
    if (doc.languageId === 'llmd') diagnostics.set(doc.uri, [...(await scan(doc)).problems, ...callProblems(doc)]);
  };
  vscode.workspace.textDocuments.forEach(check);

  const dim = vscode.window.createTextEditorDecorationType({ opacity: '0.5' });
  const decorate = (editor: vscode.TextEditor) => {
    if (editor.document.languageId !== 'llmd') return;
    editor.setDecorations(dim, doneLines(editor.document.getText()).map((i) => editor.document.lineAt(i).range));
  };
  vscode.window.visibleTextEditors.forEach(decorate);

  context.subscriptions.push(
    diagnostics,
    dim,
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

    vscode.languages.registerDocumentSymbolProvider(selector, {
      provideDocumentSymbols: (doc) => toSymbols(parseOutline(doc.getText()), doc),
    }),

    vscode.languages.registerDefinitionProvider(selector, { provideDefinition: findDefinition }),
    vscode.languages.registerCompletionItemProvider(selector, { provideCompletionItems: completeNames }, '.'),

    vscode.languages.registerDocumentLinkProvider(selector, {
      provideDocumentLinks: async (doc) => (await scan(doc)).links,
    }),

    vscode.languages.registerCompletionItemProvider(selector, {
      async provideCompletionItems(doc, pos) {
        const before = doc.lineAt(pos).text.slice(0, pos.character);
        const m = before.match(/(?<![\w@])@([\w\-./]*)$/);
        if (!m) return;
        const typed = m[1];
        const dir = typed.slice(0, typed.lastIndexOf('/') + 1);
        let entries: [string, vscode.FileType][];
        try {
          entries = await vscode.workspace.fs.readDirectory(vscode.Uri.joinPath(rootOf(doc), dir));
        } catch {
          return;
        }
        const replace = new vscode.Range(pos.translate(0, -(typed.length - dir.length)), pos);
        return entries
          .filter(([name]) => name !== '.git')
          .map(([name, type]) => {
            const isDir = (type & vscode.FileType.Directory) !== 0;
            const item = new vscode.CompletionItem(
              isDir ? name + '/' : name,
              isDir ? vscode.CompletionItemKind.Folder : vscode.CompletionItemKind.File
            );
            item.range = replace;
            item.sortText = (isDir ? '0' : '1') + name;
            // Keep the list open so you can walk into the folder.
            if (isDir) item.command = { command: 'editor.action.triggerSuggest', title: '' };
            return item;
          });
      },
    }, '@', '/')
  );
}
