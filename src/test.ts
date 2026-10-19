import * as assert from 'assert';
import { OutlineNode, parseOutline } from './outline';
import { findRefs } from './refs';
import { findCalls, indexSymbols, inPath } from './symbols';

const text = [
  '- see @api/upload.go.',
  '- folder @internal/sync/ and mail me@example.com',
  '```',
  '@ignored',
  '```',
  '\t@./pkg/util.go\r',
].join('\n');

const refs = findRefs(text);
assert.deepStrictEqual(refs.map((r) => r.path), ['api/upload.go', 'internal/sync/', './pkg/util.go']);
for (const r of refs) assert.strictEqual(text.slice(r.start, r.end), '@' + r.path);

const spec = [
  '# Sync', //                          0
  'lang: go', //                        1
  '## Client', //                       2
  '@internal/watcher.go', //            3
  '  - [x] Start(dir string) -> error', // 4
  '    - walk dir', //                  5
  '    - not: a field, logic', //       6
  '  - Stop()', //                      7
  '+internal/debounce.go', //           8
  '  : Debouncer', //                   9
  '    - wait: time.Duration', //       10
  '    - Push(path string)', //         11
  '      - then call Uploader.Send(paths)', // 12
  '  ? drop duplicates', //             13
  '```', //                             14
  '@inside/fence.go', //                15
  '```', //                             16
  '# Other', //                         17
].join('\r\n');

// [kind name detail line-endLine] with children nested
const shape = (nodes: OutlineNode[]): unknown[] =>
  nodes.map((n) => [`${n.kind} ${n.name} ${n.detail} ${n.line}-${n.endLine}`, ...shape(n.children)]);
assert.deepStrictEqual(shape(parseOutline(spec)), [
  ['heading Sync  0-16',
    ['heading Client  2-16',
      ['unit internal/watcher.go  3-7',
        ['method Start (dir string) -> error 4-6'],
        ['method Stop () 7-7']],
      ['unit internal/debounce.go new file 8-16',
        ['type Debouncer  9-12',
          ['field wait time.Duration 10-10'],
          ['method Push (path string) 11-12']]]]],
  ['heading Other  17-17'],
]);

assert.deepStrictEqual(shape(parseOutline('## [x] Basic calculator\n## [ ] More input\n## Notes')), [
  ['heading Basic calculator done 0-0'],
  ['heading More input  1-1'],
  ['heading Notes  2-2'],
]);

const index = indexSymbols(parseOutline(spec));
assert.deepStrictEqual([...index].map(([k, d]) => [k, d.kind, d.line, [...d.members]]), [
  ['watcher', 'unit', 3, [['Start', 4], ['Stop', 7]]],
  ['debounce', 'unit', 8, [['Debouncer', 9]]],
  ['Debouncer', 'type', 9, [['wait', 10], ['Push', 11]]],
]);

const calls = findCalls([
  '- then call Uploader.Send(paths) and refs.findRefs',
  '- read @src/refs.ts and +src/new.ts, not calls',
  '- chain vscode.window.activeTextEditor counts once',
  '```',
  'Hidden.Call',
  '```',
].join('\n'));
assert.deepStrictEqual(calls.map((c) => `${c.line}:${c.start}-${c.end} ${c.name}.${c.member}`), [
  '0:12-25 Uploader.Send',
  '0:37-50 refs.findRefs',
  '2:8-21 vscode.window',
]);
assert.ok(inPath('- read @src/refs.ts', 10) && !inPath('- read @src/refs.ts', 3));

console.log('ok');
