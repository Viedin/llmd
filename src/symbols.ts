import { OutlineNode, TYPE, UNIT } from './outline';

export interface Declared {
  kind: 'type' | 'unit';
  line: number;
  members: Map<string, number>;
}

export interface Call {
  name: string;
  member: string;
  line: number;
  start: number;
  end: number;
}

export interface Claim {
  path: string;
  name: string;
  line: number;
  newFile: boolean; // under a + unit
}

// The types and methods the spec lists under its units, which the code either has or is going to get.
// Fields are left out because many languages don't list them as symbols.
export function claims(nodes: OutlineNode[]): Claim[] {
  return nodes.flatMap((n) => {
    if (n.kind === 'heading') return claims(n.children);
    if (n.kind !== 'unit') return [];
    const inside = (nodes: OutlineNode[]): Claim[] => nodes.flatMap((c) =>
      c.kind === 'type' || c.kind === 'method' ? [{ path: n.name, name: c.name, line: c.line, newFile: n.detail === 'new file' }, ...inside(c.children)] : []);
    return inside(n.children);
  });
}

// Whether a claim is something the step adds: everything in a + unit, or a name its @ file's symbols don't have.
// No symbols, as when the language has no extension, is no verdict: not new.
export const isNew = (c: Claim, names?: { has(name: string): boolean }) => c.newFile || (!!names && !names.has(c.name));

// The unit whose members `line` lists, directly or under one of its types: its path, or undefined on a logic line or
// outside a unit.
export function unitAbove(text: string, line: number): string | undefined {
  const lines = text.split('\n').map((l) => l.replace(/\r$/, ''));
  let indent = lines[line].search(/\S/);
  for (let i = line - 1; i >= 0 && indent > 0; i--) {
    const at = lines[i].search(/\S/);
    if (at < 0 || at >= indent) continue;
    const unit = lines[i].match(UNIT);
    if (unit) return unit[2];
    if (!TYPE.test(lines[i])) return undefined;
    indent = at;
  }
}

// The candidate a typo most likely meant, ignoring case: at most 1 edit away for names up to 4 letters, 2 for longer ones.
export function closest(name: string, candidates: Iterable<string>): string | undefined {
  let best: string | undefined;
  let bestDistance = name.length <= 4 ? 2 : 3;
  for (const c of candidates) {
    const d = distance(name.toLowerCase(), c.toLowerCase());
    if (d < bestDistance) [best, bestDistance] = [c, d];
  }
  return best;
}

