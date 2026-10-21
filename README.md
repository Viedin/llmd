# <img src="images/icon.png" alt="LLMD logo" width="40" align="top"> LLMD

**Steer the architecture, let the agent write the code.**

LLMD is a small spec format for working with coding agents like Claude Code and Codex. In a `.llmd` file you describe the files, types, methods and logic you want, top-down, the way the code flows. You split the work into **steps**, like issues, and the agent builds one step at a time: it asks first, stays inside the step, and ticks it when it's done. The spec is your intent and the code is the proof: once the code has what a step lists, you mark it **Done** and it leaves the spec.

```
# Calculator
lang: csharp

## Let the user quit
+HandleUser.cs
  - ReadUserInput()
    - read the input like before
    - quit on q
  ? should q also work in the middle of entering numbers
    - yes, anywhere
    - only at the main prompt
  ! entering q exits with code 0

@Program.cs
  - use HandleUser.ReadUserInput
```

`@` is an existing file, `+` a new one, `-` a method or a line of logic, `?` a question, with answers to pick from under it, and `!` a check that must pass before the step is done. The rest is plain markdown.

LLMD has two parts:

- **A VS Code extension** that makes `.llmd` a real language that knows your code:
  - highlighting, `@` file completion, an outline and warnings for broken references;
  - under a file, its real types and methods to complete, with their hovers and Ctrl+click into the code, and after a `:`, any type your project has. What a step adds is green;
  - **Add to step** on a method in your code puts it in the plan;
  - a `?`'s answers to click, or **✨ Ask Claude** / **Ask Codex** to write them, so you decide while you sketch;
  - **▶ Implement** / **Plan** above each step, which turn the editor into the step's run: the step stays live on one side while the agent builds it, and you talk to it on the other. Then you review the changes, mark it **Done** and commit.
- **An agent skill** that teaches Claude Code, Codex and other agents what the syntax means and how to implement a step.

The runs use **Claude Code** or **Codex**, whichever you pick in the extension's settings.

**→ Read the [guide](https://github.com/Viedin/llmd/blob/main/docs/guide.md)** for the full syntax and workflow.

## Install

You only do this once. After that it works in every project.

### The extension

Download it from the latest release and install it. Run the same two commands to update:

```bash
curl -LO https://github.com/viedin/llmd/releases/latest/download/llmd.vsix
code --install-extension llmd.vsix
```

Cursor, Windsurf and VSCodium install the same file: use `cursor`, `windsurf` or `codium` in place of `code`. Any file ending in `.llmd` now uses the extension. The status bar's language mode shows **LLMD**.

### The skill

In Claude Code:

```
/plugin marketplace add viedin/llmd
/plugin install llmd@llmd
```

In Codex:

```bash
codex plugin marketplace add viedin/llmd
codex plugin add llmd@llmd
```

For other agents:

```bash
npx skills add viedin/llmd
```

The skill comes straight from the repo, so there's nothing to build. New sessions list `llmd` among their skills (in Codex, `/skills` shows it). Install it one way per agent: with two, the agent lists `llmd` twice.

### The agent

**▶ Implement**, **Plan** and the step's run start the agent's CLI in the background, so install one and sign in:

- [Claude Code](https://code.claude.com/docs), the `claude` command. It's the default.
- [Codex](https://learn.chatgpt.com/docs/codex/cli), the `codex` command. To use it, run **LLMD: Settings** from the Command Palette and set **Agent** to Codex.

LLMD: Settings also holds the command each agent starts, for your own flags, like a model. Set **Run In** to **Terminal** to talk to the agent in its own CLI instead, in a terminal next to the step. The [guide](https://github.com/Viedin/llmd/blob/main/docs/guide.md#the-agent) says what each runs with and what it may do.

## Quick start

1. Open your project **folder** in VS Code. To use Codex, set it as the agent in **LLMD: Settings**.
2. Run **LLMD: New feature** and write its `## step`, or create `.llmd/app.llmd` with a title, a `lang:` line and a first `## step`.
3. Not sure about something? Write it as a `? question` and pick an answer, or click **Plan** and the agent writes the questions for you.
4. Click **▶ Implement** above the step, or tell your agent `implement the next step`.
5. Answer its questions, review the changes, and once it has ticked the step and the code has what it lists, mark it **✓ Done** and commit.

The [guide](https://github.com/Viedin/llmd/blob/main/docs/guide.md) covers each of these in depth: [starting a project](https://github.com/Viedin/llmd/blob/main/docs/guide.md#1-start-a-project), [every line type](https://github.com/Viedin/llmd/blob/main/docs/guide.md#line-types), [handing decisions to the agent](https://github.com/Viedin/llmd/blob/main/docs/guide.md#hand-decisions-to-the-agent), [the editor's help while you write](https://github.com/Viedin/llmd/blob/main/docs/guide.md#editor-help-while-you-write), [runs](https://github.com/Viedin/llmd/blob/main/docs/guide.md#runs), [the agent](https://github.com/Viedin/llmd/blob/main/docs/guide.md#the-agent) and [reviewing a step](https://github.com/Viedin/llmd/blob/main/docs/guide.md#review).

## Contributing

Issues and pull requests are welcome. LLMD is planned in its own format: [.llmd/spec.llmd](.llmd/spec.llmd) holds the steps in progress.

Build the extension and install it into your normal VS Code, then reload the window. `npm install` only fetches the dependencies; packaging compiles:

```bash
npm install
npx @vscode/vsce package --out llmd.vsix
code --install-extension llmd.vsix --force
```

Link the skill to your checkout, so edits apply straight away. Remove the plugin first if you installed it, or the agent lists `llmd` twice:

```bash
ln -sfn "$PWD/skills/llmd" ~/.claude/skills/llmd
ln -sfn "$PWD/skills/llmd" ~/.codex/skills/llmd
```

- `npm test` checks the parsers (paths, outline, symbols).
- `npm run test:e2e` starts a separate copy of VS Code and checks completion, warnings, colors, Enter, dimming, the outline, Ctrl+click, what the plan knows about the code, and a step's run with a stand-in Claude and Codex. The first run downloads that copy into `.vscode-test/`.
- **F5** opens a debug window running your current code. Open `.llmd` files there with **File → Open File**.

### Releasing

1. Bump `version` in both `package.json` and `.claude-plugin/plugin.json`. Claude Code only updates the skill when the plugin's version changes.
2. Commit, then push the commit and a matching tag:
   ```bash
   git tag "v$(node -p "require('./package.json').version")"
   git push origin main --tags
   ```
3. The Release workflow checks the tag matches `package.json`, then builds `llmd.vsix` with `vsce package` and attaches it to a GitHub release. `.vscodeignore` decides what goes in it.
4. Upload the same `llmd.vsix` to the VS Code Marketplace by hand: download it from the release, then on the [publisher page](https://marketplace.visualstudio.com/manage/publishers/viedin) use **Update** (the first time, **New extension → Visual Studio Code**).

The skill needs no build: Claude Code, Codex and `npx skills` read `skills/llmd/` from `main`.

## License

[MIT](LICENSE)
