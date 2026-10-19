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

  await checkCodeLens();
  await checkHighlighting();
  await checkEnter();
  await checkSymbols();
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

  await pressEnter();
  assert.strictEqual(doc.lineAt(2).text, '  ', 'Enter on an empty bullet removes it and outdents');
  assert.strictEqual(doc.lineCount, 3);
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
  assert.deepStrictEqual(typos, ["Debouncer has no member 'Pussh'"]);
}

async function checkCodeLens() {
  const { doc } = await openTemp('lens.llmd', '# Calc\n## [x] Basic\n## More input\n### Notes\n## [ ] Fix it');
  const lenses = await vscode.commands.executeCommand<vscode.CodeLens[]>('vscode.executeCodeLensProvider', doc.uri);
  assert.deepStrictEqual(lenses.map((l) => [l.range.start.line, l.command?.arguments?.[1]]), [[2, 'More input'], [4, 'Fix it']],
    'Implement shows on open ## steps only');
}
