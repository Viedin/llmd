import { OutlineNode } from './outline';

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

const PATH = /(?<![\w@])[@+][\w\-./]+/g;
const CALL = /(?<![\w./-])([A-Za-z_]\w*)\.([A-Za-z_]\w*)/g;

export function indexSymbols(nodes: OutlineNode[]): Map<string, Declared> {
  const index = new Map<string, Declared>();
  const declare = (key: string, kind: Declared['kind'], node: OutlineNode) => {
    if (!key) return; // folder units like @src/
    let declared = index.get(key);
    if (!declared) index.set(key, (declared = { kind, line: node.line, members: new Map() }));
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
