import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { agentArgs, allowRules, answersIn, answersPrompt, render, startedIn, stepPrompt } from './agent';
import { OutlineNode, openSteps, parseOutline, placeIn, questionsOf, stepSection } from './outline';
import { findRefs, projectOf } from './refs';
import { themeCss } from './theme';
import { builtinTypes, claims, closest, findCalls, indexSymbols, inPath, inTypePosition, isNew, ownerAbove, receiverOf, symbolName, typeSpans } from './symbols';

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
assert.deepStrictEqual(findRefs('~@src/gone.ts\n- ~@old.go'), [], 'a removed file is no reference');

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
// A headless Claude takes the prompt last, after "--", and resumes the step's session when it has one.
assert.deepStrictEqual(agentArgs('claude', '-x'), { args: ['-p', '--output-format', 'stream-json', '--verbose', '--', '-x'], input: '' });
assert.deepStrictEqual(agentArgs('claude', prompt, 'abc').args.slice(4), ['--resume', 'abc', '--', prompt]);
assert.deepStrictEqual(agentArgs('claude', 'x', undefined, true).args.slice(4, 6), ['--disallowedTools', 'Edit Write MultiEdit NotebookEdit Bash']);
// Codex gets the prompt on stdin, and its sandbox before the session it resumes.
assert.deepStrictEqual(agentArgs('codex', '-x', 'abc'), { args: ['--json', '--skip-git-repo-check', '--sandbox', 'workspace-write', 'resume', 'abc'], input: '-x' });
assert.deepStrictEqual(agentArgs('codex', 'x', undefined, true).args, ['--json', '--skip-git-repo-check', '--sandbox', 'read-only']);

// Events shaped like claude's stream-json output: only text, tool calls, denials and errors are shown.
const root = '/code/app';
const stream = [
  { type: 'system', subtype: 'init', session_id: 's1' },
  { type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'hmm' }] } },
  { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Edit', input: { file_path: '/code/app/cmd/main.go' } }] } },
  { type: 'user', message: { content: [{ type: 'tool_result', content: 'ok' }] } },
  { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'go build ./...\necho done' } }, { type: 'text', text: 'Built **it**.' }] } },
  { type: 'result', subtype: 'success', session_id: 's1', permission_denials: [{ tool_name: 'Bash', tool_input: { command: 'go test ./...' } }] },
  { type: 'result', subtype: 'error_during_execution', is_error: true, permission_denials: [], errors: ['No conversation found'] },
];
assert.deepStrictEqual(stream.map((e) => render(e, root)), [
  [],
  [],
  [{ kind: 'tool', text: 'Edit cmd/main.go', file: '/code/app/cmd/main.go' }],
  [],
  [{ kind: 'tool', text: 'Bash go build ./...' }, { kind: 'text', text: 'Built **it**.' }],
  [{ kind: 'error', text: 'Not allowed: Bash go test ./...', allow: ['Bash(go test *)'] }],
  [{ kind: 'error', text: 'No conversation found' }],
]);

