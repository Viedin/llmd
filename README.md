# LLMD how-to

LLMD is a way to steer the architecture without writing the code yourself. In a `.llmd` file you describe the files, types, methods and logic you want, top-down, the way code flows. You split the work into **steps**, like issues, and Claude builds one step at a time.

There are two parts:

- **The VS Code extension.** It makes `.llmd` files feel like a language: highlighting, `@` file completion, an outline, Ctrl+click and warnings.
- **The Claude Code skill.** It teaches Claude what the syntax means and how to implement a step: ask first, stay inside the step, tick it when it's done.

## 1. Install

You only do this once. After that it works in every project.

### The extension

Build it and install it into your normal VS Code:

```bash
npm install
npx @vscode/vsce package --allow-missing-repository --skip-license --no-rewrite-relative-links
code --install-extension llmd-0.0.1.vsix --force
```

Then reload VS Code (Ctrl+Shift+P → **Developer: Reload Window**). Any file ending in `.llmd` now uses the extension. The status bar's language mode shows **LLMD**.

Run the same three commands again after you change the extension's code.

### The skill

Link the skill folder into your agent's skills folder. Run from this repo:

```bash
ln -sfn "$PWD/skills/llmd" ~/.claude/skills/llmd   # Claude Code
ln -sfn "$PWD/skills/llmd" ~/.codex/skills/llmd    # Codex
```

On Windows (PowerShell), use a junction instead:

```powershell
New-Item -ItemType Junction -Path "$env:USERPROFILE\.claude\skills\llmd" -Target "C:\Users\filip\code\typescript\llmd\skills\llmd"
```

Because it's a link, edits to [skills/llmd/SKILL.md](skills/llmd/SKILL.md) apply in every project straight away. New sessions list `llmd` among their skills (in Codex, `/skills` shows it).

### The CLI

