// Runs inside a real VS Code (see runE2E.ts). Opens example.llmd without a folder, like a user would.
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { missing } from './code';
import { doneLines, newRanges } from './extension';
import { allow, commit, hasRun, nextSteps, openChanges, runKey, runs, send, writeMessage } from './run';
import { execFileSync } from 'child_process';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function run() {
  const uri = vscode.Uri.file(path.resolve(__dirname, '..', 'example.llmd'));
  const doc = await vscode.workspace.openTextDocument(uri);
  const editor = await vscode.window.showTextDocument(doc);
  assert.strictEqual(doc.languageId, 'llmd');

  let problems: vscode.Diagnostic[] = [];
  for (let i = 0; i < 20 && problems.length === 0; i++) {
    await sleep(100);
    problems = vscode.languages.getDiagnostics(uri);
  }
  assert.deepStrictEqual(problems.map((d) => d.message), ["No file or folder 'does/not/exist.go'"]);

  const links = await vscode.commands.executeCommand<vscode.DocumentLink[]>('vscode.executeLinkProvider', uri);
  assert.ok(links.some((l) => l.target?.fsPath.endsWith('package.json')), 'link to package.json');

  const end = doc.lineAt(doc.lineCount - 1).range.end;
  await editor.edit((e) => e.insert(end, '\n- @'));
  const pos = doc.lineAt(doc.lineCount - 1).range.end;
  const list = await vscode.commands.executeCommand<vscode.CompletionList>('vscode.executeCompletionItemProvider', uri, pos, '@');
  const labels = list.items.map((i) => (typeof i.label === 'string' ? i.label : i.label.label));
  assert.ok(labels.includes('src/') && labels.includes('package.json'), `@ completions: ${labels.join(', ')}`);
  assert.ok(labels.includes('src/outline.ts') && !labels.some((l) => l.startsWith('node_modules')), '@ searches the whole project');

  await checkCodeLens();
  await checkTypes();
  await checkHighlighting();
  await checkEnter();
  await checkSymbols();
  await checkCode();
  await checkRun();
  console.log('e2e ok');
}

async function openTemp(name: string, text: string) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'llmd-')), name);
  fs.writeFileSync(file, text);
  const doc = await vscode.workspace.openTextDocument(file);
  return { doc, editor: await vscode.window.showTextDocument(doc) };
}

async function checkHighlighting() {
  const text = [
    '# Title',
    '@src/a.ts',
    '  : Thing',
    '  - [x] Done()',
    '    - step one',
    '      - deep step see @docs/x.md',
    '  - Open()',
    '? what now',
    '// a note',
    '* should be fast, see @docs/y.md',
    '! returns 0 for empty input',
  ].join('\n');
  const { doc } = await openTemp('fixture.llmd', text);

  // Internal command VS Code uses for its own grammar tests: [{ c: text, t: 'scope scope ...' }]
  const tokens = await vscode.commands.executeCommand<{ c: string; t: string }[]>('_workbench.captureSyntaxTokens', doc.uri);
  const scopes = (c: string) => tokens.find((t) => t.c.trim() === c)?.t ?? `<no token "${c}">`;
  assert.match(scopes('Title'), /markup\.heading/);
  assert.match(scopes('src/a.ts'), /string\.other\.path\.llmd/);
  assert.match(scopes('Thing'), /entity\.name\.type\.llmd/);
  assert.match(scopes('?'), /keyword\.control\.question\.llmd/);
  assert.match(scopes('// a note'), /comment\.line/);
  assert.match(scopes('@docs/x.md'), /string\.other\.path\.llmd/);
  assert.match(scopes('should be fast, see'), /markup\.italic\.free\.llmd/);
  assert.match(scopes('@docs/y.md'), /string\.other\.path\.llmd/, '@refs still work in a free line');
  assert.match(scopes('!'), /keyword\.control\.check\.llmd/);
  assert.match(scopes('returns 0 for empty input'), /markup\.inserted\.check\.llmd/);
  assert.ok(!tokens.some((t) => t.t.includes('markup.raw')), 'deep lines must not become markdown code blocks');

  assert.deepStrictEqual(doneLines(text), [3, 4, 5]);
  const steps = [
    '# Calc', //                 0
    '## [x] Basic', //           1
    '@Program.cs', //            2
    '  - promptUser()', //       3
    '```', //                    4
    '# not a heading', //        5
    '```', //                    6
    '### Notes', //              7
    '// part of the done step', // 8
    '## [ ] More input', //      9
    '@Program.cs', //            10
  ].join('\n');
  assert.deepStrictEqual(doneLines(steps), [1, 2, 3, 4, 5, 6, 7, 8], 'a done step and its subsections are dimmed');

  const symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>('vscode.executeDocumentSymbolProvider', doc.uri);
  const names = (s: vscode.DocumentSymbol[]): unknown[] => s.map((x) => [x.name, ...names(x.children)]);
  // Done and Open sit at the type's indent, so they belong to the unit, not to Thing.
  assert.deepStrictEqual(names(symbols), [['Title', ['src/a.ts', ['Thing'], ['Done'], ['Open']]]]);
}

