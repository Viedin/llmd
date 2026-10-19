// What the agent is asked to do with one step: build it, or talk it through first.
export function stepPrompt(mode: 'implement' | 'plan', step: string, file: string): string {
  if (mode === 'implement') return `implement the step "${step}" in ${file}`;
  return `plan the step "${step}" in ${file}: discuss it with me, ask about anything unclear, ` +
    `and suggest what to add or change in the spec. Don't write any code.`;
}

// The terminal command that starts the agent (claude, codex, ...) with a prompt.
export function agentCommand(command: string, prompt: string, shell: string): string {
  return `${command} ${quote(prompt, shell)}`;
}

// One argument, quoted for the shell the terminal runs.
function quote(arg: string, shell: string): string {
  if (/pwsh|powershell/i.test(shell)) return `'${arg.replace(/'/g, "''")}'`;
  // ponytail: cmd.exe has no real escaping; swapping " for ' is fine for a prompt in prose
  if (/cmd(\.exe)?$/i.test(shell)) return `"${arg.replace(/"/g, "'")}"`;
  return `'${arg.replace(/'/g, `'\\''`)}'`; // sh, bash, zsh, fish
}