// Levenshtein distance: inserts, deletes and swaps of one letter each count 1.
function distance(a: string, b: string): number {
  let row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const next = [i];
    for (let j = 1; j <= b.length; j++) next[j] = Math.min(row[j] + 1, next[j - 1] + 1, row[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    row = next;
  }
  return row[b.length];
}

// A code symbol's plain name: "Add(double, double)", "(*Book).Save" and "List<T>" become "Add", "Save" and "List".
export function symbolName(name: string): string {
  return name.replace(/^\(.*?\)\./, '').replace(/[(<].*$/, '').split('.').pop()!.trim();
}

const PATH = /(?<![\w@])[@+][\w\-./]+/g;
const CALL = /(?<![\w./-])([A-Za-z_]\w*)\.([A-Za-z_]\w*)/g;

export function indexSymbols(nodes: OutlineNode[]): Map<string, Declared> {
  const index = new Map<string, Declared>();
  const declare = (key: string, kind: Declared['kind'], node: OutlineNode) => {
    if (!key) return; // folder units like @src/
    let declared = index.get(key);
    if (!declared) index.set(key, (declared = { kind, line: node.line, members: new Map() }));
    else if (kind === 'type' && declared.kind === 'unit') Object.assign(declared, { kind, line: node.line }); // type book in book.go wins
    for (const child of node.children) if (!declared.members.has(child.name)) declared.members.set(child.name, child.line);
  };
  const walk = (nodes: OutlineNode[]) =>
    nodes.forEach((n) => {
      if (n.kind === 'unit') declare(n.name.split('/').pop()!.replace(/\.[^.]*$/, ''), 'unit', n);
      if (n.kind === 'type') declare(n.name, 'type', n);
      walk(n.children);
    });
  walk(nodes);
  return index;
}

// True when col is inside (or right at the end of) an @path or +path on this line.
export function inPath(line: string, col: number): boolean {
  return [...line.matchAll(PATH)].some((m) => col >= m.index! && col <= m.index! + m[0].length);
}

export function findCalls(text: string): Call[] {
  const calls: Call[] = [];
  let inFence = false;
  text.split('\n').forEach((raw, line) => {
    if (/^\s*(```|~~~)/.test(raw)) inFence = !inFence;
    else if (!inFence) {
      const masked = raw.replace(PATH, (p) => ' '.repeat(p.length));
      for (const m of masked.matchAll(CALL)) {
        calls.push({ name: m[1], member: m[2], line, start: m.index!, end: m.index! + m[0].length });
      }
    }
  });
  return calls;
}

// ponytail: the everyday built-in types per language, not full type systems; add a language when a spec needs it.
const BUILTINS: Record<string, string[]> = {
  go: ['bool', 'byte', 'rune', 'string', 'error', 'any', 'int', 'int8', 'int16', 'int32', 'int64', 'uint', 'uint8', 'uint16', 'uint32', 'uint64', 'float32', 'float64', 'map', 'chan'],
  csharp: ['bool', 'byte', 'char', 'decimal', 'double', 'float', 'int', 'long', 'object', 'short', 'string', 'uint', 'ulong', 'void', 'var', 'List', 'Dictionary', 'Task', 'DateTime', 'Guid'],
  typescript: ['string', 'number', 'boolean', 'bigint', 'void', 'any', 'unknown', 'never', 'null', 'undefined', 'object', 'Promise', 'Array', 'Map', 'Set', 'Record', 'Date'],
  python: ['int', 'float', 'str', 'bool', 'bytes', 'None', 'list', 'dict', 'set', 'tuple', 'Any', 'Optional'],
  rust: ['bool', 'char', 'str', 'String', 'i8', 'i16', 'i32', 'i64', 'u8', 'u16', 'u32', 'u64', 'usize', 'isize', 'f32', 'f64', 'Vec', 'Option', 'Result', 'Box', 'HashMap'],
  java: ['boolean', 'byte', 'char', 'double', 'float', 'int', 'long', 'short', 'void', 'String', 'Object', 'List', 'Map', 'Set', 'Optional'],
};
const ALIASES: Record<string, string> = { golang: 'go', 'c#': 'csharp', cs: 'csharp', ts: 'typescript', javascript: 'typescript', js: 'typescript', py: 'python', rs: 'rust' };

// The built-in types for the spec's "lang:" line; every language's when there is none or it's unknown.
export function builtinTypes(text: string): string[] {
  const lang = text.match(/^lang:\s*(\S+)/m)?.[1].toLowerCase();
  const known = lang && BUILTINS[ALIASES[lang] ?? lang];
  return known || [...new Set(Object.values(BUILTINS).flat())];
}

// True when col is where a type goes: after "- name:" in a field, or after the name in "- name(...) -> ...".
export function inTypePosition(line: string, col: number): boolean {
  const m = line.match(/^\s*-\s+(?:\[[ xX]\]\s+)?[A-Za-z_]\w*\s*[:(]/);
  return !!m && col >= m[0].length;
}

// Known type names (built-in or declared in the spec) in field types and method signatures, for coloring.
export function typeSpans(text: string, nodes: OutlineNode[]): { line: number; start: number; end: number }[] {
  const known = new Set(builtinTypes(text));
  for (const [name, d] of indexSymbols(nodes)) if (d.kind === 'type') known.add(name);
  const lines = text.split('\n');
  const spans: { line: number; start: number; end: number }[] = [];
  const walk = (nodes: OutlineNode[]) => nodes.forEach((n) => {
    if (n.kind === 'field' || n.kind === 'method') {
      const line = lines[n.line].replace(/\r$/, '');
      const from = line.indexOf(n.name) + n.name.length;
      for (const m of line.slice(from).matchAll(/(?<![\w.])[A-Za-z_]\w*(?![\w.])/g)) {
        if (known.has(m[0])) spans.push({ line: n.line, start: from + m.index!, end: from + m.index! + m[0].length });
      }
    }
    walk(n.children);
  });
  walk(nodes);
  return spans;
}