async function checkEnter() {
  const { doc, editor } = await openTemp('enter.llmd', '@src/a.ts');
  const pressEnter = async () => {
    await sleep(200); // Enter rules read the line's tokens, which VS Code updates just after an edit
    const end = doc.lineAt(doc.lineCount - 1).range.end;
    editor.selection = new vscode.Selection(end, end);
    await vscode.commands.executeCommand('llmd.enter');
  };

  await pressEnter();
  assert.strictEqual(doc.lineAt(1).text, '  - ', 'Enter after a unit line indents and adds a bullet');

  await editor.edit((e) => e.insert(doc.lineAt(1).range.end, 'Start()'));
  await pressEnter();
  assert.strictEqual(doc.lineAt(2).text, '    - ', 'Enter after a method line: ' + JSON.stringify(doc.getText()));

  await editor.edit((e) => e.insert(doc.lineAt(2).range.end, 'read the input'));
  await pressEnter();
  assert.strictEqual(doc.lineAt(3).text, '    - ', 'Enter after a logic line continues the list');

  await pressEnter();
  assert.strictEqual(doc.lineAt(3).text, '  - ', 'Enter on an empty bullet steps out and keeps the bullet');
  assert.strictEqual(doc.lineCount, 4);

  await pressEnter();
  assert.strictEqual(doc.lineAt(3).text, '', 'at the outermost level it drops the bullet');

  await editor.edit((e) => e.insert(doc.lineAt(3).range.end, '    * should be fast'));
  await pressEnter();
  assert.strictEqual(doc.lineAt(4).text, '    * ', 'Enter after a free line continues it');
  await pressEnter();
  assert.strictEqual(doc.lineAt(4).text, '  * ', 'an empty free line steps out and keeps the *');

  await editor.edit((e) => e.replace(doc.lineAt(4).range, '    ! returns 0'));
  await pressEnter();
  assert.strictEqual(doc.lineAt(5).text, '    ! ', 'Enter after a check continues it');
  await pressEnter();
  assert.strictEqual(doc.lineAt(5).text, '  ! ', 'an empty check steps out and keeps the !');
}

async function checkSymbols() {
  const { doc } = await openTemp('symbols.llmd', [
    '@src/watcher.ts', //                           0
    '  - Start()', //                               1
    '    - on change call Debouncer.Push(path)', // 2
    '    - typo Debouncer.Pussh(path)', //          3
    '+src/debounce.ts', //                          4
    '  : Debouncer', //                             5
    '    - wait: number', //                        6
    '    - Push(path: string)', //                  7
    '- see watcher.Start', //                       8
    '- Debouncer.', //                              9
    '- inherited Debouncer.Dispose()', //           10
  ].join('\n'));

  const definition = async (line: number, word: string) => {
    const pos = new vscode.Position(line, doc.lineAt(line).text.indexOf(word) + 1);
    const found = await vscode.commands.executeCommand<(vscode.Location | vscode.LocationLink)[]>('vscode.executeDefinitionProvider', doc.uri, pos);
    const first = found[0];
    return first && ('targetRange' in first ? first.targetRange : first.range).start.line;
  };
  assert.strictEqual(await definition(2, 'Push'), 7, 'Ctrl+click on a member goes to the method');
  assert.strictEqual(await definition(2, 'Debouncer'), 5, 'Ctrl+click on a type goes to the type');
  assert.strictEqual(await definition(8, 'Start'), 1, 'unit names work too: watcher.Start');

  const list = await vscode.commands.executeCommand<vscode.CompletionList>('vscode.executeCompletionItemProvider', doc.uri, new vscode.Position(9, 12), '.');
  const labels = list.items.map((i) => (typeof i.label === 'string' ? i.label : i.label.label));
  assert.ok(labels.includes('Push') && labels.includes('wait'), `Debouncer. completions: ${labels.join(', ')}`);

  let typos: string[] = [];
  for (let i = 0; i < 20 && typos.length === 0; i++) {
    await sleep(100);
    typos = vscode.languages.getDiagnostics(doc.uri).map((d) => d.message).filter((m) => m.includes('has no member'));
  }
  assert.deepStrictEqual(typos, ["Debouncer has no member 'Pussh'. Did you mean 'Push'?"], 'only the typo warns, not Dispose');
}

