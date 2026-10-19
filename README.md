# LLMD how-to

LLMD is a way to steer the architecture without writing the code yourself. In a `.llmd` file you describe the files, types, methods and logic you want, top-down, the way code flows. You split the work into **steps**, like issues, and your coding agent (Claude Code, Codex, ...) builds one step at a time.

There are two parts:

- **The VS Code extension.** It makes `.llmd` files feel like a language: highlighting, `@` file completion, an outline, Ctrl+click and warnings.
- **The agent skill.** It teaches the agent what the syntax means and how to implement a step: ask first, stay inside the step, tick it when it's done.

## 1. Install

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

For Codex and other agents:

```bash
npx skills add viedin/llmd
```

New sessions list `llmd` among their skills (in Codex, `/skills` shows it).

### The CLI

The `llmd` command folds finished steps into the snapshot (see [The snapshot](#the-snapshot)). It doesn't need VS Code, so it works the same from Zed or any terminal:

```bash
npm install -g https://github.com/viedin/llmd/releases/latest/download/llmd.tgz
```

### Working on LLMD itself

Build the extension and install it into your normal VS Code, then reload the window:

```bash
npm install
npx @vscode/vsce package --no-rewrite-relative-links
code --install-extension llmd-0.0.4.vsix --force
```

Link the skill and the CLI to this repo, so edits apply straight away (`npm run compile` after changing the CLI):

```bash
ln -sfn "$PWD/skills/llmd" ~/.claude/skills/llmd
ln -sfn "$PWD/skills/llmd" ~/.codex/skills/llmd
npm link
```

To release the CLI, bump `version` in `package.json`, commit, then push a matching tag. The Release workflow builds `llmd.tgz` and attaches it to a GitHub release:

```bash
git tag "v$(node -p "require('./package.json').version")"
git push origin --tags
```

## 2. Start a project

1. Open the project **folder** in VS Code with File → Open Folder, so `@` completion lists your files.
2. Create a spec per feature in a `.llmd/` folder at the project root, e.g. `.llmd/book.llmd` (see [One spec per feature](#one-spec-per-feature)). That's where the agent looks when you don't name a spec, and `@` paths in it still start from the project root.
3. Decide whether to commit the specs. Committed, they're a history of what you planned. To keep them to yourself, add `.llmd/` to the project's `.gitignore`, or to your global one (`~/.config/git/ignore`) to skip them in every repo, e.g. at work.
4. Optionally, add this line to the project's `AGENTS.md`, so the agent keeps the spec in mind even when you don't mention it:
   ```
   The architecture is the "## [x] Current state" step of each spec in .llmd/, one spec per feature; the ## steps below it are planned work. Keep them up to date when changing code.
   ```
   Codex reads `AGENTS.md` on its own. For Claude Code, also add a `CLAUDE.md` holding just `@AGENTS.md`, which pulls the file in. So both agents share one file.

## 3. Write a spec

Indent with 2 spaces. Each line belongs to the line above it that has less indentation.

### Steps

Each `##` heading is a **step**: one piece of work, like an issue.

- `## Title` is an open step. Once it's built, the agent ticks it: `## [x] Title`. You can write `## [ ] Title` if you like the box, it means the same.
- Everything down to the next `##` belongs to the step, including `###` subsections.
- Anything above the first step (the title, `lang:`, general `// notes`) is context for every step.
- The same file can appear in several steps. Each step says what *that* step adds or changes in it.
- A done step is greyed out, so the open steps stand out. In the outline it shows as "done".

### One spec per feature

Each spec is a vertical slice: `.llmd/book.llmd` holds everything for books, from the endpoints and the service to the entity and its db mapping. `.llmd/app.llmd` holds the shared setup, like startup, the db context and auth.

```
# Books
lang: csharp

## [x] Current state

@Entities/Book.cs
  - Id: int
  - Title: string

@Data/AppDbContext.cs
  - Books: DbSet<Book>

@Services/BookService.cs
  - GetAll() -> List<Book>

@Endpoints/BookEndpoints.cs
  - MapBooks(app)
    - GET /books calls BookService.GetAll
```

- **A shared file appears in every spec that adds to it.** Each lists only its own feature's part: `book.llmd` has `Books` in `AppDbContext.cs`, and `loan.llmd` has `Loans`.
- **A step goes in the spec of the feature it's for**, even when it touches another feature's files. A loan step that adds `IsAvailable` to `Book.cs` lives in `loan.llmd`. The agent checks the other specs for open steps on the same files.
- **A small tool or a library** with no clear features can keep a single spec.

### Line types

| You write | It means | What the editor does |
|---|---|---|
| `# Title` | The spec's title. | Heading color. Shows in the outline. |
| `lang: csharp` | The language and stack, once at the top. | Nothing. It's for the agent. |
| `## Title` | A step. The agent makes it `## [x] Title` once it's done. | Shows in the outline. A done step is greyed out. |
| `## [x] Current state` | The snapshot: the whole architecture as built. `llmd snapshot` keeps it up to date. | Like any done step. |
| `@Program.cs` | An **existing** file. Lines under it say what it has or should get. | Ctrl+click opens the file. A warning if the file doesn't exist. |
| `+HandleUser.cs` | A **new** file to create. A folder works too, e.g. `+cmd/internal/models` for a Go package. | Shown as "new file" in the outline. |
| `: Calculator` or `- : Calculator` | A type, class or struct in the file above. Leave it out if the file only has one. | Type color. Shows in the outline. |
| `- total: double` | A field (no parentheses). | Shows in the outline. |
| `- Add(a, b) -> double` | A method or function (it has parentheses). `-> ...` is the return type and is optional. | Shows in the outline. |
| `- line` under a method | Logic, in order. Say what should happen, not the exact code. | Nothing special. |
| `* should also log` | A **free line**: what should happen, and the agent designs how. Works under a file, type or method, or on its own in a step. | Italic. |
| `HandleUser.ReadUserInput` in a line | A call to another method in the spec. | Ctrl+click jumps to it. A warning if a declared type has no such member. |
| `@docs/notes.md` in a line | "Read this for context." | Ctrl+click opens it. A warning if it doesn't exist. |
| `! returns 0 for empty input` | A **check**: something that must hold once the step is built. The agent proves it before ticking. | Green. |
| `? use doubles or decimals` | An open question. The agent must ask you before building that step. | Highlighted. |
| `- ~Stop()`, `~@Old.cs`, `- ~line` | A removal. The agent deletes that code, and folding the step removes it from the snapshot. | Nothing special. |
| `// a note` | A note for context. The agent reads it but never treats it as a task. | Comment color. |

You can still put `[x]` on a single method (`- [x] Add(...)`) if you want to mark it done yourself, and it greys out. The agent doesn't add these, though: it only ticks steps.

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

Reading it top-down: the basic calculator is done and greyed out, with its decisions kept inside it. The next step creates `HandleUser.cs` and changes `Program.cs` to use it. There's one open question for the agent to ask before it starts.

### Hand decisions to the agent

A `-` line says how: you design it. A `*` line says what: the agent designs it. Mix them line by line, so you pin down the parts you care about and leave the rest:

```
## Export
@src/Report.cs
  * export the report as CSV and JSON
  * big reports shouldn't freeze the UI
  - ToCsv(rows) -> string
    * quote fields the way Excel expects

* log every export somewhere sensible
```

- Under a file, type or method, the agent chooses the methods, names and logic there.
- On its own in a step, with no file above it, the agent also chooses which files to touch.
- The agent decides instead of asking, and only asks when two designs have real trade-offs. Its report lists what it decided.
- Before ticking the step, the agent replaces each `*` line with the `-` lines it actually built. So `## [x] Current state` stays a map of the code, and your `*` wording is kept in the archive.

### Say what done means

A `!` line is a check: something that must be true once the step is built. Put it under a method, type or file, or on its own in a step for the step as a whole:

```
## Divide
@Calculator.cs
  - Divide(a, b) -> double
    - return a / b
    ! dividing by 0 throws, it doesn't return infinity

! dotnet test passes
```

- Before ticking, the agent verifies every check: as a test when the project has tests, otherwise by running or reading the code. Its report says how it verified each one.
- A failing check blocks the tick. The agent reports it instead.
- Unlike `*` lines, the agent never rewrites checks. Checks under a file, type or method stay in `## [x] Current state`, so they keep describing the code. Step-level checks go to the archive with the step.

### Editor help while you write

- **`@`** searches every file and folder in your project: `@book` finds `cmd/internal/models/book.go`. Type `/` to go into a folder one level at a time. A `+` at the start of a line does the same, for new files in existing folders. Paths start from the project root: the folder holding `.llmd/`. For a spec outside `.llmd/`, they start from the folder you have open, or from the spec's own folder if you opened just the file.
- **Types:** after `- id:`, in a method's parameters and after `->`, completion offers the types declared in the spec first, then the built-in types for its `lang:`. Those names are colored as types, so a misspelled type stays plain.
- **`HandleUser.`** lists that file's or type's methods and fields. Typing a plain word suggests the types and file names you've declared.
- **Enter** after a file line, a `: Type` line or a method line starts the next line one level in, with `- ` already typed. After any other `- `, `* ` or `! ` line, Enter starts a new one at the same level.
- **Enter on an empty `- `, `* ` or `! `** steps back out one level and keeps the bullet, so pressing Enter twice after a method's last logic line starts the next method. At the outermost level it removes the `- `.
- **Ctrl+click** opens `@` files and jumps to `Name.method` definitions.
- **▶ Implement** and **Plan** above each open step run the agent on it, to build it or to talk it through first (see [Work with the agent](#4-work-with-the-agent)).
- **Outline:** the Outline panel, the breadcrumbs above the editor and **Ctrl+Shift+O** all show steps → files → types → methods.
- **Warnings** (yellow squiggles, also in Ctrl+Shift+M) flag `@` paths that don't exist and likely typos in `Type.member`, with a suggestion: `Debouncer.Pussh` → "Did you mean 'Push'?". A member that isn't close to a declared one, like an inherited `DbContext.Database`, doesn't warn.
- **Drift warnings** flag a type or method in a done step, usually `## [x] Current state`, that its file no longer has, e.g. `src/store.ts has no 'remove'`. The symbols come from the language's own VS Code extension, so install the one for your language (C# Dev Kit, Go, Python…). Files without one aren't checked, and neither is `.llmd/archive/`, which describes the code as it was. Drift is checked when the spec opens and whenever you save any file; in between, a half-typed name doesn't warn.

### Tips

- **Keep steps small.** One step should be something you'd review in one sitting, like a single issue or pull request.
- **Methods belong to a type only when indented under it.** At the same indent as `: Calculator`, they belong to the file instead.
- **Fields and methods differ only by the parentheses.** `- total: double` is a field, `- Add(a, b)` is a method.
- **Keep logic lines short and in order.** One action per line is easier for you to review and for the agent to follow.
- **Use `?` whenever you aren't sure.** It's cheaper than undoing a guess.

## 4. Work with the agent

### Implement a step

Click **▶ Implement** above any open step. It saves the spec and starts your agent on that step in an **LLMD: Implement** terminal, at the project root. The next click sends the next step to the same session if the agent is still running there, and starts it again if you've quit it. By default it runs `claude`. To use Codex, set **LLMD: Agent Command** in VS Code's settings to `codex`, or add flags, e.g. `codex --model gpt-5.5`.

### Plan a step

Click **Plan** to talk a step through before building it. The agent reads the step, the files and the code like it would before implementing. Then it discusses: what's unclear, what's missing, and what clashes with the code or your other specs. It suggests concrete spec edits, such as `?` lines, new lines or whole new steps, and makes them once you agree. It never writes code in plan mode.

It runs in its own **LLMD: Plan** terminal, separate from Implement, because a session in plan mode can't start building just by being sent a prompt. By default it runs `claude --permission-mode plan`. Change it with **LLMD: Plan Command** in VS Code's settings. For Codex, use `codex --sandbox read-only --ask-for-approval on-request`: it can read and discuss, and asks before it writes the spec edits you agreed on.

Both terminals need VS Code's shell integration, which is on by default for zsh, bash, fish and PowerShell. Without it, every click opens a new terminal as before.

Or ask yourself in Claude Code or Codex, in the project folder:

- `implement the next step` builds the first step without `[x]`, from the spec in `.llmd/`. With several specs there, name one: `implement the next book step` or `implement the next step in .llmd/book.llmd`.
- `implement "More user interactions"` builds a step by name.
- `plan "More user interactions"` talks it through without writing code.
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

The agent builds the step top-down, one file at a time, and reports back. Check:

- **The step tick.** The agent ticks `## [x]` only once the whole step is built and the code compiles, and its tests and `!` checks pass. The step then greys out.
- **`+` becomes `@`.** Once the agent creates a new file, its line changes from `+` to `@`.
- **`~` lines.** Before ticking, the agent adds a `~` for every line in Current state that its code changed or removed, so the snapshot stays true.
- **`!` checks.** The report says how each check was verified: which test covers it, or what the agent ran.
- **`*` becomes `-`.** Each free line is replaced by what the agent built for it. Check the design in its report along with the diff.
- **The snapshot.** After ticking, the agent runs `llmd snapshot`, so the step moves into `## [x] Current state`. It warns if a step still had `*` lines.
- **The code itself.** Look at the diff the same way you'd review a pull request.

The agent only changes your spec in those six ways on its own: ticking the step, `+` → `@`, `// decided:` lines, replacing `*` lines, adding `~` lines and `llmd snapshot`. Anything else it proposes and waits for your OK.

### The snapshot

Like EF Core migrations: each step is a small change, and `## [x] Current state` is the snapshot of everything built so far. `llmd snapshot [spec]` merges every done step into it, removes the step from the spec and appends it to `.llmd/archive/<spec>.llmd`. So the spec stays short: the current architecture, then the open steps.

The merge is plain text, with no AI involved:

- A file is matched by its path, a type, method or field by its name, anything else by its exact text.
- New lines are added. A method the step lists again gets the step's signature and its new logic lines; its old lines stay.
- A `~` line removes its match: `- ~Stop()`, `~@Old.cs` or `- ~print the result`. To rename, remove the old name and add the new one.
- `// decided:` lines are kept. The step's other notes are only in the archive.

Without a spec name it folds every spec in `.llmd/`. To start an older spec that has many done steps, run it once by hand.

### Commit

In a git repo, the agent offers to commit each finished step, with the step's title as the commit message. So your history reads like a list of closed issues. It only commits if you say yes.

### Change your mind

- **Something in a done step is wrong:** add a new step that fixes it, e.g. `## Fix division by zero`. That keeps the history honest.
- **To redo a step entirely:** once it's folded, the step is gone from the spec. Write a new step that changes the code, with `~` lines for what goes. The original is in `.llmd/archive/`.

### Start from existing code

`describe @src as llmd` writes specs of code that already exists to `.llmd/`: one per feature plus `app.llmd`, each as one `## [x] Current state` step. Add your next steps below them.

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
- Drift warnings only check that names exist, not signatures, fields or logic. Folder units like a Go package aren't checked.
