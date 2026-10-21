import * as fs from 'fs';
import * as path from 'path';

// The run tab colors the step the way the editor does: the grammar's tokens in the theme's colors. A webview only gets
// the theme's UI colors, so this reads its token colors from the theme's file and picks them the way the editor does.
// ponytail: no editor.tokenColorCustomizations, and no theme whose tokenColors is a .tmTheme file

// Each token of media/tokens.js, as the scopes the grammar gives it, outermost first.
export const TOKENS: Record<string, string[]> = (() => {
  const tokens: Record<string, string[]> = {
    plain: [],
    heading: ['markup.heading.markdown', 'entity.name.section.markdown'],
    'heading-punct': ['markup.heading.markdown', 'punctuation.definition.heading.markdown'],
    box: ['markup.heading.markdown', 'entity.name.section.markdown', 'meta.link.reference.markdown', 'string.other.link.title.markdown'],
    'box-punct': ['markup.heading.markdown', 'entity.name.section.markdown', 'meta.link.reference.markdown', 'punctuation.definition.link.title'],
    comment: ['comment.line.double-slash.llmd'],
    question: ['markup.bold.question.llmd'],
    'question-mark': ['markup.bold.question.llmd', 'keyword.control.question.llmd'],
    'question-list': ['markup.bold.question.llmd', 'punctuation.definition.list.begin.markdown'],
    'unit-op': ['keyword.operator.unit.llmd'],
    list: ['punctuation.definition.list.begin.markdown'],
    'type-op': ['keyword.operator.type.llmd'],
    'type-name': ['entity.name.type.llmd'],
    function: ['entity.name.function.llmd'],
    free: ['markup.italic.free.llmd'],
    check: ['markup.inserted.check.llmd'],
    'check-mark': ['keyword.control.check.llmd'],
    // The editor's semantic "type" token, for the code's types in signatures: what a theme without its own color for it
    // falls back to.
    'sem-type': ['entity.name.type'],
  };
  const inline = { path: 'string.other.path.llmd', raw: 'markup.inline.raw.string.markdown', bold: 'markup.bold.markdown' };
  for (const [kind, scope] of Object.entries(inline)) {
    tokens[kind] = [scope];
    for (const ctx of ['free', 'check']) tokens[`${ctx}-${kind}`] = [...tokens[ctx], scope];
  }
  for (const scopes of Object.values(tokens)) scopes.unshift('text.llmd');
  return tokens;
})();

interface Rule { selector: string; foreground?: string; fontStyle?: string }

// JSON with comments and trailing commas, as theme files are written.
export const jsonc = (text: string) =>
  JSON.parse(text.replace(/("(?:\\.|[^"\\])*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (_, str) => str ?? '').replace(/,(\s*[}\]])/g, '$1'));

// A theme's token rules, the themes it includes first, and its semantic token colors.
function load(file: string): { rules: Rule[]; semantic: Record<string, any> } {
  const theme = jsonc(fs.readFileSync(file, 'utf8'));
  const base = theme.include ? load(path.join(path.dirname(file), theme.include)) : { rules: [], semantic: {} };
  const own: Rule[] = (Array.isArray(theme.tokenColors) ? theme.tokenColors : []).flatMap((r: any) =>
    !r?.scope || !r.settings ? [] : (typeof r.scope === 'string' ? r.scope.split(',') : r.scope).map((s: string) =>
      ({ selector: s.trim(), foreground: r.settings.foreground, fontStyle: r.settings.fontStyle })));
  return { rules: [...base.rules, ...own], semantic: { ...base.semantic, ...theme.semanticTokenColors } };
}

// How well a selector like "markup.heading entity.name" fits a token's scopes: 0 when it doesn't. The deeper the scope
// its last part fits and the longer that part, the better, as in the editor.
function fit(selector: string, scopes: string[]): number {
  const parts = selector.split(/\s+/).filter(Boolean);
  if (!parts.length || parts.includes('-')) return 0; // ponytail: no exclusions
  const is = (scope: string, part: string) => scope === part || scope.startsWith(part + '.');
  let at = scopes.length - 1;
  while (at >= 0 && !is(scopes[at], parts[parts.length - 1])) at--;
  if (at < 0) return 0;
  for (let p = parts.length - 2, k = at - 1; p >= 0; p--, k--) {
    while (k >= 0 && !is(scopes[k], parts[p])) k--;
    if (k < 0) return 0;
  }
  return (at + 1) * 10000 + parts[parts.length - 1].split('.').length * 100 + parts.length;
}

// The color and font style the theme gives a token, each from the rule that fits it best; a later rule wins a tie.
function styleOf(rules: Rule[], scopes: string[]) {
  let color: [number, string] | undefined;
  let font: [number, string] | undefined;
  for (const r of rules) {
    const score = fit(r.selector, scopes);
    if (!score) continue;
    if (r.foreground && (!color || score >= color[0])) color = [score, r.foreground];
    if (r.fontStyle !== undefined && (!font || score >= font[0])) font = [score, r.fontStyle];
  }
  return { color: color?.[1], font: font?.[1] ?? '' };
}

// A stylesheet with a .t-<token> class per token, in the colors of the theme in `file`. Empty when it can't be read,
// and the run tab keeps its own colors.
export function themeCss(file: string | undefined): string {
  let theme: ReturnType<typeof load>;
  try {
    if (!file) return '';
    theme = load(file);
  } catch {
    return '';
  }
  const rule = (token: string, color: string | undefined, font: string) => `.t-${token} { color: ${color ?? 'var(--vscode-editor-foreground)'}; ` +
    `font-style: ${/italic/.test(font) ? 'italic' : 'normal'}; font-weight: ${/bold/.test(font) ? 'bold' : 'normal'}; ` +
    `text-decoration: ${/underline/.test(font) ? 'underline' : /strikethrough/.test(font) ? 'line-through' : 'none'}; }`;
  return Object.entries(TOKENS).map(([token, scopes]) => {
    const { color, font } = styleOf(theme.rules, scopes);
    if (token !== 'sem-type') return rule(token, color, font);
    // A semantic type only takes the color, over the grammar's, and a theme's own color for it comes first.
    const own = theme.semantic.type;
    return `.l .t-sem-type { color: ${(typeof own === 'string' ? own : own?.foreground) ?? color ?? 'inherit'}; }`;
  }).join('\n');
}
