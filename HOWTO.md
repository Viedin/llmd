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

## 2. Start a project

1. Open the project **folder** in VS Code with File → Open Folder, so `@` completion lists your files.
2. Create a spec at the root, e.g. `flow.llmd`.
3. Optionally, add this line to the project's `CLAUDE.md`, so Claude keeps the spec in mind even when you don't mention it:
   ```
   The architecture is described in @flow.llmd, one ## step at a time. Keep it up to date when changing code.
   ```

## 3. Write a spec

Indent with 2 spaces. Each line belongs to the line above it that has less indentation.

### Steps

Each `##` heading is a **step**: one piece of work, like an issue.

- `## [ ] Title` is an open step. `## [x] Title` is a done one.
- Everything down to the next `##` belongs to the step, including `###` subsections.
- Anything above the first step (the title, `lang:`, general `// notes`) is context for every step.
- The same file can appear in several steps. Each step says what *that* step adds or changes in it.
- A done step is greyed out, so the open steps stand out. In the outline it shows as "done".

### Line types

| You write | It means | What the editor does |
|---|---|---|
| `# Title` | The spec's title. | Heading color. Shows in the outline. |
| `lang: csharp` | The language and stack, once at the top. | Nothing. It's for Claude. |
| `## [ ] Title` | A step. `[x]` once it's done. | Shows in the outline. A done step is greyed out. |
| `@Program.cs` | An **existing** file. Lines under it say what it has or should get. | Ctrl+click opens the file. A warning if the file doesn't exist. |
| `+HandleUser.cs` | A **new** file to create. | Shown as "new file" in the outline. |
| `: Calculator` | A type, class or struct in the file above. Leave it out if the file only has one. | Type color. Shows in the outline. |
| `- total: double` | A field (no parentheses). | Shows in the outline. |
| `- Add(a, b) -> double` | A method or function (it has parentheses). `-> ...` is the return type and is optional. | Shows in the outline. |
| `- line` under a method | Logic, in order. Say what should happen, not the exact code. | Nothing special. |
| `HandleUser.ReadUserInput` in a line | A call to another method in the spec. | Ctrl+click jumps to it. A warning if a declared type has no such member. |
| `@docs/notes.md` in a line | "Read this for context." | Ctrl+click opens it. A warning if it doesn't exist. |
| `? use doubles or decimals` | An open question. Claude must ask you before building that step. | Highlighted. |
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

## [ ] More user interactions
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

- **`@`** lists the files and folders in your project. Type `/` to go into a folder. Paths start from the folder you have open, or from the `.llmd` file's own folder if you opened just the file.
- **`HandleUser.`** lists that file's or type's methods and fields. Typing a plain word suggests the types and file names you've declared.
- **Enter** after a file line, a `: Type` line or a method line starts the next line one level in, with `- ` already typed. Enter on an empty `- ` removes it and steps back out one level.
- **Ctrl+click** opens `@` files and jumps to `Name.method` definitions.
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

In Claude Code, in the project folder:

- `implement the next step in @flow.llmd` builds the first `## [ ]` step from the top.
- `implement "More user interactions" in @flow.llmd` builds a step by name.
- `implement ReadUserInput in @flow.llmd` builds just one method of a step.

### Answer the questions

Before writing any code, Claude asks all of these at once:

- every `?` in the step,
- anything it would otherwise have to guess,
- any file it would need to change that the step doesn't list,
- anything in the spec that contradicts the code it finds.

Your answers go into the step as `// decided: ...` lines, so each step keeps its own decisions.

### Review

Claude builds the step top-down, one file at a time, and reports back. Check:

- **The step tick.** Claude ticks `## [x]` only once the whole step is built and the code compiles, and its tests pass if there are any. The step then greys out.
- **`+` becomes `@`.** Once Claude creates a new file, its line changes from `+` to `@`.
- **The code itself.** Look at the diff the same way you'd review a pull request.

Claude only changes your spec in those three ways on its own: ticking the step, `+` → `@`, and `// decided:` lines. Anything else it proposes and waits for your OK.

### Commit

In a git repo, Claude offers to commit each finished step, with the step's title as the commit message. So your history reads like a list of closed issues. It only commits if you say yes.

### Change your mind

- **Something in a done step is wrong:** add a new step that fixes it, e.g. `## [ ] Fix division by zero`. That keeps the history honest.
- **To redo a step entirely:** edit it, change `## [x]` back to `## [ ]`, and ask Claude to implement it again.

### Start from existing code

`describe @src as llmd` writes a spec of code that already exists, as one `## [x] Existing code` step. Add your next steps below it as `## [ ]`.

## 5. Work on the extension itself

The extension is described in its own format in [spec.llmd](spec.llmd).

- `npm test` checks the parsers (paths, outline, symbols).
- `npm run test:e2e` starts a separate copy of VS Code and checks completion, warnings, colors, Enter, dimming, the outline and Ctrl+click. The first run downloads that copy into `.vscode-test/`.
- **F5** opens a debug window running your current code. Open `.llmd` files there with **File → Open File**.

## Known limits

- Paths can't contain spaces.
- Typo warnings only check `Type.member`, not `file.member`, because prose like `extension.ts` would look like a call.
- Markdown tables, quotes and numbered lists aren't colored in `.llmd` files.
- Ctrl+click works on `@` files but not on `@` folders.
- If you press Enter very quickly after typing a method line, the `- ` is sometimes not added.
