export interface Ref {
  path: string;
  /** Offset of the '@'. */
  start: number;
  end: number;
}

// shortcut: paths can't contain spaces; add @"quoted path" syntax if you need them.
const REF = /(?<![\w@])@([\w\-./]+)/g;

// Finds @path references outside fenced code blocks.
export function findRefs(text: string): Ref[] {
  const refs: Ref[] = [];
  let offset = 0;
  let inFence = false;
  for (const line of text.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
    else if (!inFence) {
      for (const m of line.matchAll(REF)) {
        const path = m[1].replace(/\.+$/, ''); // "see @api/upload.go." ends a sentence
        if (path) refs.push({ path, start: offset + m.index!, end: offset + m.index! + 1 + path.length });
      }
    }
    offset += line.length + 1;
  }
  return refs;
}

// A spec inside a .llmd/ folder belongs to the project that holds that folder.
export function projectOf(file: string): string | undefined {
  const parts = file.split(/[\\/]/);
  const i = parts.lastIndexOf('.llmd', parts.length - 2);
  return i > 0 ? parts.slice(0, i).join('/') : undefined;
}
