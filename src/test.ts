import * as assert from 'assert';
import { agentCommand, stepPrompt } from './agent';
import { OutlineNode, openSteps, parseOutline } from './outline';
import { findRefs, projectOf } from './refs';
import { fold } from './snapshot';
import { builtinTypes, claims, closest, findCalls, indexSymbols, inPath, inTypePosition, symbolName, typeSpans } from './symbols';

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

assert.strictEqual(projectOf('/code/app/.llmd/flow.llmd'), '/code/app');
assert.strictEqual(projectOf('/code/app/.llmd/sub/flow.llmd'), '/code/app');
assert.strictEqual(projectOf('C:\\code\\app\\.llmd\\flow.llmd'), 'C:/code/app');
assert.strictEqual(projectOf('/code/app/flow.llmd'), undefined);
assert.strictEqual(projectOf('/code/.llmd'), undefined);

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


assert.deepStrictEqual(openSteps('# T\n## [x] Done\n## Open\n### Sub\n```\n## fenced\n```\n## [ ] Boxed'), [
  { title: 'Open', line: 2 },
  { title: 'Boxed', line: 7 },
]);

const step = `Don't spend $HOME`;
const prompt = stepPrompt('implement', step, '.llmd/a.llmd');
assert.strictEqual(prompt, `implement the step "Don't spend $HOME" in .llmd/a.llmd`);
assert.ok(stepPrompt('plan', 'Export', 'a.llmd').startsWith('plan the step "Export" in a.llmd') &&
  stepPrompt('plan', 'Export', 'a.llmd').includes("Don't write any code"));
assert.strictEqual(agentCommand('codex', prompt, '/bin/zsh'),
  `codex 'implement the step "Don'\\''t spend $HOME" in .llmd/a.llmd'`);
assert.strictEqual(agentCommand('claude', prompt, 'C:\\Program Files\\PowerShell\\7\\pwsh.exe'),
  `claude 'implement the step "Don''t spend $HOME" in .llmd/a.llmd'`);
assert.strictEqual(agentCommand('claude', prompt, 'C:\\Windows\\System32\\cmd.exe'),
  `claude "implement the step 'Don't spend $HOME' in .llmd/a.llmd"`);

const models = [
  'lang: go', //                 0
  '+cmd/internal/models', //     1
  '  - : book ', //              2
  '    - id: int', //            3
  '    - name: string', //       4
  '    - author: Author', //     5
  '    - Save(db *sql.DB, b book) -> error', // 6
  '  : Author', //               7
  '    - when: time.Time', //    8
].join('\n');
assert.deepStrictEqual(shape(parseOutline(models)), [
  ['unit cmd/internal/models new file 1-8',
    ['type book  2-6', ['field id int 3-3'], ['field name string 4-4'], ['field author Author 5-5'], ['method Save (db *sql.DB, b book) -> error 6-6']],
    ['type Author  7-8', ['field when time.Time 8-8']]],
]);
const spans = typeSpans(models, parseOutline(models)).map((s) => `${s.line}:${models.split('\n')[s.line].slice(s.start, s.end)}`);
assert.deepStrictEqual(spans, ['3:int', '4:string', '5:Author', '6:book', '6:error'], 'built-in and declared types, not sql.DB or time.Time');
const sameName = [
  'lang: go', //                  0
  '@internal/models/book.go', //  1
  "  // decided: internal/models, not cmd/internal/models (sqlite can't import cmd/internal)", // 2
  '  - : book ', //               3
  '    - id: int', //             4
  '@internal/store/store.go', //  5
  '  - CreateBook(:book)', //     6
].join('\n');
assert.strictEqual(indexSymbols(parseOutline(sameName)).get('book')?.kind, 'type', 'a type wins over a file with the same name');
assert.deepStrictEqual(typeSpans(sameName, parseOutline(sameName)).map((s) => `${s.line}:${s.start}`), ['4:10', '6:16'], 'CreateBook(:book) colors book');
assert.ok(builtinTypes(models).includes('float64') && !builtinTypes(models).includes('i32'));
assert.ok(builtinTypes('lang: rust').includes('i32') && builtinTypes('no lang').includes('i32'));
assert.ok(inTypePosition('    - id: in', 12) && inTypePosition('- Save(b bo', 11));
assert.ok(!inTypePosition('    - id: in', 7) && !inTypePosition('  - : bo', 8) && !inTypePosition('- read the input', 10));