// Events shaped like `codex exec --json`'s: its messages, commands, file changes and errors read as Claude's do.
const thread = [
  { type: 'thread.started', thread_id: 't1' },
  { type: 'turn.started' },
  { type: 'item.completed', item: { id: 'i0', type: 'reasoning', text: 'hmm' } },
  { type: 'item.started', item: { id: 'i1', type: 'command_execution', command: "/bin/zsh -lc 'go build ./...'", status: 'in_progress' } },
  { type: 'item.completed', item: { id: 'i1', type: 'command_execution', command: "/bin/zsh -lc 'go build ./...'", exit_code: 0, status: 'completed' } },
  { type: 'item.completed', item: { id: 'i2', type: 'file_change', changes: [{ path: '/code/app/cmd/main.go', kind: 'update' }, { path: 'new.go', kind: 'add' }], status: 'completed' } },
  { type: 'item.completed', item: { id: 'i3', type: 'agent_message', text: 'Built **it**.' } },
  { type: 'turn.completed', usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 } },
  { type: 'turn.failed', error: { message: 'stream disconnected' } },
];
assert.deepStrictEqual(thread.map((e) => render(e, root)), [
  [],
  [],
  [],
  [{ kind: 'tool', text: 'Bash go build ./...' }],
  [],
  [{ kind: 'tool', text: 'Edit cmd/main.go', file: '/code/app/cmd/main.go' }, { kind: 'tool', text: 'Write new.go', file: '/code/app/new.go' }],
  [{ kind: 'text', text: 'Built **it**.' }],
  [],
  [{ kind: 'error', text: 'stream disconnected' }],
]);
// Both report the session they're in first.
assert.deepStrictEqual([stream[0], stream[5], thread[0], thread[1]].map(startedIn), ['s1', undefined, 't1', undefined]);

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
const inline = ['@main.go', '  - main()', '    - extend the : book and :Author', '    - but not time: Now or : sql.DB', '  : book'].join('\n');
assert.deepStrictEqual(typeSpans(inline, parseOutline(inline), ['Author']).map((s) => `${s.line}:${inline.split('\n')[s.line].slice(s.start, s.end)}`),
  ['2:book', '2:Author'], '":Name" in a line is a type, like "@path" is a file');
assert.ok(builtinTypes(models).includes('float64') && !builtinTypes(models).includes('i32'));
assert.ok(builtinTypes('lang: rust').includes('i32') && builtinTypes('no lang').includes('i32'));
assert.ok(inTypePosition('    - id: in', 12) && inTypePosition('- Save(b bo', 11));
assert.ok(!inTypePosition('    - id: in', 7) && !inTypePosition('  - : bo', 8) && !inTypePosition('- read the input', 10));

