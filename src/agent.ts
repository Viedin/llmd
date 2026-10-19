// The terminal command that asks the agent (claude, codex, ...) to implement one step.
export function agentCommand(command: string, step: string, file: string, shell: string): string {
  return `${command} ${quote(`implement the step "${step}" in ${file}`, shell)}`;
}

// One argument, quoted for the shell the terminal runs.
function quote(arg: string, shell: string): string {
  if (/pwsh|powershell/i.test(shell)) return `'${arg.replace(/'/g, "''")}'`;
  // ponytail: cmd.exe has no real escaping; swapping " for ' is fine for a prompt in prose
  if (/cmd(\.exe)?$/i.test(shell)) return `"${arg.replace(/"/g, "'")}"`;
  return `'${arg.replace(/'/g, `'\\''`)}'`; // sh, bash, zsh, fish
}