async function checkCodeLens() {
  const { doc } = await openTemp('lens.llmd', '# Calc\n## [x] Basic\n## More input\n### Notes\n## [ ] Fix it');
  const lenses = await vscode.commands.executeCommand<vscode.CodeLens[]>('vscode.executeCodeLensProvider', doc.uri);
  assert.deepStrictEqual(lenses.map((l) => [l.range.start.line, l.command?.command, l.command?.arguments?.[1]]), [
    [1, 'llmd.done', 'Basic'],
    [2, 'llmd.implement', 'More input'], [2, 'llmd.plan', 'More input'],
    [4, 'llmd.implement', 'Fix it'], [4, 'llmd.plan', 'Fix it'],
  ], 'Implement and Plan show on open ## steps, Done on ticked ones the code backs');
}

async function checkTypes() {
  const { doc } = await openTemp('types.llmd', 'lang: go\n+cmd/internal/models\n  - : book \n    - id: int\n    - owner: book\n    - ref: ');
  const tokens = await vscode.commands.executeCommand<{ c: string; t: string }[]>('_workbench.captureSyntaxTokens', doc.uri);
  assert.ok(tokens.some((t) => t.c.trim() === 'book' && /entity\.name\.type\.llmd/.test(t.t)), '"- : book" colors book as a type');

  const end = doc.lineAt(5).range.end;
  const list = await vscode.commands.executeCommand<vscode.CompletionList>('vscode.executeCompletionItemProvider', doc.uri, end, ':');
  const labels = list.items.map((i) => (typeof i.label === 'string' ? i.label : i.label.label));
  assert.ok(labels.includes('book') && labels.includes('float64') && !labels.includes('models'), `type completions: ${labels.join(', ')}`);

  const legend = await vscode.commands.executeCommand<vscode.SemanticTokensLegend>('vscode.provideDocumentSemanticTokensLegend', doc.uri);
  const semantic = await vscode.commands.executeCommand<vscode.SemanticTokens>('vscode.provideDocumentSemanticTokens', doc.uri);
  assert.deepStrictEqual(legend.tokenTypes, ['type']);
  assert.strictEqual(semantic.data.length / 5, 2, 'int and book are colored as types');
}

