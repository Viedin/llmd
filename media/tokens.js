// The .llmd grammar (syntaxes/llmd.tmLanguage.json) mirrored for the run tab, so the step there is colored the way the
// editor colors it: a line as [start, end, token] pieces, each token's scopes being in src/theme.ts. The e2e checks the
// two agree. Inside a line it knows @paths, `code` and **bold**, not the rest of markdown.
// ponytail: line by line, so the run tab passes a fence's lines as one plain piece each
function grammar(text) {
  const out = [];
  const piece = (s, e, token) => e > s && out.push([s, e, token]);
  // From `from` on: @paths, `code` and **bold**, in `ctx`'s colors when it's inside a free line or a check.
  const inline = (from, ctx) => {
    const re = /(?<![\w@])@[\w\-./]+|`[^`]+`|\*\*[^*]+\*\*/g;
    re.lastIndex = from;
    let at = from;
    for (let m; (m = re.exec(text));) {
      const kind = m[0][0] === '@' ? 'path' : m[0][0] === '`' ? 'raw' : 'bold';
      piece(at, m.index, ctx || 'plain');
      piece(m.index, m.index + m[0].length, ctx ? `${ctx}-${kind}` : kind);
      at = m.index + m[0].length;
    }
    piece(at, text.length, ctx || 'plain');
  };
  // The pieces a match's groups make, in order, then the line's markdown after it.
  const groups = (m, tokens, rest, ctx) => {
    let at = 0;
    m.slice(1).forEach((g, i) => {
      if (g === undefined) return;
      piece(at, at + g.length, tokens[i]);
      at += g.length;
    });
    if (rest) inline(at, ctx);
    else piece(at, text.length, tokens[tokens.length - 1]);
  };
  let m;
  // A ticked step's [x] is a markdown link to the editor.
  if ((m = /^( {0,3})(#{1,6})(\s+)(?:(\[)([xX])(\]))?(.*)$/.exec(text))) groups(m, ['heading', 'heading-punct', 'heading', 'box-punct', 'box', 'box-punct', 'heading']);
  else if (/^\s*\/\//.test(text)) piece(0, text.length, 'comment');
  else if ((m = /^(\s*)(?:(-)(\s+))?(\?)(.*)$/.exec(text))) groups(m, ['question', 'question-list', 'question', 'question-mark', 'question']);
  else if ((m = /^(\s*)([@+])([\w\-./]+)(\s*)$/.exec(text))) groups(m, ['plain', 'unit-op', 'path', 'plain']);
  else if ((m = /^(\s*)(?:(-)(\s+))?(:)(\s*)([A-Za-z_]\w*)/.exec(text))) groups(m, ['plain', 'list', 'plain', 'type-op', 'plain', 'type-name'], true);
  else if ((m = /^(\s*)(\*)(?=\s)/.exec(text))) groups(m, ['plain', 'list'], true, 'free');
  else if ((m = /^(\s*)(?:(-)(\s+))?(!)(?=\s|$)/.exec(text))) groups(m, ['plain', 'list', 'plain', 'check-mark'], true, 'check');
  else if ((m = /^(\s*)(-)(\s+(?:\[[ xX]\]\s+)?~?)([A-Za-z_]\w*)(?=\()/.exec(text))) groups(m, ['plain', 'list', 'plain', 'function'], true);
  else if ((m = /^(\s*)(-)(?=\s)/.exec(text))) groups(m, ['plain', 'list'], true);
  else inline(0);
  return out;
}

if (typeof module === 'object') module.exports = { grammar };
