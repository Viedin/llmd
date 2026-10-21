import * as path from 'path';
import * as vscode from 'vscode';
import { OutlineNode, parseOutline } from './outline';
import { Claim, claims, claimSpan, isNew, receiverOf, Span, symbolName, typeSpans, typeWords, unitsOf } from './symbols';

// What the plan knows about the code: each file's symbols, from its language's own VS Code extension (C# Dev Kit, Go,
// Python…). The code is the proof of a step, so this is what tells new from existing and built from not yet.

export interface CodeSymbol {
  kind: vscode.SymbolKind;
  detail: string;
  at: vscode.Location; // its name in the file
  members: Map<string, CodeSymbol>; // a type's, by plain name
}

export const TYPES = new Set([vscode.SymbolKind.Class, vscode.SymbolKind.Interface, vscode.SymbolKind.Struct, vscode.SymbolKind.Enum]);
export const CALLABLE = new Set([vscode.SymbolKind.Method, vscode.SymbolKind.Function, vscode.SymbolKind.Constructor]);
// Symbols whose members are worth listing; a function's insides aren't.
export const CONTAINERS = new Set([...TYPES, vscode.SymbolKind.Module, vscode.SymbolKind.Namespace, vscode.SymbolKind.Package, vscode.SymbolKind.Object]);

const cache = new Map<string, Promise<Map<string, CodeSymbol> | undefined>>();
const named = new Map<string, Promise<CodeSymbol | undefined>>(); // the project's types by name
const changes = new vscode.EventEmitter<void>();
export const onDidChangeCode = changes.event; // a file changed, so what's new in a spec and what's built may have too
let settle: NodeJS.Timeout | undefined;

// A file's symbols by plain name, the first of each: its top level and the members of its classes and the like, which
// their class lists too.
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
      const methods: [string, string, CodeSymbol][] = []; // Go's, with the type they're for
      const walk = (list: (vscode.DocumentSymbol | vscode.SymbolInformation)[], owner?: CodeSymbol) => list.forEach((s) => {
        const name = symbolName(s.name);
        const range = 'selectionRange' in s ? s.selectionRange : s.location.range;
        const symbol = { kind: s.kind, detail: 'detail' in s ? s.detail : '', at: new vscode.Location(uri, range), members: new Map() };
        if (!map.has(name)) map.set(name, symbol);
        if (owner && !owner.members.has(name)) owner.members.set(name, symbol);
        const receiver = receiverOf(s.name);
        if (receiver) methods.push([receiver, name, symbol]);
        if ('children' in s && CONTAINERS.has(s.kind)) walk(s.children, symbol);
      });
      walk(found);
      for (const [type, name, symbol] of methods) if (!map.get(type)?.members.has(name)) map.get(type)?.members.set(name, symbol);
      return map;
    })();
    cache.set(key, symbols);
    symbols.then((map) => map || cache.delete(key)); // ask again next time rather than remember "no answer"
  }
  return symbols;
}