const claimed = claims(parseOutline([
  '# App', //                   0
  '## [x] Built', //            1
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
assert.deepStrictEqual(claimed.map((c) => `${c.line} ${c.path} ${c.name}${c.newFile ? ' new' : ''}`),
  ['3 src/store.ts Store', '5 src/store.ts save', '6 src/store.ts load', '8 src/new.ts fresh new', '11 src/main.ts main', '14 src/store.ts planned'],
  'types and methods under every unit, not fields');
// What the step adds to the code: a name its @ file doesn't have, or anything in a + unit.
const [store, , , fresh, , planned] = claimed;
const code = new Set(['Store', 'save']);
assert.ok(!isNew(store, code), 'a method that exists in its @ file is never colored as new');
assert.ok(isNew(fresh, undefined), 'every method under a +unit is new, without asking a language server');
assert.ok(isNew(planned, code) && !isNew(planned, undefined), 'a name the file lacks is new; no symbols is no verdict');
// What a new line lists members of: the unit, and the type it's under; nothing on a logic line.
const members = ['## Step', '@src/store.ts', '  : Store', '    - sa', '  - lo', '    - read the ', '+src/new.ts', '  - ', '- top'].join('\n');
assert.deepStrictEqual([3, 4, 5, 7, 8, 0].map((l) => ownerAbove(members, l)), [{ unit: 'src/store.ts', type: 'Store' }, { unit: 'src/store.ts', type: undefined },
  undefined, { unit: 'src/new.ts', type: undefined }, undefined, undefined]);
assert.deepStrictEqual(ownerAbove('@src/a.ts\n  : ', 1), { unit: 'src/a.ts', type: undefined }, 'a type line lists the file');
assert.deepStrictEqual(claimed.map((c) => c.type), [undefined, 'Store', undefined, undefined, undefined, undefined], 'a method knows the type it is under');
assert.deepStrictEqual(['(*Book).Save', '(Book).Load', 'Save'].map(receiverOf), ['Book', 'Book', undefined]);

// Adding code to a step: under what the step already lists, without repeating it.
const plan = ['# App', '## Grow', '@src/store.ts', '  - load()', '', '## Next', '- x'].join('\n');
const seg = (kind: 'unit' | 'type' | 'method' | 'line', name: string, text: string) => ({ kind, name, text });
const unit = seg('unit', 'src/store.ts', '@src/store.ts');
assert.deepStrictEqual(placeIn(plan, 1, [unit, seg('type', 'Store', ': Store'), seg('method', 'save', '- save()')]),
  { after: 3, lines: ['  : Store', '    - save()'], at: 5 }, 'a type and its method go under the file the step lists');
assert.deepStrictEqual(placeIn(plan, 1, [unit, seg('method', 'load', '- load()')]), { after: 3, lines: [], at: 3 }, 'what it lists is not repeated');
assert.deepStrictEqual(placeIn(plan, 1, [seg('unit', 'src/a.ts', '@src/a.ts'), seg('line', 'MAX', '- MAX')]),
  { after: 3, lines: ['', '@src/a.ts', '  - MAX'], at: 6 }, 'a new file goes after a blank line, at the end of the step');
assert.deepStrictEqual(placeIn('## Empty\n\n', 0, [unit]), { after: 0, lines: ['@src/store.ts'], at: 1 }, 'an empty step starts right under its heading');
assert.deepStrictEqual(placeIn(['## S', '@src/store.ts', '    - MAX'].join('\n'), 0, [unit, seg('line', 'MAX', '- MAX')]), { after: 2, lines: [], at: 2 });
assert.deepStrictEqual(['Add(double, double)', '(*Book).Save', 'List<T>', 'Store.save', ' main '].map(symbolName),
  ['Add', 'Save', 'List', 'save', 'main']);

assert.strictEqual(closest('Pussh', ['Push', 'wait']), 'Push', 'a typo');
assert.strictEqual(closest('getbook', ['GetBook', 'GetBooks']), 'GetBook', 'a case slip');
assert.strictEqual(closest('Database', ['Books']), undefined, 'an inherited member is not a typo');
assert.strictEqual(closest('cs', ['GetBook', 'GetBooks']), undefined, 'a file extension is not a typo');
assert.strictEqual(closest('Pul', ['Push']), undefined, 'short names allow one edit only');
assert.strictEqual(closest('Pus', ['Push']), 'Push');


// A refused command becomes one rule per command in it, in the format Claude Code writes itself.
assert.deepStrictEqual(allowRules('Bash', { command: 'go build ./... && (go run ./cmd/app -addr :8080 & sleep 1) | grep ok' }),
  ['Bash(go build *)', 'Bash(go run *)', 'Bash(sleep *)', 'Bash(grep *)']);
assert.deepStrictEqual(allowRules('Bash', { command: 'ls -R . | grep -v node_modules' }), ['Bash(ls *)', 'Bash(grep *)']);
assert.deepStrictEqual(allowRules('WebFetch', { url: 'https://x.dev' }), ['WebFetch']);

// A step's section: from its heading down to the next step, without trailing blank lines.
const sections = '# Spec\n## [x] Current state\n@a.go\n\n## Export\n@b.go\n  - Save()\n\n\n## [x] Done one\n- x\n';
assert.deepStrictEqual(stepSection(sections, 'Export'), { line: 4, done: false, lines: ['## Export', '@b.go', '  - Save()'] });
assert.deepStrictEqual(stepSection(sections, 'Done one'), { line: 9, done: true, lines: ['## [x] Done one', '- x'] });
assert.strictEqual(stepSection(sections, 'Folded away'), undefined);
// A ? and the answers under it, which aren't fields or methods of the file.
const asked = ['@a.go', '  ? json or sqlite', '    - json', '    - sqlite: concurrent writes', '  - load()'].join('\n');
assert.deepStrictEqual(questionsOf(asked), [{ line: 1, question: 'json or sqlite', end: 3, answers: [
  { line: 2, text: 'json', choice: 'json', tradeoff: '', why: 10, recommended: false },
  { line: 3, text: 'sqlite: concurrent writes', choice: 'sqlite', tradeoff: 'concurrent writes', why: 12, recommended: false },
] }]);
assert.deepStrictEqual(questionsOf('? log\n  - slog — levels and fields (recommended)').map((q) => q.answers.map((a) => [a.choice, a.tradeoff, a.why, a.recommended])),
  [[['slog', 'levels and fields', 8, true]]], 'the choice, its trade-off and the one Claude recommends');
assert.deepStrictEqual(shape(parseOutline(asked)), [['unit a.go  0-4', ['method load () 4-4']]], 'answers are not fields');
assert.deepStrictEqual(questionsOf('  - main()\n    - ? slog or fmt\n      - slog\n    - next').map((q) => [q.line, q.question, q.answers.map((a) => a.text), q.end]),
  [[1, 'slog or fmt', ['slog'], 2]], '"- ?" is a question too, the way Enter leaves it');

// Claude's answers to a ? you wrote: the "- " lines of its reply.
assert.deepStrictEqual(answersIn('Here you go:\n- **slog**: structured (recommended)\n- fmt: simplest\n'), ['slog: structured (recommended)', 'fmt: simplest']);
assert.ok(answersPrompt('.llmd/a.llmd', ['## Log', '- ? slog or fmt'], 'slog or fmt').includes('this step asks "slog or fmt":\n\n## Log\n- ? slog or fmt'));

// The run tab's copy of the grammar: a line as [start, end, token] pieces.
const { grammar } = require('../media/tokens.js');
const pieces = (line: string) => grammar(line).map(([s, e, t]: [number, number, string]) => `${line.slice(s, e)}|${t}`);
assert.deepStrictEqual(pieces('## Test'), ['##|heading-punct', ' |heading', 'Test|heading']);
assert.deepStrictEqual(pieces('## [x] Done'), ['##|heading-punct', ' |heading', '[|box-punct', 'x|box', ']|box-punct', ' Done|heading']);
assert.deepStrictEqual(pieces('  - main()'), ['  |plain', '-|list', ' |plain', 'main|function', '()|plain']);
assert.deepStrictEqual(pieces('* see @a.go now'), ['*|list', ' see |free', '@a.go|free-path', ' now|free']);
assert.deepStrictEqual(pieces('? json or sqlite'), ['?|question-mark', ' json or sqlite|question']);
assert.deepStrictEqual(pieces('  - ? slog'), ['  |question', '-|question-list', ' |question', '?|question-mark', ' slog|question']);
assert.deepStrictEqual(pieces('  - ! once'), ['  |plain', '-|list', ' |plain', '!|check-mark', ' once|check']);
assert.deepStrictEqual(pieces('  : Store x'), ['  |plain', ':|type-op', ' |plain', 'Store|type-name', ' x|plain']);

// The theme's colors, picked the way the editor picks them: included themes first, the best fitting rule, descendant
// selectors, and color and font style each on their own.
const themes = fs.mkdtempSync(path.join(os.tmpdir(), 'llmd-theme-'));
fs.writeFileSync(path.join(themes, 'base.json'), JSON.stringify({ tokenColors: [
  { scope: 'string', settings: { foreground: '#111111' } },
  { scope: 'markup.italic', settings: { foreground: '#222222', fontStyle: 'italic' } },
] }));
fs.writeFileSync(path.join(themes, 'theme.json'), `{
  "$schema": "vscode://schemas/color-theme", // a comment, and a trailing comma
  "include": "./base.json",
  "tokenColors": [
    { "scope": ["entity.name", "markup.heading entity.name"], "settings": { "foreground": "#333333" } },
    { "scope": "entity.name.type", "settings": { "foreground": "#444444" } },
  ],
}`);
const css = themeCss(path.join(themes, 'theme.json'));
assert.match(css, /\.t-free-path \{ color: #111111; font-style: italic;/, 'a path in a free line: the string color, the italic of its line');
assert.match(css, /\.t-heading \{ color: #333333;/);
assert.match(css, /\.t-type-name \{ color: #444444;/, 'the more specific rule wins');
assert.match(css, /\.l \.t-sem-type \{ color: #444444; \}/);
assert.match(css, /\.t-plain \{ color: var\(--vscode-editor-foreground\);/);
assert.strictEqual(themeCss(path.join(themes, 'missing.json')), '', 'no theme, no colors');
console.log('ok');
