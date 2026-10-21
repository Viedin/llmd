import * as path from 'path';

// What the agent is asked to do with one step: build it, or talk it through first.
export function stepPrompt(mode: 'implement' | 'plan', step: string, file: string): string {
  if (mode === 'implement') return `implement the step "${step}" in ${file}`;
  return `plan the step "${step}" in ${file}: write what's unclear into the step as "?" lines, each with 2 to 4 answers I ` +
    `can pick under it, one line each: "- <the choice, at most 6 words> — <its trade-off, at most 12 words>", the one you ` +
    `recommend first, ending in " (recommended)". I answer them in the spec. Then suggest what else to add or change. ` +
    `Don't write any code.`;
}

// What the agent is asked for the answers to a ? you wrote in a step, which you then pick from in the editor.
export function answersPrompt(file: string, step: string[], question: string): string {
  return `In the spec ${file}, this step asks "${question}":\n\n${step.join('\n')}\n\n` +
    'Read the code it refers to as you need. Then reply with only 2 to 4 answers to pick from, one line each, as ' +
    '"- <the choice, in at most 6 words> — <its trade-off, in at most 12 words>". Put the one you recommend first, and end ' +
    'it with " (recommended)". No other text, and change no files.';
}

// The answers in the agent's reply to answersPrompt: its "- " lines.
export const answersIn = (reply: string) => [...reply.matchAll(/^\s*[-*]\s+(.*\S)/gm)].map((m) => m[1].replace(/\*\*/g, ''));

export type AgentId = 'claude' | 'codex';

// The agents a run can use, picked in the settings, and the command each starts unless you set your own.
export const AGENTS: Record<AgentId, { name: string; command: string }> = {
  claude: { name: 'Claude', command: 'claude --permission-mode auto' },
  codex: { name: 'Codex', command: 'codex exec' },
};

// One headless run, streamed back as JSON lines, continuing the step's session when it has one, and only reading when
// `readOnly`: what goes after the command, and what goes to its stdin. Claude takes the prompt last, after "--", so a
// prompt starting with "-" isn't read as a flag. Codex reads it from stdin, and works in its sandbox.
export function agentArgs(agent: AgentId, prompt: string, session?: string, readOnly = false): { args: string[]; input: string } {
  if (agent === 'codex') {
    const sandbox = ['--sandbox', readOnly ? 'read-only' : 'workspace-write'];
    return { args: ['--json', '--skip-git-repo-check', ...sandbox, ...(session ? ['resume', session] : [])], input: prompt };
  }
  const tools = readOnly ? ['--disallowedTools', 'Edit Write MultiEdit NotebookEdit Bash'] : [];
  return { args: ['-p', '--output-format', 'stream-json', '--verbose', ...tools, ...(session ? ['--resume', session] : []), '--', prompt], input: '' };
}

// The agent's own interactive CLI on a step, for a run in a terminal: what goes after its program. Claude starts the
// step's session under that id, or goes on with it when `resume`. Codex's interactive CLI is `codex` without `exec`.
export function terminalArgs(agent: AgentId, flags: string[], prompt: string, session: string, resume: boolean): string[] {
  if (agent === 'codex') return [...(flags[0] === 'exec' ? flags.slice(1) : flags), '--', prompt];
  return [...flags, resume ? '--resume' : '--session-id', session, '--', prompt];
}

// The session an event says the run is in: Claude's when it starts, Codex's thread when it starts. A resume of a missing
// session never gets one.
export const startedIn = (event: any): string | undefined =>
  event?.type === 'system' && event.subtype === 'init' ? event.session_id : event?.type === 'thread.started' ? event.thread_id : undefined;

export interface Part {
  kind: 'text' | 'tool' | 'error';
  text: string;
  file?: string; // the file a tool call changed
  allow?: string[]; // the permission rules that would let a refused tool call run
}

const EDITS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit']);

// What one event of the agent's JSON output adds to the chat: its text (markdown), a line per tool call, and Claude's
// last says what it wasn't allowed to do. Thinking, hooks and tool results add nothing.
export function render(event: any, root: string): Part[] {
  if (/^(item|turn)\.|^error$/.test(event?.type)) return codex(event, root);
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

// An event of `codex exec --json`: a line per command it starts and file it changes, as Claude's tool calls read.
function codex(event: any, root: string): Part[] {
  const item = event.item ?? {};
  if (event.type === 'item.started') {
    if (item.type === 'command_execution') return [{ kind: 'tool', text: tool('Bash', { command: shell(item.command) }, root) }];
    if (item.type === 'mcp_tool_call') return [{ kind: 'tool', text: `${item.server} ${item.tool}` }];
  }
  if (event.type === 'item.completed') {
    if (item.type === 'agent_message' && item.text) return [{ kind: 'text', text: item.text }];
    if (item.type === 'web_search') return [{ kind: 'tool', text: tool('WebSearch', { pattern: item.query }, root) }];
    if (item.type === 'error') return [{ kind: 'error', text: item.message }];
    if (item.type === 'file_change') return (item.changes ?? []).map((c: any): Part => {
      const file = path.resolve(root, c.path);
      return { kind: 'tool', text: tool(c.kind === 'add' ? 'Write' : c.kind === 'delete' ? 'Delete' : 'Edit', { file_path: file }, root), file };
    });
  }
  if (event.type === 'turn.failed' || event.type === 'error') return [{ kind: 'error', text: event.error?.message ?? event.message }];
  return [];
}

// The command inside Codex's shell wrapper: "go test ./..." for "bash -lc 'go test ./...'".
const shell = (command: unknown) => {
  const line = Array.isArray(command) ? command.join(' ') : String(command ?? '');
  return line.match(/^(?:\S*\/)?(?:ba|z)?sh -lc (['"])([\s\S]*)\1$/)?.[2] ?? line;
};

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
