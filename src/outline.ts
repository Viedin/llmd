export interface OutlineNode {
  kind: 'heading' | 'unit' | 'type' | 'method' | 'field';
  name: string;
  detail: string;
  line: number;
  endLine: number;
  children: OutlineNode[];
}

const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const UNIT = /^\s*([@+])([\w\-./]+)\s*$/;
const TYPE = /^\s*:\s*([A-Za-z_]\w*)/;
const METHOD = /^\s*-\s+(?:\[[ xX]\]\s+)?([A-Za-z_]\w*)(\(.*?\)(?:\s*->\s*.+?)?)\s*$/;
const FIELD = /^\s*-\s+([A-Za-z_]\w*)\s*:\s*(.+?)\s*$/;

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
