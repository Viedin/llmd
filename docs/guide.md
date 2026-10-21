# LLMD guide

Everything about writing `.llmd` specs and working with the agent on them. To install LLMD, see the [README](../README.md#install).

- [1. Start a project](#1-start-a-project)
- [2. Write a spec](#2-write-a-spec): [steps](#steps), [one spec per feature](#one-spec-per-feature), [line types](#line-types), [example](#example), [`*` lines](#hand-decisions-to-the-agent), [`!` checks](#say-what-done-means), [editor help](#editor-help-while-you-write), [tips](#tips)
- [3. Work with the agent](#3-work-with-the-agent): [runs](#runs), [the agent](#the-agent), [implement](#implement-a-step), [plan](#plan-a-step), [questions](#answer-the-questions), [review](#review), [commit](#commit), [change your mind](#change-your-mind)
- [Known limits](#known-limits)

## 1. Start a project

1. Open the project **folder** in VS Code with File → Open Folder, so `@` completion lists your files.
2. Create a spec per feature in a `.llmd/` folder at the project root, e.g. `.llmd/book.llmd` (see [One spec per feature](#one-spec-per-feature)). That's where the agent looks when you don't name a spec, and `@` paths in it still start from the project root.

   In VS Code you don't need to make spec files yourself. **LLMD: New feature** in the command palette asks for a name and opens a fresh `.llmd/<name>.llmd` with a `## <name>` step to write in.
3. Decide whether to commit the specs. Committed, they're a history of what you planned. To keep them to yourself, add `.llmd/` to the project's `.gitignore`, or to your global one (`~/.config/git/ignore`) to skip them in every repo, e.g. at work.
4. Optionally, add this line to the project's `AGENTS.md`, so the agent keeps the spec in mind even when you don't mention it:
   ```
   The specs in .llmd/ hold planned work, one spec per feature: each ## step is a change to make. The code is what's built.
   ```
   Codex reads `AGENTS.md` on its own. For Claude Code, also add a `CLAUDE.md` holding just `@AGENTS.md`, which pulls the file in. So both agents share one file.

## 2. Write a spec

Indent with 2 spaces. Each line belongs to the line above it that has less indentation.

### Steps

Each `##` heading is a **step**: one piece of work, like an issue.

- `## Title` is an open step. Once it's built, the agent ticks it: `## [x] Title`. You can write `## [ ] Title` if you like the box, it means the same.
- A spec is intent, not a map of the code: a step says what to change. Once you mark a built step **Done**, it leaves the spec. The code is the proof of what was built, and git keeps the step's text.
- Everything down to the next `##` belongs to the step, including `###` subsections.
- Anything above the first step (the title, `lang:`, general `// notes`) is context for every step.
- The same file can appear in several steps. Each step says what *that* step adds or changes in it.
- A ticked step is greyed out while it waits for you, so the open steps stand out. In the outline it shows as "done".

### One spec per feature

Each spec is a vertical slice: `.llmd/book.llmd` holds everything for books, from the endpoints and the service to the entity and its db mapping. `.llmd/app.llmd` holds the shared setup, like startup, the db context and auth.

```
# Books
lang: csharp

## Search books
@Services/BookService.cs
  - Search(query: string) -> List<Book>
    - match the title or the author, ignoring case

@Endpoints/BookEndpoints.cs
  - MapBooks(app)
    - GET /books?q= calls BookService.Search
```

- **A shared file appears in every spec whose steps change it.** Each lists only its own feature's part: a book step adds `Books` to `AppDbContext.cs`, and a loan step adds `Loans`.
- **A step goes in the spec of the feature it's for**, even when it touches another feature's files. A loan step that adds `IsAvailable` to `Book.cs` lives in `loan.llmd`. The agent checks the other specs for open steps on the same files.
- **A small tool or a library** with no clear features can keep a single spec.

### Line types

| You write | It means | What the editor does |
|---|---|---|
| `# Title` | The spec's title. | Heading color. Shows in the outline. |
| `lang: csharp` | The language and stack, once at the top. | Nothing. It's for the agent. |
| `## Title` | A step. The agent makes it `## [x] Title` once it's built. | Shows in the outline. A ticked step is greyed out, with **✓ Done** above it once the code has what it lists. |
| `@Program.cs` | An **existing** file. Lines under it say what the step adds or changes in it. | Ctrl+click opens the file. A warning if the file doesn't exist. A new line under it completes the file's real types and methods. |
| `+HandleUser.cs` | A **new** file to create. A folder works too, e.g. `+cmd/internal/models` for a Go package. | Shown as "new file" in the outline. Everything under it is green: new. |
| `: Calculator` or `- : Calculator` | A type, class or struct in the file above. Leave it out if the file only has one. | Type color. Shows in the outline. After `: `, completion offers the spec's files' real types, and as you type, any type your project has. Green while its file doesn't have it; hover shows the real one, Ctrl+click opens it. |
| `- total: double` | A field (no parentheses). | Shows in the outline. |
| `- Add(a, b) -> double` | A method or function (it has parentheses). `-> ...` is the return type and is optional. | Shows in the outline. Green while its file doesn't have it; hover shows the real one, Ctrl+click opens it. |
| `- line` under a method | Logic, in order. Say what should happen, not the exact code. | Nothing special. |
| `* should also log` | A **free line**: what should happen, and the agent designs how. Works under a file, type or method, or on its own in a step. | Italic. |
| `HandleUser.ReadUserInput` in a line | A call to another method in the spec. | Ctrl+click jumps to it. A warning if a declared type has no such member. |
| `@docs/notes.md` in a line | "Read this for context." | Ctrl+click opens it. A warning if it doesn't exist. |
| `! returns 0 for empty input` | A **check**: something that must hold once the step is built. The agent proves it before ticking. `- ! ...` works too. | Green, the `!` in the tests' pass color. |
| `? use doubles or decimals` | An open question. The agent must ask you before building that step. `- ? ...` works too. Put the answers to pick from under it as `- ` lines, or let **Plan** write them. | The `?` in the warning color. Its answers show above it to click, or ⌘↵ on it, which makes it `// decided: ...`. With none, **✨ Ask Claude** (or Codex) writes them. |
| `- ~Stop()`, `~@Old.cs`, `- ~line` | A removal. The agent deletes that code. | Nothing special. |
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

Reading it top-down: the basic calculator is built and greyed out, with its decisions kept inside it, waiting for you to mark it done. The next step creates `HandleUser.cs` and changes `Program.cs` to use it. There's one open question for the agent to ask before it starts.

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
- Before ticking the step, the agent replaces each `*` line with the files, types and methods it actually built, so **Done** can check them against the code.

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
- Unlike `*` lines, the agent never rewrites checks.

### Editor help while you write

- **`@`** searches every file and folder in your project: `@book` finds `cmd/internal/models/book.go`. Type `/` to go into a folder one level at a time. A `+` at the start of a line does the same, for new files in existing folders. Paths start from the project root: the folder holding `.llmd/`. For a spec outside `.llmd/`, they start from the folder you have open, or from the spec's own folder if you opened just the file.
- **Types:** after `- id:`, in a method's parameters and after `->`, completion offers the types of the files the spec lists and the spec's own first, then, as you type, any type your project has (`app` finds `application` in `handler.go`), then the built-in types for its `lang:`. Those names are colored as types, and so is any type your project has, so a misspelled type stays plain. Hovering a type your project has, in any line, shows the real one, and Ctrl+click opens it, unless the spec declares it: then it goes there.
- **`:` names a type anywhere,** the way `@` names a file: in `- extend the : application`, typing after the `:` completes your project's types, and a type it has is colored, with its hover and Ctrl+click.
- **`HandleUser.`** lists that file's or type's methods and fields. Typing a plain word suggests the types and file names you've declared.
- **Enter** after a file line, a `: Type` line or a method line starts the next line one level in, with `- ` already typed. After any other `- `, `* ` or `! ` line, Enter starts a new one at the same level.
- **Enter on an empty `- `, `* ` or `! `** steps back out one level and keeps the bullet, so pressing Enter twice after a method's last logic line starts the next method. At the outermost level it removes the `- `.
- **The code, while you write.** Under an `@` file, a new `- ` line completes the file's real types and methods, with their docs, and under a `: Type` line, that type's own members. Hovering a method the file has shows its real signature and doc comment, and Ctrl+click opens it in the file. A type or method the file doesn't have yet is green, so you see at a glance what the step adds; everything under a `+` file is green. The symbols come from the language's own VS Code extension, so install the one for your language (C# Dev Kit, Go, Python…). Files without one are never green.
- **Ctrl+click** opens `@` files, opens types and methods the code has, and jumps to `Name.method` definitions in the spec.
- **Add to step,** from the code. Right-click in a code file and pick **LLMD: Add to step**: the method or type the cursor is in goes into the step, as `@file`, `: Type` and `- method()`, under what the step already lists of them. It goes into the step your cursor is in, in a spec you can see beside the code, or else one you pick. The spec then opens with the cursor at the end of the new line, ready for what should change; if the step lists it already, it says so and opens the spec there. Right-click files or folders in the Explorer to add them as `@` lines, or drag them into the spec with Shift held.
- **▶ Implement** and **Plan** above each open step run the agent on it, to build it or to talk it through first, in the step's [run](#runs). They stay there once a step has a run: clicking one again goes on in the same run, with what you told the agent before. **✓ Done** above a ticked step takes it out of the spec once the code has what it lists; until then it says what's missing, e.g. `Not in the code yet: src/store.ts has no 'remove'`.
- **Answers to click.** Under a `? question`, list the answers as `- ` lines, indented under it: Enter after a question starts the first one. Write each as `- choice — trade-off`: the choices show above the question, and the trade-offs are dimmed. Clicking one turns the question and its answers into `// decided: question: answer`. Your own answer you just write in. A question with no answers yet gets **✨ Ask Claude** (or **Ask Codex**, whichever [agent](#the-agent) you picked): it reads the step and the code it points to, without changing anything, and writes 2 to 4 answers that way, the one it recommends first, with a ★. **Plan** writes questions this way too, so you decide them while you sketch, and Implement starts with nothing left to ask. Cmd+Z undoes a decision.
- **⌘↵ (Ctrl+Enter) on a question** does it without the mouse: on a question with no answers it asks the agent, on one with answers it lists them to pick with the arrow keys, and on an answer it picks that one. The end of the line says which. Anywhere else, ⌘↵ does what it always does.
- **Outline:** the Outline panel, the breadcrumbs above the editor and **Ctrl+Shift+O** all show steps → files → types → methods.
- **Warnings** (yellow squiggles, also in Ctrl+Shift+M) flag `@` paths that don't exist and likely typos in `Type.member`, with a suggestion: `Debouncer.Pussh` → "Did you mean 'Push'?". A member that isn't close to a declared one, like an inherited `DbContext.Database`, doesn't warn.

### Tips

- **Keep steps small.** One step should be something you'd review in one sitting, like a single issue or pull request.
- **Methods belong to a type only when indented under it.** At the same indent as `: Calculator`, they belong to the file instead.
- **Fields and methods differ only by the parentheses.** `- total: double` is a field, `- Add(a, b)` is a method.
- **Keep logic lines short and in order.** One action per line is easier for you to review and for the agent to follow.
- **Use `?` whenever you aren't sure.** It's cheaper than undoing a guess.

## 3. Work with the agent

### Runs

The spec is where you write. When a step is ready, click **▶ Implement** or **Plan** above it, and the editor turns into the step's **run**, in the same spot:

- **The step, live, on the left.** It looks like the editor it came from, with line numbers and your theme's colors, and it follows the spec as the agent edits it. A `?`'s answers can be clicked there too. Lines the agent added since the run started are green and lines it removed are struck through, so you see a `?` become `// decided:`, a `*` become real lines, and the step get its tick.
- **The conversation on the right.** The agent's text, its tool calls and commands as small lines like `Edit cmd/main.go` (long runs of them fold into "12 actions"), and its errors and anything it wasn't allowed to do in red. Answer its questions in the box at the bottom. Lines you've selected in the spec go along with your message.
- **Allow** next to a refused command (Claude Code only) adds it to the project's `.claude/settings.local.json`, the way Claude Code's own "always allow" does, e.g. `Bash(go build *)`. **Continue with what you allowed** then tells Claude to run it again and carry on.
- **The bar on top** says where the step is: Implementing, Planning, Waiting for you, Built, or Done. **Edit spec** flips back to the spec at that step. The run stays in its tab, and Implement or Plan above the step goes on in it.
- **✓ Done** is there once the agent has ticked the step and the code has everything it lists: every file, and every type and method its file's language can vouch for. A tick the code doesn't back lists what's missing under the step instead, and you can ask the agent about it. Done takes the step out of the spec, and deletes the spec once its last step is done. **Done** above a ticked step does the same.
- **Changes** under the step: every file that changed since the step's run started, however it changed, with how many lines were added and removed. It comes from git and counts from the working tree as it was, so your uncommitted work from before doesn't show up as the step's. Click a file to unfold its highlighted diff. **Open** shows that file's changes in VS Code's diff editor and **Open all** shows them all in its multi-file one. Click **Changes** to fold the whole section. A run that started before the folder was a git repository counts from the last commit. Outside a git repository you only get the names of the files the agent edited.
- **Once you click Done**, the changes move into the conversation's place and become the main view, every file unfolded. A ticked step you take out of the spec by hand counts as done too. Above them, write a commit message or click **✨ Write with Claude** (or Codex), then **Commit** (or Cmd/Ctrl+Enter). The commit takes only the step's files and its spec: not your other uncommitted work, or `.claude/settings.local.json`, which holds the commands you allowed. Above the finished step, **Next** lists the open steps in `.llmd/` and **New feature**; click one to open its run.

Each step is its own chat, like a migration: a fresh session of the agent that knows the step, the spec and the code, not a long history. Plan and Implement of the same step share it. Once the step is done, the run is history, and the code is what was built. Runs come back after you restart VS Code.

### The agent

Runs use Claude Code or Codex. Pick one under **Agent** in LLMD's settings: run **LLMD: Settings** from the Command Palette, or open VS Code's settings and go to Extensions → LLMD. The agent also writes the answers to a `?` and the commit message, and the buttons say its name: **✨ Ask Codex**, **✨ Write with Codex**. Install its CLI, sign in, and install the [skill](../README.md#the-skill) for it. A step's chat with one agent doesn't carry over to the other: switching starts the step's next message in a fresh session.

When the agent fails, the run or the error says why in the agent's own words, like `Selected model is at capacity`. Try again, or pick another model in the agent's command.

**Claude Code** runs headless, with `claude -p`, at the project root. **Claude Command** is the command it starts, `claude --permission-mode auto` by default: Claude runs what's safe, like builds and tests, without asking. Nobody can answer a permission prompt in a headless run, so anything it would ask about is refused and shows as **Not allowed**, with **Allow** next to it. If `auto` isn't available on your plan, use `claude --permission-mode acceptEdits`: Claude may then edit files, and you allow each command once.

**Codex** runs with `codex exec --json` at the project root. **Codex Command** is the command it starts, `codex exec` by default; add your own flags after `exec`, like `-m gpt-5-codex`. LLMD sets the sandbox: `workspace-write` for a step's run, so Codex edits the project and runs its commands in it, and `read-only` when it writes answers or a commit message. Commands that need the network fail in the sandbox unless you add `-c sandbox_workspace_write.network_access=true`.

### Implement a step

Click **▶ Implement** above an open step. It saves the spec and opens the step's [run](#runs), where the agent builds it. Answer its questions there.

Implement and Plan tell the agent where the code has what the step names, so it doesn't spend time and tokens searching: `application: cmd/glucopher/handler.go:19 (struct)`, for the types and methods the step lists under its files and the types it names in signatures and after a `:`. They also say what the step lists that the code doesn't have yet. Nothing is stored in the spec: it's looked up from your language's extension each time, so it's never out of date.

### Plan a step

Click **Plan** to talk a step through before building it. The agent reads the step, the files and the code like it would before implementing. Everything unclear or worth choosing, it writes into the step as `?` questions with answers to pick under them, which you click in the editor or in the run's step. Then it discusses what's missing and what clashes with the code or your other specs. Other spec edits, such as new lines or whole new steps, it suggests and makes once you agree. It doesn't write code while planning. Planning and implementing share the step's run, so when you're done talking, click **▶ Implement** in its bar.

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
- **`!` checks.** The report says how each check was verified: which test covers it, or what the agent ran.
- **`*` becomes `-`.** Each free line is replaced by what the agent built for it. Check the design in its report along with the diff.
- **The code itself.** Look at the diff the same way you'd review a pull request.
- **Done.** Once you're happy, **✓ Done** checks that the code has every file, type and method the step lists, and takes the step out of the spec. The agent leaves that to you.

The agent only changes your spec in those four ways on its own: ticking the step, `+` → `@`, `// decided:` lines and replacing `*` lines. Anything else it proposes and waits for your OK.

### Commit

In a git repo, the agent offers to commit each finished step, with the step's title as the commit message. So your history reads like a list of closed issues. It only commits if you say yes.

### Change your mind

- **Something a step built is wrong:** add a new step that fixes it, e.g. `## Fix division by zero`. That keeps the history honest.
- **To redo a step entirely:** once it's done, the step is gone from the spec, and git has its text. Write a new step that changes the code, with `~` lines for what goes.

## Known limits

- Paths can't contain spaces.
- Typo warnings only check `Type.member`, not `file.member`, because prose like `extension.ts` would look like a call.
- Markdown tables, quotes and numbered lists aren't colored in `.llmd` files.
- Ctrl+click works on `@` files but not on `@` folders.
- If you press Enter very quickly after typing a method line, the `- ` is sometimes not added.
- Done and the green "new" color only check that names exist in the right file, not signatures, fields or logic: the step's tick vouches for those. A folder unit, like a Go package, only has to exist.
- A method is looked up in the type it's listed under, then in its whole file, so one listed under the wrong type still counts as there.
