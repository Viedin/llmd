import { FIELD, METHOD, TYPE, UNIT } from './outline';

export interface Line {
  text: string;
  children: Line[];
}

const FENCE = /^\s*(```|~~~)/;
const DONE_STEP = /^##\s+\[[xX]\]\s*(.*?)\s*#*\s*$/;
const CURRENT = 'Current state';

// Indent tree of the non-blank lines. A fenced block stays one line, so its insides aren't merged.
function tree(lines: string[]): Line[] {
  const roots: Line[] = [];
  const open: { indent: number; line: Line }[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === '') continue;
    const indent = lines[i].search(/\S/);
    const text = [lines[i].trim()];
    if (FENCE.test(lines[i])) {
      while (++i < lines.length) {
        const pad = lines[i].match(/^\s*/)![0].length;
        text.push(lines[i].slice(Math.min(pad, indent)));
        if (FENCE.test(lines[i])) break;
      }
    }
    while (open.length && open[open.length - 1].indent >= indent) open.pop();
    const line: Line = { text: text.join('\n'), children: [] };
    (open.length ? open[open.length - 1].line.children : roots).push(line);
    open.push({ indent, line });
  }
  return roots;
}

// What a line is matched on: a unit by path, a symbol by name, a logic line or anything else by its text.
// A "- generated: <command>" line is a note, not a field, so each command is kept.
// ponytail: overloads share a name, so they merge into one method
export function key(text: string, logic = false): string {
  if (logic || /^-\s+generated:/.test(text)) return 'text ' + text;
  const u = text.match(UNIT);
  if (u) return 'unit ' + u[2];
  const s = text.match(TYPE) ?? text.match(METHOD) ?? text.match(FIELD);
  return s ? 'symbol ' + s[1] : 'text ' + text;
}

// A built step is plain state: + units exist now, and nothing is marked [x] inside the snapshot.
const clean = (text: string) => text.replace(/^\+(?=[\w\-./]+$)/, '@').replace(/^-\s+\[[ xX]\]\s+/, '- ');

export function merge(into: Line[], from: Line[], logic = false) {
  for (const line of from) {
    const removed = line.text.replace(/^(-\s+)?~\s*/, '$1');
    if (removed !== line.text) {
      const i = into.findIndex((l) => key(l.text, logic) === key(removed, logic));
      if (i >= 0) into.splice(i, 1);
      continue;
    }
    const text = logic ? line.text : clean(line.text);
    let match = into.find((l) => key(l.text, logic) === key(text, logic));
    if (match) match.text = text; // a symbol takes the step's signature
    else into.push((match = { text, children: [] }));
    merge(match.children, line.children, logic || METHOD.test(text));
  }
}

function render(line: Line, depth: number): string[] {
  const pad = '  '.repeat(depth);
  return [
    ...line.text.split('\n').map((t) => (t ? pad + t : t)),
    ...line.children.flatMap((c) => render(c, depth + 1)),
  ];
}

// Merges every done ## step into "## [x] Current state" and removes it. folded holds the removed steps.
export function fold(text: string): { text: string; folded: string[] } {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  const starts: number[] = [];
  let inFence = false;
  lines.forEach((l, i) => {
    if (FENCE.test(l)) inFence = !inFence;
    else if (!inFence && /^#{1,2}\s/.test(l) && i > 0) starts.push(i);
  });
  const sections = [0, ...starts].map((s, i, all) => lines.slice(s, all[i + 1] ?? lines.length));

  const title = (s: string[]) => s[0].match(DONE_STEP)?.[1];
  const currentAt = sections.findIndex((s) => title(s) === CURRENT);
  const current = currentAt >= 0 ? tree(sections[currentAt].slice(1)) : [];
  const folded: string[] = [];
  for (const s of sections) {
    const t = title(s);
    if (t === undefined || t === CURRENT) continue;
    // Only units and decisions describe the code; the step's other notes stay in the archive.
    merge(current, tree(s.slice(1)).filter((l) => key(l.text.replace(/^~/, '')).startsWith('unit') || l.text.startsWith('// decided:')));
    folded.push(s.join(eol).trimEnd());
  }
  if (!folded.length) return { text, folded };

  const snapshot = ['## [x] ' + CURRENT, '', ...current.flatMap((l) => [...render(l, 0), ''])];
  const out: string[][] = [];
  sections.forEach((s, i) => {
    const t = title(s);
    const isStep = /^##\s/.test(s[0]);
    if (i === currentAt || (currentAt < 0 && isStep && !out.includes(snapshot))) out.push(snapshot);
    if (i !== currentAt && t === undefined) out.push(s);
  });
  return { text: out.flat().join(eol), folded };
}

// The snapshot a done step names on its "snapshot: <feature>" line, the feature it belongs to. The agent picks it.
export function snapshotName(step: string[]): string | undefined {
  for (const line of step) {
    const m = line.match(/^snapshot:\s*([\w.-]+)\s*$/);
    if (m) return m[1].replace(/\.llmd$/, '');
  }
}

// One accepted step folded into a feature's snapshot. A new snapshot starts with a title, the lang: line and an empty
// Current state. The step counts as done whatever its box says, since accepting it is what makes it done.
export function foldInto(snapshot: string | undefined, step: string[], title: string, lang?: string): string {
  const base = snapshot?.trim() ? snapshot : `# ${title}\n${lang ? lang + '\n' : ''}\n## [x] ${CURRENT}\n`;
  const ticked = [step[0].replace(/^##\s+(\[[ xX]\]\s*)?/, '## [x] '), ...step.slice(1)];
  return fold(base.trimEnd() + '\n\n' + ticked.join('\n').trim() + '\n').text;
}

// Done steps that name their snapshot, taken out of the spec: they fold into .llmd/snapshots/<name>.llmd, not into the spec.
export function takeNamed(text: string): { text: string; steps: { name: string; lines: string[] }[] } {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  const starts: number[] = [];
  let inFence = false;
  lines.forEach((l, i) => {
    if (FENCE.test(l)) inFence = !inFence;
    else if (!inFence && /^#{1,2}\s/.test(l)) starts.push(i);
  });
  const sections = [0, ...starts.filter((s) => s > 0)].map((s, i, all) => lines.slice(s, all[i + 1] ?? lines.length));
  const steps: { name: string; lines: string[] }[] = [];
  const kept = sections.filter((s) => {
    const title = s[0].match(DONE_STEP)?.[1];
    const name = title !== undefined && title !== CURRENT ? snapshotName(s) : undefined;
    let end = s.length;
    while (end > 1 && !s[end - 1].trim()) end--;
    if (name) steps.push({ name, lines: s.slice(0, end) });
    return !name;
  });
  return steps.length ? { text: kept.flat().join(eol), steps } : { text, steps };
}
