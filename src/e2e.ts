// Runs inside a real VS Code (see runE2E.ts). Opens example.llmd without a folder, like a user would.
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { doneLines } from './extension';

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
  await checkDrift();
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
    [2, 'llmd.implement', 'More input'], [2, 'llmd.plan', 'More input'],
    [4, 'llmd.implement', 'Fix it'], [4, 'llmd.plan', 'Fix it'],
  ], 'Implement and Plan show on open ## steps only');
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

async function checkDrift() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'llmd-'));
  const code = vscode.Uri.file(path.join(dir, 'store.ts'));
  fs.writeFileSync(code.fsPath, 'export class Store {\n  save() {}\n}\nexport function load() {}\n');
  // Wait for the TypeScript server, so the spec's first check gets an answer.
  for (let i = 0; i < 60; i++) {
    const found = await vscode.commands.executeCommand<unknown[] | undefined>('vscode.executeDocumentSymbolProvider', code);
    if (found?.length) break;
    await sleep(250);
  }
  const file = path.join(dir, 'drift.llmd');
  fs.writeFileSync(file, [
    '## [x] Current state',
    '@store.ts',
    '  : Store',
    '    - save()',
    '    - remove()',
    '  - load()',
    '## Open',
    '@store.ts',
    '  - planned()',
  ].join('\n'));
  const spec = await vscode.workspace.openTextDocument(file);
  await vscode.window.showTextDocument(spec);
  let drift: string[] = [];
  for (let i = 0; i < 40 && drift.length === 0; i++) {
    await sleep(250);
    drift = vscode.languages.getDiagnostics(spec.uri).map((d) => d.message).filter((m) => m.includes('has no'));
  }
  assert.deepStrictEqual(drift, ["store.ts has no 'remove'"], "a done step's missing method warns; an open step's doesn't");
}