const history = fold([
  '# Calc',
  'lang: go',
  '',
  '## [x] Current state',
  '',
  '@main.go',
  '  - run()',
  '    - read input',
  '    - print result',
  '  - old()',
  '',
  '## [x] Add history',
  '// why we wanted it: dropped',
  '+history.go',
  '  : History',
  '    - items: []string',
  '@main.go',
  '  - [x] run() -> error',
  '    - read input',
  '    - save to History',
  '    - ~print result',
  '    ! history keeps the newest item last',
  '  - ~old()',
  '  // decided: keep 10 items',
  '### Notes',
  '// decided: no persistence',
  '! go test passes',
  '',
  '## Open step',
  '@main.go',
  '  - more()',
  '',
].join('\n'));
assert.strictEqual(history.text, [
  '# Calc',
  'lang: go',
  '',
  '## [x] Current state',
  '',
  '@main.go',
  '  - run() -> error',
  '    - read input',
  '    - save to History',
  '    ! history keeps the newest item last',
  '  // decided: keep 10 items',
  '',
  '@history.go',
  '  : History',
  '    - items: []string',
  '',
  '// decided: no persistence',
  '',
  '## Open step',
  '@main.go',
  '  - more()',
  '',
].join('\n'));
assert.strictEqual(history.folded.length, 1);
assert.ok(history.folded[0].startsWith('## [x] Add history') && history.folded[0].includes('dropped') && history.folded[0].includes('! go test passes'));

const fresh = fold('# T\r\n\r\n## [x] One\r\n+a.go\r\n  - A()\r\n  ```\r\n  ## not a step\r\n    kept as is\r\n  ```\r\n\r\n## Two\r\n');
assert.strictEqual(fresh.text, '# T\r\n\r\n## [x] Current state\r\n\r\n@a.go\r\n  - A()\r\n  ```\r\n  ## not a step\r\n    kept as is\r\n  ```\r\n\r\n## Two\r\n',
  'Current state is created above the first step; fences and CRLF survive');
assert.deepStrictEqual(fold('# T\n## Open\n').folded, [], 'nothing done, nothing folded');

const claimed = claims(parseOutline([
  '# App', //                   0
  '## [x] Current state', //    1
  '@src/store.ts', //           2
  '  : Store', //               3
  '    - items: Todo[]', //     4
  '    - save(t: Todo)', //     5
  '  - load() -> Todo[]', //    6
  '+src/new.ts', //             7
  '  - fresh()', //             8
  '### Notes', //               9
  '@src/main.ts', //            10
  '  - main()', //              11
  '## Open', //                 12
  '@src/store.ts', //           13
  '  - planned()', //           14
].join('\n')));
assert.deepStrictEqual(claimed.map((c) => `${c.line} ${c.path} ${c.name}`),
  ['3 src/store.ts Store', '5 src/store.ts save', '6 src/store.ts load', '11 src/main.ts main'],
  'types and methods of done steps, not fields, + units or open steps');
assert.deepStrictEqual(['Add(double, double)', '(*Book).Save', 'List<T>', 'Store.save', ' main '].map(symbolName),
  ['Add', 'Save', 'List', 'save', 'main']);

assert.strictEqual(closest('Pussh', ['Push', 'wait']), 'Push', 'a typo');
assert.strictEqual(closest('getbook', ['GetBook', 'GetBooks']), 'GetBook', 'a case slip');
assert.strictEqual(closest('Database', ['Books']), undefined, 'an inherited member is not a typo');
assert.strictEqual(closest('cs', ['GetBook', 'GetBooks']), undefined, 'a file extension is not a typo');
assert.strictEqual(closest('Pul', ['Push']), undefined, 'short names allow one edit only');
assert.strictEqual(closest('Pus', ['Push']), 'Push');

console.log('ok');
