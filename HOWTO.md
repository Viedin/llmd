# LLMD how-to

LLMD is a way to steer the architecture without writing the code yourself. You describe files, types, methods and the logic inside them in a `.llmd` file, top-down, the way code flows. Claude builds it from that spec.

There are two parts:

- **The VS Code extension.** It makes `.llmd` files feel like a language: highlighting, `@` file completion, an outline, Ctrl+click and warnings.
- **The Claude Code skill.** It teaches Claude what the syntax means and how to implement a spec: ask first, stay inside the spec, tick off what's done.

## 1. Install

### The extension

Build it and install it into your normal VS Code:

```bash
npm install
npx @vscode/vsce package --allow-missing-repository --skip-license
code --install-extension llmd-0.0.1.vsix --force
```

Then reload VS Code (Ctrl+Shift+P → **Developer: Reload Window**). Any file ending in `.llmd` now uses the extension. The status bar's language mode shows **LLMD**.

Run the same three commands again after you change the extension's code.

### The skill

Link the skill folder into Claude Code's skills folder. Run this in PowerShell:

```powershell
New-Item -ItemType Junction -Path "$env:USERPROFILE\.claude\skills\llmd" -Target "C:\Users\filip\code\typescript\llmd\skills\llmd"
```

Because it's a link, edits to [skills/llmd/SKILL.md](skills/llmd/SKILL.md) apply in every project straight away. New Claude Code sessions list `llmd` among their skills.

## 2. Write a spec

Create a file ending in `.llmd`, usually at the project root, like `flow.llmd`. Indent with 2 spaces. Each line belongs to the line above it that has less indentation.

### Line types

| You write | It means | What the editor does |
|---|---|---|
| `# Heading` | A section, like in markdown. Groups the files below it. | Heading color. Shows in the outline. |
| `lang: go` | The language and stack, once at the top. | Nothing. It's for Claude. |
| `@src/watcher.go` | An **existing** file. Lines under it say what it has or should get. | Ctrl+click opens the file. A warning if the file doesn't exist. |
| `+src/debounce.go` | A **new** file to create. | Shown as "new file" in the outline. |
| `: Debouncer` | A type, class or struct in the file above. Leave it out if the file only has one. | Type color. Shows in the outline. |
| `- wait: time.Duration` | A field (no parentheses). | Shows in the outline. |
| `- Push(path string) -> error` | A method or function (it has parentheses). `-> ...` is the return type and is optional. | Shows in the outline. |
| `- [x] Push(...)` | A method that's done. | The method and its logic are greyed out. |
| `- step` under a method | Logic, in order. Say what should happen, not the exact code. | Nothing special. |
| `Debouncer.Push` in a line | A call to another method in the spec. | Ctrl+click jumps to it. A warning if `Debouncer` has no `Push`. |
| `@docs/notes.md` in a line | "Read this for context." | Ctrl+click opens it. A warning if it doesn't exist. |
| `? should Push drop duplicates` | An open question. Claude must ask you before building that part. | Highlighted. |
| `// a note` | A note for context. Claude reads it but never treats it as a task. | Comment color. |

### Example

```
# Vaultwave sync
lang: go

@internal/watcher/watcher.go
  - [x] Start(dir string) -> error
    - walk dir and watch every folder
    - on change call Debouncer.Push(path)
  - Stop()
    - close the fsnotify watcher

+internal/sync/debounce.go
  : Debouncer
    - wait: time.Duration
    - Push(path string)
      - collect paths until `wait` passes with no new ones
      - then call Uploader.Send(paths)
  ? should Push drop duplicate paths

// conflict handling is out of scope for v1, see @docs/conflicts.md
```

Reading it top-down: `Start` is done, so it's greyed out. `Stop` still needs building. `debounce.go` is a new file with a `Debouncer` type that has one field and one method. There's one open question for Claude to ask before it builds the Debouncer.

### Editor help while you write

- **`@`** lists the files and folders in your project. Type `/` to go into a folder. Paths start from the folder you have open, or from the `.llmd` file's own folder if you opened just the file.
- **`Debouncer.`** lists that type's fields and methods. Typing a plain word suggests the types and file names you've declared.
- **Enter** after a file line, a `: Type` line or a method line starts the next line one level in, with `- ` already typed. Enter on an empty `- ` removes it and steps back out one level.
- **Ctrl+click** opens `@` files and jumps to `Name.method` definitions.
- **Outline:** the Outline panel, the breadcrumbs above the editor and **Ctrl+Shift+O** all show headings → files → types → methods.
- **Warnings** (yellow squiggles, also in Ctrl+Shift+M) flag `@` paths that don't exist and `Type.member` names that aren't declared.

### Tips

- **Methods belong to a type only when indented under it.** At the same indent as `: Debouncer`, they belong to the file instead.
- **Fields and methods differ only by the parentheses.** `- wait: time.Duration` is a field, `- Push(path string)` is a method.
- **Keep logic lines short and in order.** One step per line is easier for you to review and for Claude to follow.
- **Use `?` whenever you aren't sure.** It's cheaper than undoing a guess.
- **Group work into sections.** Headings like `## Done`, `## Next: outline` and `## Later` let you say "implement the Next section".

## 3. Work with Claude from a spec

### Implement

Point Claude at the spec in Claude Code:

- `implement @flow.llmd`
- `implement the "Next" section of @flow.llmd`
- `implement the Debouncer in @flow.llmd`

### Answer the questions

Before writing any code, Claude asks all of these at once:

- every `?` in the part you asked for,
- anything the spec doesn't cover, like a file it would need to change that isn't in the spec,
- anything in the spec that contradicts the code it finds.

Your answers go into the spec as `// decided: ...` lines, so the spec keeps the full story.

### Review

Claude builds top-down, one file at a time, and then reports what it did. Check:

- **`[x]` ticks.** Claude only ticks a method once it's built and compiles, and its tests pass if there are any. Ticked methods grey out, so what's left stands out.
- **`+` becomes `@`.** Once Claude creates a new file, its line changes from `+` to `@`.
- **The code itself.** Look at the diff the same way you'd review a pull request.

Claude only makes those two kinds of change to your spec, ticks and `// decided:` lines, on its own. Anything else it proposes and waits for your OK.

### Change your mind

Edit the spec, then turn the method's `[x]` back into `[ ]` (or delete the box) and ask Claude to implement it again.

### Start from existing code

`describe @internal/sync as llmd` writes a spec of code that already exists, with every method marked `[x]`. Edit it, add new methods without a tick, and ask Claude to implement them.

## 4. Work on the extension itself

The extension is described in its own format in [spec.llmd](spec.llmd).

- `npm test` checks the parsers (paths, outline, symbols).
- `npm run test:e2e` starts a separate copy of VS Code and checks completion, warnings, colors, Enter, the outline and Ctrl+click. The first run downloads that copy into `.vscode-test/`.
- **F5** opens a debug window running your current code. Open `.llmd` files there with **File → Open File**.

## Known limits

- Paths can't contain spaces.
- Typo warnings only check `Type.member`, not `file.member`, because prose like `extension.ts` would look like a call.
- Markdown tables, quotes and numbered lists aren't colored in `.llmd` files.
- Ctrl+click works on `@` files but not on `@` folders.
- If you press Enter very quickly after typing a method line, the `- ` is sometimes not added.
