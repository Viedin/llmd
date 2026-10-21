import * as vscode from 'vscode';
import { OutlineNode, parseOutline } from './outline';
import { claims, symbolName } from './symbols';

// What the plan knows about the code: each file's symbols, from its language's own VS Code extension (C# Dev Kit, Go,
// Python…). The code is the proof of a step, so this is what tells new from existing and built from not yet.

export interface CodeSymbol {
  kind: vscode.SymbolKind;
  detail: string;
  at: vscode.Location; // its name in the file
}

// Symbols whose members are worth listing; a function's insides aren't.
const CONTAINERS = new Set([vscode.SymbolKind.Class, vscode.SymbolKind.Interface, vscode.SymbolKind.Struct, vscode.SymbolKind.Enum,
  vscode.SymbolKind.Module, vscode.SymbolKind.Namespace, vscode.SymbolKind.Package, vscode.SymbolKind.Object]);

const cache = new Map<string, Promise<Map<string, CodeSymbol> | undefined>>();
const changes = new vscode.EventEmitter<void>();
export const onDidChangeCode = changes.event; // a file changed, so what's new in a spec and what's built may have too
let settle: NodeJS.Timeout | undefined;

// A file's symbols by plain name, the first of each: its top level and the members of its classes and the like.
// undefined when there's no answer: no extension for the language, not ready yet, or no such file.
export function symbolsOf(uri: vscode.Uri): Promise<Map<string, CodeSymbol> | undefined> {
  const key = uri.toString();
  let symbols = cache.get(key);
  if (!symbols) {
    symbols = (async () => {
      let found: (vscode.DocumentSymbol | vscode.SymbolInformation)[] | undefined;
      try {
        found = await vscode.commands.executeCommand('vscode.executeDocumentSymbolProvider', uri);
      } catch {
        return undefined;
      }
      if (!found?.length) return undefined;
      const map = new Map<string, CodeSymbol>();
      const walk = (list: (vscode.DocumentSymbol | vscode.SymbolInformation)[]) => list.forEach((s) => {
        const name = symbolName(s.name);
        const range = 'selectionRange' in s ? s.selectionRange : s.location.range;
        if (!map.has(name)) map.set(name, { kind: s.kind, detail: 'detail' in s ? s.detail : '', at: new vscode.Location(uri, range) });
        if ('children' in s && CONTAINERS.has(s.kind)) walk(s.children);
      });
      walk(found);
      return map;
    })();
    cache.set(key, symbols);
    symbols.then((map) => map || cache.delete(key)); // ask again next time rather than remember "no answer"
  }
  return symbols;
}

// The hover the file's own language shows on a symbol: its signature and doc comment.
export async function codeHover(at: vscode.Location): Promise<vscode.MarkdownString | undefined> {
  const hovers = await vscode.commands.executeCommand<vscode.Hover[]>('vscode.executeHoverProvider', at.uri, at.range.start);
  const md = new vscode.MarkdownString();
  for (const c of (hovers ?? []).flatMap((h) => h.contents)) {
    if (typeof c === 'string') md.appendMarkdown(c);
    else if ('language' in c) md.appendCodeblock(c.value, c.language);
    else md.appendMarkdown(c.value);
    md.appendMarkdown('\n\n');
  }
  return md.value.trim() ? md : undefined;
}

// What a built step lists that the code doesn't have: a file that isn't there, or a type or method its file has no
// symbol for. A file whose language gives no symbols, or a folder, only has to exist.
// ponytail: names only, not signatures or logic; the step's tick vouches for those
export async function missing(root: vscode.Uri, lines: string[]): Promise<string[]> {
  const nodes = parseOutline(lines.join('\n'));
  const units = new Set<string>();
  const walk = (nodes: OutlineNode[]) => nodes.forEach((n) => (n.kind === 'unit' ? units.add(n.name) : walk(n.children)));
  walk(nodes);
  const gone = new Set<string>();
  for (const unit of units) {
    try {
      await vscode.workspace.fs.stat(vscode.Uri.joinPath(root, unit));
    } catch {
      gone.add(unit);
    }
  }
  const out = [...gone].map((unit) => `${unit} doesn't exist`);
  for (const c of claims(nodes)) {
    if (gone.has(c.path)) continue;
    const names = await symbolsOf(vscode.Uri.joinPath(root, c.path));
    if (names && !names.has(c.name)) out.push(`${c.path} has no '${c.name}'`);
  }
  return out;
}

// Forgets a file's symbols whenever it changes, in an editor or on disk, and says so once things settle.
export function watchCode(context: vscode.ExtensionContext) {
  const changed = (uri: vscode.Uri) => {
    if (uri.scheme !== 'file' || uri.fsPath.endsWith('.llmd')) return;
    cache.delete(uri.toString());
    clearTimeout(settle);
    settle = setTimeout(() => changes.fire(), 300);
  };
  const files = vscode.workspace.createFileSystemWatcher('**/*');
  context.subscriptions.push(changes, files, files.onDidChange(changed), files.onDidCreate(changed), files.onDidDelete(changed),
    vscode.workspace.onDidChangeTextDocument((e) => changed(e.document.uri)));
}
