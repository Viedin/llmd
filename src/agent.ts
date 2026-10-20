import * as path from 'path';

// What the agent is asked to do with one step: build it, or talk it through first.
export function stepPrompt(mode: 'implement' | 'plan', step: string, file: string): string {
  if (mode === 'implement') return `implement the step "${step}" in ${file}`;
  return `plan the step "${step}" in ${file}: discuss it with me, ask about anything unclear, ` +
    `and suggest what to add or change in the spec. Don't write any code.`;
}

// One headless claude run, streamed back as JSON lines, continuing the step's session when it has one.
// The prompt goes last, after "--", so a prompt starting with "-" isn't read as a flag.
export function agentArgs(prompt: string, session?: string): string[] {
  return ['-p', '--output-format', 'stream-json', '--verbose', ...(session ? ['--resume', session] : []), '--', prompt];
}

export interface Part {
  kind: 'text' | 'tool' | 'error';
  text: string;
  file?: string; // the file a tool call changed
  allow?: string[]; // the permission rules that would let a refused tool call run
}

const EDITS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit']);

// What one event of claude's stream-json output adds to the chat: the agent's text (markdown), a line per tool call,
// and at the end what it wasn't allowed to do. Thinking, hooks and tool results add nothing.
export function render(event: any, root: string): Part[] {
  if (event?.type === 'assistant') {
    return (event.message?.content ?? []).flatMap((b: any): Part[] =>
      b.type === 'text' && b.text ? [{ kind: 'text', text: b.text }]
      : b.type === 'tool_use' ? [{ kind: 'tool', text: tool(b.name, b.input, root), ...(EDITS.has(b.name) && b.input?.file_path ? { file: b.input.file_path } : {}) }]
      : []);
  }
  if (event?.type === 'result') {
    const parts: Part[] = (event.permission_denials ?? []).map((d: any) =>
      ({ kind: 'error', text: 'Not allowed: ' + tool(d.tool_name, d.tool_input, root), allow: allowRules(d.tool_name, d.tool_input) }));
    if (event.is_error) parts.push({ kind: 'error', text: (event.errors ?? [event.result ?? event.subtype]).join(' ') });
    return parts;
  }
  return [];
}

// "Edit cmd/main.go", "Bash go build ./...": the tool and what it works on, files relative to the project.
function tool(name: string, input: any, root: string): string {
  const file = input?.file_path ?? input?.notebook_path;
  const target: unknown = file ? path.relative(root, file) : input?.command ?? input?.pattern ?? input?.url;
  if (typeof target !== 'string' || !target) return name;
  const line = target.split('\n')[0];
  return `${name} ${line.length > 80 ? line.slice(0, 79) + '…' : line}`;
}

// Tools whose second word is a subcommand worth allowing on its own: "go build", not every go command.
// ponytail: a fixed list; other tools are allowed by their first word
const SUBCOMMANDS = new Set(['go', 'git', 'npm', 'pnpm', 'yarn', 'bun', 'deno', 'cargo', 'dotnet', 'docker', 'kubectl', 'gh', 'uv', 'pip', 'poetry', 'mvn', 'gradle', 'swift', 'flutter', 'dart', 'mix', 'bundle', 'composer']);

// The rules, in Claude Code's own format, that allow a refused tool call next time: one per command in a shell line,
// like "Bash(go build *)" for "go build ./... && go vet ./...", or the tool's name for any other tool.
export function allowRules(name: string, input: any): string[] {
  if (name !== 'Bash' || typeof input?.command !== 'string') return [name];
  const rules = input.command.split('\n')[0].split(/&&|\|\||[;|&]/).flatMap((part: string) => {
    const words = part.trim().replace(/^\(+/, '').split(/\s+/).filter(Boolean);
    if (!words.length) return [];
    const sub = SUBCOMMANDS.has(words[0]) && /^[a-z][\w-]*$/.test(words[1] ?? '') ? ' ' + words[1] : '';
    return [`Bash(${words[0]}${sub} *)`];
  });
  return [...new Set<string>(rules)];
}