The `llmd` command folds finished steps into the snapshot (see [The snapshot](#the-snapshot)). It doesn't need VS Code, so it works the same from Zed or any terminal. Run from this repo:

```bash
npm install && npm run compile && npm link
```

After you change the CLI's code, `npm run compile` is enough: the link points at this repo.

## 2. Start a project

1. Open the project **folder** in VS Code with File → Open Folder, so `@` completion lists your files.
2. Create a spec in a `.llmd/` folder at the project root, e.g. `.llmd/flow.llmd`. That's where the agent looks when you don't name a spec, and `@` paths in it still start from the project root.
3. Decide whether to commit the specs. Committed, they're a history of what you planned. To keep them to yourself, add `.llmd/` to the project's `.gitignore`, or to your global one (`~/.config/git/ignore`) to skip them in every repo, e.g. at work.
4. Optionally, add this line to the project's `CLAUDE.md` (Claude Code) or `AGENTS.md` (Codex), so the agent keeps the spec in mind even when you don't mention it:
   ```
   The architecture is the "## [x] Current state" step of .llmd/flow.llmd; the ## steps below it are planned work. Keep it up to date when changing code.
   ```

## 3. Write a spec

Indent with 2 spaces. Each line belongs to the line above it that has less indentation.

### Steps

Each `##` heading is a **step**: one piece of work, like an issue.

- `## Title` is an open step. Once it's built, the agent ticks it: `## [x] Title`. You can write `## [ ] Title` if you like the box, it means the same.
- Everything down to the next `##` belongs to the step, including `###` subsections.
- Anything above the first step (the title, `lang:`, general `// notes`) is context for every step.
- The same file can appear in several steps. Each step says what *that* step adds or changes in it.
- A done step is greyed out, so the open steps stand out. In the outline it shows as "done".

### Line types

| You write | It means | What the editor does |
|---|---|---|
| `# Title` | The spec's title. | Heading color. Shows in the outline. |
| `lang: csharp` | The language and stack, once at the top. | Nothing. It's for Claude. |
| `## Title` | A step. The agent makes it `## [x] Title` once it's done. | Shows in the outline. A done step is greyed out. |
| `## [x] Current state` | The snapshot: the whole architecture as built. `llmd snapshot` keeps it up to date. | Like any done step. |
| `@Program.cs` | An **existing** file. Lines under it say what it has or should get. | Ctrl+click opens the file. A warning if the file doesn't exist. |
| `+HandleUser.cs` | A **new** file to create. A folder works too, e.g. `+cmd/internal/models` for a Go package. | Shown as "new file" in the outline. |
| `: Calculator` or `- : Calculator` | A type, class or struct in the file above. Leave it out if the file only has one. | Type color. Shows in the outline. |
| `- total: double` | A field (no parentheses). | Shows in the outline. |
| `- Add(a, b) -> double` | A method or function (it has parentheses). `-> ...` is the return type and is optional. | Shows in the outline. |
| `- line` under a method | Logic, in order. Say what should happen, not the exact code. | Nothing special. |
| `HandleUser.ReadUserInput` in a line | A call to another method in the spec. | Ctrl+click jumps to it. A warning if a declared type has no such member. |
| `@docs/notes.md` in a line | "Read this for context." | Ctrl+click opens it. A warning if it doesn't exist. |
| `? use doubles or decimals` | An open question. Claude must ask you before building that step. | Highlighted. |
| `- ~Stop()`, `~@Old.cs`, `- ~line` | A removal. Claude deletes that code, and folding the step removes it from the snapshot. | Nothing special. |
| `// a note` | A note for context. Claude reads it but never treats it as a task. | Comment color. |

You can still put `[x]` on a single method (`- [x] Add(...)`) if you want to mark it done yourself, and it greys out. Claude doesn't add these, though: it only ticks steps.

### Example

```
# Calculator
lang: csharp

## [x] Basic calculator
@Program.cs
  - promptUser()
    - ask the user for (1 +) (2 -) (3 /) (4 *)
  - handleInput()
  // decided: regular terminal
  // decided: handleInput reads the choice and two numbers, prints the result, then prompts again

## More user interactions
+HandleUser.cs
  - ReadUserInput()
    - read the input like before
    - ask the user if they want to leave
    - quit on q
  ? should q also work in the middle of entering numbers

@Program.cs
  - use HandleUser.ReadUserInput
```

Reading it top-down: the basic calculator is done and greyed out, with its decisions kept inside it. The next step creates `HandleUser.cs` and changes `Program.cs` to use it. There's one open question for Claude to ask before it starts.

### Editor help while you write

- **`@`** searches every file and folder in your project: `@book` finds `cmd/internal/models/book.go`. Type `/` to go into a folder one level at a time. A `+` at the start of a line does the same, for new files in existing folders. Paths start from the project root: the folder holding `.llmd/`. For a spec outside `.llmd/`, they start from the folder you have open, or from the spec's own folder if you opened just the file.
- **Types:** after `- id:`, in a method's parameters and after `->`, completion offers the types declared in the spec first, then the built-in types for its `lang:`. Those names are colored as types, so a misspelled type stays plain.
- **`HandleUser.`** lists that file's or type's methods and fields. Typing a plain word suggests the types and file names you've declared.
- **Enter** after a file line, a `: Type` line or a method line starts the next line one level in, with `- ` already typed. After any other `- ` line, Enter starts a new `- ` at the same level.
- **Enter on an empty `- `** steps back out one level and keeps the `- `, so pressing Enter twice after a method's last logic line starts the next method. At the outermost level it removes the `- `.
- **Ctrl+click** opens `@` files and jumps to `Name.method` definitions.
- **▶ Implement** above each open step runs the agent on it (see [Work with Claude](#4-work-with-claude)).
- **Outline:** the Outline panel, the breadcrumbs above the editor and **Ctrl+Shift+O** all show steps → files → types → methods.
- **Warnings** (yellow squiggles, also in Ctrl+Shift+M) flag `@` paths that don't exist and `Type.member` names that aren't declared.

### Tips

- **Keep steps small.** One step should be something you'd review in one sitting, like a single issue or pull request.
- **Methods belong to a type only when indented under it.** At the same indent as `: Calculator`, they belong to the file instead.
- **Fields and methods differ only by the parentheses.** `- total: double` is a field, `- Add(a, b)` is a method.
- **Keep logic lines short and in order.** One action per line is easier for you to review and for Claude to follow.
- **Use `?` whenever you aren't sure.** It's cheaper than undoing a guess.

## 4. Work with Claude

### Implement a step

Click **▶ Implement** above any open step. It saves the spec and starts your agent on that step in a new terminal, at the project root. By default it runs `claude`. To use Codex, set **LLMD: Agent Command** in VS Code's settings to `codex`, or add flags, e.g. `codex --model gpt-5.5`.

Or ask yourself in Claude Code or Codex, in the project folder:

- `implement the next step` builds the first step without `[x]`, from the spec in `.llmd/`. With several specs there, name one: `implement the next step in .llmd/flow.llmd`.
- `implement "More user interactions"` builds a step by name.
- `implement ReadUserInput` builds just one method of a step.

### Answer the questions

Before writing any code, the agent reads the whole spec, the files the step lists, and the step titles of the other specs in `.llmd/`, so it knows what else is planned or done. Then it asks all of these at once:

- every `?` in the step,
- anything it would otherwise have to guess,
- any file it would need to change that the step doesn't list,
- anything in the spec that contradicts the code it finds,
- another spec's open step that plans different changes to the same file.

Your answers go into the step as `// decided: ...` lines, so each step keeps its own decisions.

### Review

Claude builds the step top-down, one file at a time, and reports back. Check:

- **The step tick.** The agent ticks `## [x]` only once the whole step is built and the code compiles, and its tests pass if there are any. The step then greys out.
- **`+` becomes `@`.** Once Claude creates a new file, its line changes from `+` to `@`.
- **The snapshot.** After ticking, Claude runs `llmd snapshot`, so the step moves into `## [x] Current state`.
- **The code itself.** Look at the diff the same way you'd review a pull request.

Claude only changes your spec in those four ways on its own: ticking the step, `+` → `@`, `// decided:` lines and `llmd snapshot`. Anything else it proposes and waits for your OK.

### The snapshot

Like EF Core migrations: each step is a small change, and `## [x] Current state` is the snapshot of everything built so far. `llmd snapshot [spec]` merges every done step into it, removes the step from the spec and appends it to `.llmd/archive/<spec>.llmd`. So the spec stays short: the current architecture, then the open steps.

The merge is plain text, with no AI involved:

- A file is matched by its path, a type, method or field by its name, anything else by its exact text.
- New lines are added. A method the step lists again gets the step's signature and its new logic lines; its old lines stay.
- A `~` line removes its match: `- ~Stop()`, `~@Old.cs` or `- ~print the result`. To rename, remove the old name and add the new one.
- `// decided:` lines are kept. The step's other notes are only in the archive.

Without a spec name it uses the only spec in `.llmd/`. To start an older spec that has many done steps, run it once by hand.

### Commit

In a git repo, Claude offers to commit each finished step, with the step's title as the commit message. So your history reads like a list of closed issues. It only commits if you say yes.

### Change your mind

- **Something in a done step is wrong:** add a new step that fixes it, e.g. `## Fix division by zero`. That keeps the history honest.
- **To redo a step entirely:** once it's folded, the step is gone from the spec. Write a new step that changes the code, with `~` lines for what goes. The original is in `.llmd/archive/`.

### Start from existing code

`describe @src as llmd` writes a spec of code that already exists to `.llmd/`, as one `## [x] Current state` step. Add your next steps below it.

## 5. Work on the extension itself

The extension is described in its own format in [.llmd/spec.llmd](.llmd/spec.llmd), with the finished steps in [.llmd/archive/](.llmd/archive/spec.llmd).

- `npm test` checks the parsers (paths, outline, symbols).
- `npm run test:e2e` starts a separate copy of VS Code and checks completion, warnings, colors, Enter, dimming, the outline and Ctrl+click. The first run downloads that copy into `.vscode-test/`.
- **F5** opens a debug window running your current code. Open `.llmd` files there with **File → Open File**.

## Known limits

- Paths can't contain spaces.
- Typo warnings only check `Type.member`, not `file.member`, because prose like `extension.ts` would look like a call.
- Markdown tables, quotes and numbered lists aren't colored in `.llmd` files.
- Ctrl+click works on `@` files but not on `@` folders.
- If you press Enter very quickly after typing a method line, the `- ` is sometimes not added.
- `llmd snapshot` only adds logic lines, so when a step changes how a method behaves, its old line stays in Current state until a step removes it with `~`.
- Methods with the same name (overloads) merge into one in the snapshot.