// The plan knows the code: what a step adds, the real methods, their hovers, where they are, and whether a ticked step is built.
async function checkCode() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'llmd-'));
  const code = vscode.Uri.file(path.join(dir, 'store.ts'));
  fs.writeFileSync(code.fsPath, 'export class Store {\n  /** Writes the store to disk. */\n  save() {}\n}\nexport function load() {}\n');
  // Wait for the TypeScript server, so the spec's first look at the code gets an answer.
  for (let i = 0; i < 60; i++) {
    const found = await vscode.commands.executeCommand<unknown[] | undefined>('vscode.executeDocumentSymbolProvider', code);
    if (found?.length) break;
    await sleep(250);
  }
  const file = path.join(dir, 'plan.llmd');
  fs.writeFileSync(file, [
    '## Grow the store', // 0
    '@store.ts', //         1
    '  : Store', //         2
    '    - save()', //      3
    '    - remove()', //    4
    '  - load()', //        5
    '  - ', //              6
    '+extra.ts', //         7
    '  - made()', //        8
    '## [x] Built', //      9
    '@store.ts', //         10
    '  - gone()', //        11
  ].join('\n'));
  const spec = await vscode.workspace.openTextDocument(file);
  await vscode.window.showTextDocument(spec);
  assert.deepStrictEqual((await newRanges(spec)).map((r) => spec.getText(r)), ['remove', 'made', 'gone'],
    "what the code doesn't have yet is new, what it has isn't");

  const list = await vscode.commands.executeCommand<vscode.CompletionList>('vscode.executeCompletionItemProvider', spec.uri, new vscode.Position(6, 4));
  const label = (i: vscode.CompletionItem) => (typeof i.label === 'string' ? i.label : i.label.label);
  assert.ok(['Store', 'save', 'load'].every((n) => list.items.some((i) => label(i) === n)), `real completions: ${list.items.map(label).join(', ')}`);
  assert.strictEqual(list.items.find((i) => label(i) === 'load')?.insertText, 'load()', 'a function goes in as a method line');

  const hover = async (line: number, col: number) => (await vscode.commands.executeCommand<vscode.Hover[]>('vscode.executeHoverProvider', spec.uri, new vscode.Position(line, col)))
    .flatMap((h) => h.contents).map((c) => (typeof c === 'string' ? c : c.value)).join('\n');
  assert.ok((await hover(3, 7)).includes('Writes the store to disk'), 'the real hover, doc comment and all');
  assert.ok((await hover(4, 7)).includes('has no `remove` yet'), 'a new method says so');

  const found = await vscode.commands.executeCommand<(vscode.Location | vscode.LocationLink)[]>('vscode.executeDefinitionProvider', spec.uri, new vscode.Position(5, 5));
  const first = found[0];
  const [uri, range] = 'targetUri' in first ? [first.targetUri, first.targetRange] : [first.uri, first.range];
  assert.deepStrictEqual([uri.fsPath, range.start.line], [code.fsPath, 4], 'Ctrl+click opens the method in its file');

  // A ticked step is done once the code has what it lists.
  const lens = async () => (await vscode.commands.executeCommand<vscode.CodeLens[]>('vscode.executeCodeLensProvider', spec.uri))
    .find((l) => l.range.start.line === 9)?.command?.title;
  assert.strictEqual(await lens(), "$(warning) Not in the code yet: store.ts has no 'gone'");
  assert.deepStrictEqual(await missing(vscode.Uri.file(dir), ['## [x] X', '+extra.ts', '  - made()']), ["extra.ts doesn't exist"]);
  const edit = new vscode.WorkspaceEdit();
  edit.insert(code, new vscode.Position(5, 0), 'export function gone() {}\n');
  await vscode.workspace.applyEdit(edit);
  let title: string | undefined;
  for (let i = 0; i < 40 && title !== '$(check) Done'; i++) {
    await sleep(250);
    title = await lens();
  }
  assert.strictEqual(title, '$(check) Done', 'the code backs the tick now');
}