// The project's classes, interfaces, structs and enums its language's workspace search finds for `query`, not a library's.
// undefined when the search finds nothing at all, as before the language server is up.
export async function searchTypes(root: vscode.Uri, query: string): Promise<vscode.SymbolInformation[] | undefined> {
  let found: vscode.SymbolInformation[] | undefined;
  try {
    found = await vscode.commands.executeCommand('vscode.executeWorkspaceSymbolProvider', query);
  } catch {
    found = undefined;
  }
  return found?.length ? found.filter((s) => TYPES.has(s.kind) && s.location.uri.path.startsWith(root.path + '/')
    && !/\/(node_modules|vendor)\//.test(s.location.uri.path)) : undefined;
}

// The project's type of this name.
export function projectType(root: vscode.Uri, name: string): Promise<CodeSymbol | undefined> {
  const key = `${root}#${name}`;
  let type = named.get(key);
  if (!type) {
    type = (async () => {
      const found = await searchTypes(root, name);
      if (!found) named.delete(key); // ask again next time
      const hit = found?.find((s) => symbolName(s.name) === name);
      return hit && ((await symbolsOf(hit.location.uri))?.get(name) ?? { kind: hit.kind, detail: '', at: hit.location, members: new Map() });
    })();
    named.set(key, type);
  }
  return type;
}

// A claim's symbol among its file's: its type's member when the type has one by that name, else the file's.
export const symbolOf = (names: Map<string, CodeSymbol> | undefined, c: Claim) =>
  (c.type && names?.get(c.type)?.members.get(c.name)) || names?.get(c.name);

// The code's type of this name: in one of `files`, else anywhere in the project.
export async function typeNamed(root: vscode.Uri, files: string[], name: string): Promise<CodeSymbol | undefined> {
  for (const file of new Set(files)) {
    const s = (await symbolsOf(vscode.Uri.joinPath(root, file)))?.get(name);
    if (s && TYPES.has(s.kind)) return s;
  }
  return projectType(root, name);
}

// The names a spec lists that the code doesn't have yet: under a + unit, or missing from their @ file. The editor
// colors them as new.
export async function freshSpans(root: vscode.Uri, text: string): Promise<Span[]> {
  const lines = text.split('\n');
  const spans: Span[] = [];
  for (const c of claims(parseOutline(text))) {
    if (isNew(c, c.newFile ? undefined : await symbolsOf(vscode.Uri.joinPath(root, c.path)))) spans.push(claimSpan(lines, c));
  }
  return spans;
}

// The types a spec names in field types, signatures and after a ":" that the editor colors: the language's, the
// spec's own and the code's.
export async function typeSpansOf(root: vscode.Uri, text: string): Promise<Span[]> {
  const nodes = parseOutline(text);
  const files = unitsOf(nodes);
  const names = [...new Set(typeWords(text, nodes).map((w) => w.name))];
  const code = (await Promise.all(names.map(async (name) => (await typeNamed(root, files, name)) && name))).filter((n): n is string => !!n);
  return typeSpans(text, nodes, code);
}

// Where the code has what a step names, for the agent to go straight there instead of searching: the types and methods
// it lists under its files, and the types it names in signatures and after a ":". Then what it lists that the code
// doesn't have yet. Empty when there's nothing to say.
export async function whereNames(root: vscode.Uri, lines: string[]): Promise<string> {
  const text = lines.join('\n');
  const nodes = parseOutline(text);
  const found = new Map<string, string>();
  const fresh: string[] = [];
  const at = (s: CodeSymbol) =>
    `${path.relative(root.fsPath, s.at.uri.fsPath).split(path.sep).join('/')}:${s.at.range.start.line + 1} (${vscode.SymbolKind[s.kind].toLowerCase()})`;
  for (const c of claims(nodes)) {
    if (c.newFile) continue; // a + file is new as a whole
    const names = await symbolsOf(vscode.Uri.joinPath(root, c.path));
    const s = symbolOf(names, c);
    const label = (c.type ? `${c.type}.` : '') + c.name + (c.kind === 'method' ? '()' : '');
    if (s) found.set(label, at(s));
    else if (names) fresh.push(`${label} in ${c.path}`); // no symbols is no verdict
  }
  for (const w of typeWords(text, nodes)) {
    if (found.has(w.name)) continue;
    const s = await typeNamed(root, unitsOf(nodes), w.name);
    if (s) found.set(w.name, at(s));
  }
  return [
    ...(found.size ? ["Where the code has what the step names, so you don't have to search:", ...[...found].map(([name, where]) => `- ${name}: ${where}`)] : []),
    ...(fresh.length ? [`Not in the code yet: ${fresh.join(', ')}`] : []),
  ].join('\n');
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
    named.clear();
    clearTimeout(settle);
    settle = setTimeout(() => changes.fire(), 300);
  };
  const files = vscode.workspace.createFileSystemWatcher('**/*');
  context.subscriptions.push(changes, files, files.onDidChange(changed), files.onDidCreate(changed), files.onDidDelete(changed),
    vscode.workspace.onDidChangeTextDocument((e) => changed(e.document.uri)));
}
