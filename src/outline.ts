export interface OutlineNode {
  kind: 'heading' | 'unit' | 'type' | 'method' | 'field';
  name: string;
  detail: string;
  line: number;
  endLine: number;
  children: OutlineNode[];
}

const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
export const UNIT = /^\s*([@+])([\w\-./]+)\s*$/;
export const TYPE = /^\s*(?:-\s+)?:\s*([A-Za-z_]\w*)/; // ": Book" or "- : Book"
export const METHOD = /^\s*-\s+(?:\[[ xX]\]\s+)?([A-Za-z_]\w*)(\(.*?\)(?:\s*->\s*.+?)?)\s*$/;
export const FIELD = /^\s*-\s+([A-Za-z_]\w*)\s*:\s*(.+?)\s*$/;

export function parseOutline(text: string): OutlineNode[] {
  const roots: OutlineNode[] = [];
  const headings: { level: number; node: OutlineNode }[] = [];
  let open: { indent: number; node: OutlineNode }[] = []; // unit/type/method/field chain under the current heading
  let inFence = false;

  const node = (kind: OutlineNode['kind'], name: string, detail: string, line: number): OutlineNode =>
    ({ kind, name, detail, line, endLine: line, children: [] });
  const add = (n: OutlineNode, parent?: OutlineNode) => (parent ? parent.children : roots).push(n);

  text.split('\n').forEach((raw, i) => {
    const line = raw.replace(/\r$/, '');
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
    if (line.trim() === '') return;
    // Every non-blank line (fences included) extends whatever is still open above it.
    const extend = () => {
      headings.forEach((h) => (h.node.endLine = i));
      open.forEach((o) => (o.node.endLine = i));
    };
    if (inFence || /^\s*(```|~~~)/.test(line)) return extend();

    const h = line.match(HEADING);
    if (h) {
      const level = h[1].length;
      while (headings.length && headings[headings.length - 1].level >= level) headings.pop();
      open = [];
      extend();
      const box = h[2].match(/^\[([ xX])\]\s*/); // step checkbox: "## [x] Title"
      const n = node('heading', box ? h[2].slice(box[0].length) : h[2], box && box[1] !== ' ' ? 'done' : '', i);
      add(n, headings[headings.length - 1]?.node);
      headings.push({ level, node: n });
      return;
    }

    const indent = line.search(/\S/);
    while (open.length && open[open.length - 1].indent >= indent) open.pop();
    extend();
    const top = open[open.length - 1]?.node;
    if (top?.kind === 'method') return; // logic line

    const heading = headings[headings.length - 1]?.node;
    const u = line.match(UNIT);
    if (u) {
      const n = node('unit', u[2], u[1] === '+' ? 'new file' : '', i);
      add(n, heading);
      open = [{ indent, node: n }];
      return;
    }
    const t = line.match(TYPE);
    const m = line.match(METHOD);
    const f = !m && line.match(FIELD);
    const n = t ? node('type', t[1], '', i) : m ? node('method', m[1], m[2], i) : f ? node('field', f[1], f[2], i) : undefined;
    if (!n) return;
    add(n, top ?? heading);
    open.push({ indent, node: n });
  });
  return roots;
}

// "## Title" steps without [x]: the work left to build.
export function openSteps(text: string): { title: string; line: number }[] {
  const lines = text.split('\n');
  const steps: { title: string; line: number }[] = [];
  const walk = (nodes: OutlineNode[]) => nodes.forEach((n) => {
    if (n.kind !== 'heading') return;
    if (/^##\s/.test(lines[n.line]) && n.detail !== 'done') steps.push({ title: n.name, line: n.line });
    walk(n.children);
  });
  walk(parseOutline(text));
  return steps;
}

// The step titled `title`: its heading's line, whether it's ticked, and its lines down to the next # or ## heading.
// Undefined once the step is gone, which after a run means it was folded into Current state.
// ponytail: headings inside fenced code blocks count too; steps rarely hold fences
export function stepSection(text: string, title: string): { line: number; done: boolean; lines: string[] } | undefined {
  const lines = text.split(/\r?\n/);
  const heading = /^##\s+(?:\[([ xX])\]\s*)?(.*?)\s*#*\s*$/;
  const start = lines.findIndex((l) => heading.exec(l)?.[2] === title);
  if (start < 0) return undefined;
  let end = lines.findIndex((l, i) => i > start && /^#{1,2}\s/.test(l));
  if (end < 0) end = lines.length;
  while (end > start + 1 && !lines[end - 1].trim()) end--;
  const box = heading.exec(lines[start])![1];
  return { line: start, done: !!box && box !== ' ', lines: lines.slice(start, end) };
}

// A line the spec gets for something in the code: its file, a type in it, or a method or other member of either.
export interface Segment {
  kind: 'unit' | 'type' | 'method' | 'line';
  name: string;
  text: string; // "@src/store.ts", ": Store", "- save()", "- MAX"
}

// Where `path` goes in the step whose heading is on line `step`: the lines it doesn't list yet, to go in after line
// `after`, and `at`, the line of the last segment once they're in. What the step already lists is used, not repeated.
// ponytail: a member that isn't a method matches by its whole line only
export function placeIn(text: string, step: number, path: Segment[]): { after: number; lines: string[]; at: number } {
  const lines = text.split('\n').map((l) => l.replace(/\r$/, ''));
  const find = (nodes: OutlineNode[]): OutlineNode | undefined =>
    nodes.map((n) => (n.line === step ? n : find(n.children))).find(Boolean);
  let parent = find(parseOutline(text));
  if (parent?.kind !== 'heading') throw new Error(`No step on line ${step}`);
  let depth = 0;
  for (; depth < path.length; depth++) {
    const s = path[depth];
    const p: OutlineNode = parent;
    if (s.kind === 'line') {
      const at = lines.findIndex((l, i) => i > p.line && i <= p.endLine && l.trim() === s.text);
      if (at >= 0) return { after: at, lines: [], at };
      break;
    }
    const child = p.children.find((c) => c.kind === s.kind && c.name === s.name);
    if (!child) break;
    parent = child;
  }
  if (depth === path.length) return { after: parent.line, lines: [], at: parent.line };
  const indentOf = (n: OutlineNode) => lines[n.line].search(/\S/);
  const first = parent.children.find((c) => c.kind !== 'heading');
  const indent = parent.kind === 'heading' ? 0 : first ? indentOf(first) : indentOf(parent) + 2;
  const missing = path.slice(depth).map((s, i) => ' '.repeat(indent + 2 * i) + s.text);
  // A new file in a step that lists more gets a blank line before it, like the others.
  if (parent.kind === 'heading' && parent.endLine > parent.line) missing.unshift('');
  return { after: parent.endLine, lines: missing, at: parent.endLine + missing.length };
}