// A fake agent stands in for claude: it logs its arguments, ticks the step in the spec like the real one would,
// and prints a recorded stream-json run.
async function checkRun() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'llmd-'));
  const tools = fs.mkdtempSync(path.join(os.tmpdir(), 'llmd-agent-')); // outside the project, so not one of its changes
  const log = path.join(tools, 'args.log');
  const agent = path.join(tools, 'agent.js');
  const file = path.join(dir, '.llmd', 'run.llmd');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(agent, `
    const fs = require('fs');
    fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)) + '\\n');
    const spec = ${JSON.stringify(file)};
    fs.appendFileSync(${JSON.stringify(path.join(dir, 'a.ts'))}, 'export const built = true;\\n');
    fs.writeFileSync(${JSON.stringify(path.join(dir, 'b.ts'))}, 'export const b = 2;\\n'); // not an Edit: a command made it
    const first = fs.readFileSync(${JSON.stringify(log)}, 'utf8').trim().split('\\n').length === 1;
    fs.writeFileSync(spec, fs.readFileSync(spec, 'utf8').replace('## Build it', '## [x] Build it').replace('? which one', '// decided: this one'));
    for (const e of [
      { type: 'system', subtype: 'init', session_id: 'fake-1' },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'Hello from **the agent**' }] } },
      { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Edit', input: { file_path: ${JSON.stringify(path.join(dir, 'a.ts'))} } }] } },
      { type: 'result', subtype: 'success', session_id: 'fake-1', result: '\`\`\`\\nBuild it\\n\\nWith a body.\\n\`\`\`',
        permission_denials: first ? [{ tool_name: 'Bash', tool_input: { command: 'go test ./...' } }] : [] },
    ]) console.log(JSON.stringify(e));
  `);
  const settings = vscode.workspace.getConfiguration('llmd');
  await settings.update('agentCommand', `node ${agent}`, vscode.ConfigurationTarget.Global);
  try {
    fs.writeFileSync(file, 'lang: typescript\n\n## Build it\n@a.ts\n? which one\n\n## Later\n');
    // A repository with a.ts committed, so the run's changes come from git.
    fs.writeFileSync(path.join(dir, 'a.ts'), 'export const a = 1;\n');
    const git = (...args: string[]) => execFileSync('git', args, { cwd: dir });
    git('init', '-q');
    git('config', 'user.name', 't');
    git('config', 'user.email', 't@t');
    git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'empty');
    git('add', 'a.ts');
    git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'a');
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'mine, from before the step\n');
    const uri = vscode.Uri.file(file);
    await vscode.window.showTextDocument(uri);
    const key = runKey(uri, 'Build it');
    const done = async () => {
      for (let i = 0; i < 100 && (!runs.get(key) || runs.get(key)!.child); i++) await sleep(100);
    };

    await vscode.commands.executeCommand('llmd.implement', uri, 'Build it');
    await done();
    const run = runs.get(key);
    assert.ok(run?.panel, "Implement opens the step's run");
    assert.strictEqual(run.panel.viewColumn, vscode.ViewColumn.One, "the run takes the spec editor's place");
    assert.deepStrictEqual(run.before, ['## Build it', '@a.ts', '? which one'], 'the step as it was when the run started');
    // Markdown goes through VS Code's renderer, which adds its own attributes, so only the text is compared.
    const shown = run.messages.map((m) => [m.who, m.parts.map((p) => `${p.kind}: ${p.html.replace(/<p[^>]*>/g, '<p>').trim()}`)]);
    assert.deepStrictEqual(shown, [
      ['you', ['text: <p>Implement &quot;Build it&quot;</p>']],
      ['claude', ['text: <p>Hello from <strong>the agent</strong></p>', 'tool: Edit a.ts', 'error: Not allowed: Bash go test ./...']],
    ], 'the reply streams in, markdown rendered, the tool call on its own line and the refused command last');
    assert.strictEqual(run.messages[1].parts[1].file, path.join(dir, 'a.ts'), 'the edited file is kept for Changes');
    assert.deepStrictEqual(run.diffs?.map((d) => [d.name, d.status, d.added, d.removed]), [['a.ts', 'M', 1, 0], ['b.ts', 'A', 1, 0]],
      "every file the run changed, from git, but not notes.txt from before it or the spec");
    assert.ok(run.diffs![0].diff.includes('+export const built = true;'), run.diffs![0].diff);
    assert.match(run.diffs![0].new[1], /<span class="hljs-keyword">export<\/span>/, 'the code is highlighted');

    // Open shows a file's changes in the diff editor, from the tree the run started from; Open all shows them all.
    await openChanges(run, path.join(dir, 'a.ts'));
    const tab = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
    assert.ok(tab instanceof vscode.TabInputTextDiff, 'a diff editor');
    assert.strictEqual((await vscode.workspace.openTextDocument(tab.original)).getText(), 'export const a = 1;\n');
    await openChanges(run);
    assert.strictEqual(vscode.window.tabGroups.activeTabGroup.activeTab?.label, 'Build it: changes (2 files)', 'the multi-file diff editor');

    // A refused command can be allowed: it goes into the project's Claude settings, next to what's there.
    const refused = run.messages[1].parts.find((p) => p.allow);
    assert.deepStrictEqual(refused?.allow, ['Bash(go test *)']);
    fs.mkdirSync(path.join(dir, '.claude'));
    fs.writeFileSync(path.join(dir, '.claude', 'settings.local.json'), '{ "permissions": { "allow": ["Bash(ls *)"] } }');
    assert.ok(await allow(run, refused!.allow!));
    const claude = JSON.parse(fs.readFileSync(path.join(dir, '.claude', 'settings.local.json'), 'utf8'));
    assert.deepStrictEqual(claude.permissions.allow, ['Bash(ls *)', 'Bash(go test *)']);

    await send(run, 'and now?');
    await done();
    const calls = fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as string[]);
    assert.ok(!calls[0].includes('--resume') && calls[0].at(-1)!.startsWith('implement the step "Build it" in .llmd/run.llmd. ') &&
      calls[0].at(-1)!.includes('leave it in the spec'), `first run: ${calls[0]}`);
    assert.ok(calls[1].join(' ').includes('--resume fake-1') && calls[1].at(-1)!.startsWith('and now?'), `a message resumes the step's session: ${calls[1]}`);
    assert.strictEqual(run.messages.length, 4, 'the message and its answer join the same run');

    // Another step is another chat: a new session.
    await vscode.commands.executeCommand('llmd.plan', uri, 'Later');
    await done();
    await sleep(200);
    const third = fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as string[])[2];
    assert.ok(!third.includes('--resume') && third.at(-1)!.startsWith('plan the step "Later"'), `each step starts its own chat: ${third}`);

    // Done takes the ticked step out of its spec, since the code has what it lists: a.ts.
    await vscode.commands.executeCommand('llmd.done', uri, 'Build it');
    const left = fs.readFileSync(file, 'utf8');
    assert.ok(!left.includes('Build it') && left.includes('## Later'), `the done step leaves the spec: ${left}`);
    assert.ok(runs.get(key)!.done);

    // Claude writes the commit message, and Commit takes only the step's files and its spec: not notes.txt or your
    // Claude permissions. Then the open steps are there to go on with.
    const message = await writeMessage(runs.get(key)!);
    assert.strictEqual(message, 'Build it\n\nWith a body.', 'the message without its fences');
    await commit(runs.get(key)!, message!);
    assert.deepStrictEqual(git('show', '--name-only', '--format=%s', 'HEAD').toString().trim().split('\n').filter(Boolean),
      ['Build it', '.llmd/run.llmd', 'a.ts', 'b.ts']);
    assert.strictEqual(runs.get(key)!.committed?.replace(/^\w+ /, ''), 'Build it');
    assert.deepStrictEqual(await nextSteps(vscode.Uri.file(dir)), [{ spec: uri.toString(), step: 'Later', where: 'run.llmd' }]);

    // Done on a step Claude hasn't ticked does nothing: it stays where it is.
    const later = runs.get(runKey(uri, 'Later'))!;
    await vscode.commands.executeCommand('llmd.done', uri, 'Later');
    assert.ok(!later.done && fs.readFileSync(file, 'utf8').includes('## Later'), 'an unticked step stays where it is');

    // A ticked step taken out of the spec by hand is done too.
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('## Later', '## [x] Later'));
    for (let i = 0; i < 50 && !later.last?.[0].includes('[x]'); i++) await sleep(100);
    fs.writeFileSync(file, 'lang: typescript\n');
    await vscode.commands.executeCommand('llmd.done', uri, 'Later');
    assert.ok(later.done, 'Done on a ticked step that was taken out already');

    // A new step with a done step's title is its own step: no Run lens to the old review, and Implement starts a fresh chat.
    fs.writeFileSync(file, 'lang: typescript\n\n## Build it\n@a.ts\n');
    assert.ok(!hasRun(uri, 'Build it'), 'a done run is history');
    await vscode.commands.executeCommand('llmd.implement', uri, 'Build it');
    await done();
    const again = runs.get(key)!;
    const restarted = fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as string[]).at(-1)!;
    assert.ok(!restarted.includes('--resume') && !again.done && again.messages.length === 2, `a fresh run and session: ${restarted}`);

    // Done on a spec's last step deletes the spec too, and the commit leaves out a deleted spec git never tracked.
    const once = path.join(dir, '.llmd', 'once.llmd');
    fs.writeFileSync(once, '# Once\n\n## [x] Once\n@a.ts\n');
    await vscode.commands.executeCommand('llmd.done', vscode.Uri.file(once), 'Once');
    assert.ok(!fs.existsSync(once), 'a spec with no steps left is gone');
    const onceRun = runs.get(runKey(vscode.Uri.file(once), 'Once'))!;
    for (let i = 0; i < 50 && !onceRun.diffs; i++) await sleep(100); // the run's tab reads them when it opens
    await commit(onceRun, 'Once');
    const shownOnce = git('show', '--name-only', '--format=%s', 'HEAD').toString().trim().split('\n');
    assert.ok(shownOnce[0] === 'Once' && shownOnce.includes('a.ts') && !shownOnce.includes('.llmd/once.llmd'), shownOnce.join(', '));
  } finally {
    await settings.update('agentCommand', undefined, vscode.ConfigurationTarget.Global);
  }
}
