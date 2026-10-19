---
name: llmd
description: Read, write and implement .llmd files, a markdown-based spec format where the user describes work as steps (## headings) of files, types, methods and logic, top-down, and the agent implements one step at a time. Use whenever a .llmd file is mentioned, opened or referenced with @, when asked to implement a spec or "the next step", or when asked to describe existing code "as llmd".
---

# LLMD

An `.llmd` file is a spec the user writes so they can steer the architecture without writing the code. It reads top-down, the way code flows. The work is split into **steps**, like issues: each `##` heading is one. Your job is to turn a step into code exactly as described, and to ask when it doesn't say enough.

## Where specs live

Specs live in a `.llmd/` folder at the project root. New specs go there too, unless the user says otherwise. `@` paths in a spec always start from the project root (the folder holding `.llmd/`), not from `.llmd/`.

There's **one spec per feature**, a vertical slice: `.llmd/book.llmd` holds everything for books, from the endpoints and the service to the entity and its db mapping. `.llmd/app.llmd` holds the shared setup: startup, the db context, auth.

- A shared file appears in every spec that adds to it, and each lists only its own feature's part. `book.llmd` lists `@Data/AppDbContext.cs` with just `- Books: DbSet<Book>`.
- A step goes in the spec of the feature it's for, even when it touches another feature's files. A loan step that adds `IsAvailable` to `Book.cs` lives in `loan.llmd`.
- When the user doesn't name a spec: if there's one, use it. If there are several, use the one the request points to ("the next book step"), else ask which one.

## Syntax

Indent with 2 spaces. Each level belongs to the line above it.

| Line | Meaning |
|---|---|
| `# Title` | The spec's title. |
| `lang: go` | Stack for the whole file, at the top. Write idiomatic code for it. |
| `## Title` | A **step**: one piece of work, like an issue. Everything down to the next `##` belongs to it. `## [ ] Title` means the same. |
| `## [x] Title` | A done step. Context for later steps; don't redo it. |
| `## [x] Current state` | The **snapshot**: the whole architecture as built, made by folding done steps into it. Read it first. |
| `### Heading` | A subsection inside a step. Part of that step. |
| `@path/to/file.go` | A unit: an **existing** file. Children describe what it has or should get. |
| `+path/to/file.go` | A unit: a **new** file to create. A unit can also be a folder or package, e.g. `+cmd/internal/models`. |
| `: Name` or `- : Name` | A type, class or struct inside the unit above. Optional when the file has only one. |
| `- name: Type` | A field (no parentheses). |
| `- Name(args) -> Return` | A method or function (has parentheses). `-> Return` is optional. |
| `- [x] Name(...)` | The user marked this method done. Treat it as built. You never add these yourself. |
| `- some line` under a method | Logic, in order. Intent, not literal code. |
| `* some line` | A **free line**: what should happen, and you design how. Under a unit, type or method, or at step level, where you also choose the files. |
| `Name.Method` inside a logic line | A call to another unit's method. |
| `@path` inside any line | A reference: read that file or folder for context. |
| `! some line` | A **check**: something that must hold once the step is built. Under a unit, type or method, or at step level for the step as a whole. You verify it before ticking; you never rewrite it. |
| `? question` | An open question. It blocks the step it sits in. |
| `- ~Name()`, `~@old.go`, `- ~line` | A removal: once the step is folded, the matching method, unit or logic line leaves the snapshot. A rename is a `~` of the old name plus the new one. Build it by deleting that code. |
| `// note` | A note from the user. Context only, never a task. |

Anything above the first `##` step (the title, `lang:`, notes) is context for every step. The same file can appear in several steps: each step says what that step changes in it.

Example:

```
# Vaultwave sync
lang: go

## [x] Watch folders
@internal/watcher/watcher.go
  - Start(dir string) -> error
    - walk dir and watch every folder
  - Stop()
    - close the fsnotify watcher

## Debounce changes
+internal/sync/debounce.go
  : Debouncer
    - wait: time.Duration
    - Push(path string)
      - collect paths until `wait` passes with no new ones
      - then call Uploader.Send(paths)
  ? should Push drop duplicate paths

@internal/watcher/watcher.go
  - Start(dir string) -> error
    - on change call Debouncer.Push(path)

// conflict handling is out of scope for now, see @docs/conflicts.md
```

## Implementing a step

"Implement the next step" means the first step from the top without `[x]`. The user can also name a step ("implement Debounce changes"), or a unit or method inside one; then do only that.

1. **Read first.** Read the whole `.llmd` file (done steps are context), every `@` unit file in the step, and every `@` reference before you write anything.
   - **Skim the other specs** in `.llmd/` for an overview of the rest of the project: only their `##` step titles and whether they're ticked, e.g. `grep -n '^## ' .llmd/*.llmd`. Open another spec in full only when it mentions a file this step touches; find those with a search for the step's paths, e.g. `grep -l 'internal/models/book.go' .llmd/*.llmd`. If one of its open steps plans different changes to the same file, raise it with your questions.
2. **Ask every blocking `?` in the step at once**, before writing code. Also ask about anything else you'd otherwise have to guess in a `-` line. Once the user answers, replace each `?` line with `// decided: <answer>` in the same place, so the step keeps its decisions.
3. **Go top-down, one unit at a time**, in the order the step lists them.
4. **Stay inside the step.** Only create its `+` files and only change its `@` unit files. If the work needs any other file changed, ask first. The exception is a `*` line at step level, with no unit above it: there you choose the files.
5. **Follow the logic lines in order.** They describe intent: fill in the obvious details (error handling, imports, the project's existing style and helpers) but don't add behaviour the step doesn't ask for. If a line is ambiguous, ask instead of guessing.
6. **Design the `*` lines yourself.** They say what, not how: choose the methods, names and logic, in the project's existing style. Decide instead of asking; ask only at a real fork, like two designs with different trade-offs. Don't stop for approval: build, then report.
7. **Match the signatures exactly** as written: names, arguments and return types.
8. **Once you've created a `+` file, change its unit line to `@`**, because the file exists now. Do this everywhere the file appears in the spec.
9. **Replace each `*` line with what you built**, as ordinary lines: `@` or `+` units, types, signatures and short logic, in the same place. Do it before ticking, so the snapshot holds structure, not prose. The user's wording stays in the archive.
10. **Make the step true before ticking.** Once folded, the spec must describe the code exactly as it is. Compare the step with `## [x] Current state`: for every line there that your code changed or removed, add a `~` line for it in the step (a changed logic line is a `~` of the old line plus the new one). A line with parentheses is read as a method, so write a record's or class's data as fields (`- Id: int`), not as `- record(Id, Name)`.
11. **Verify every `!` line in the step.** Write a test for it when the project has tests, otherwise check it by running the code or reading it closely. If a check fails and you can't make it pass within the step, don't tick: report which check fails and why.
12. **Tick the step** (`## Title` or `## [ ] Title` → `## [x] Title`) only when all of it is built and the code builds (and its tests and `!` checks pass). Don't add `[x]` to methods.
13. **Fold it into the snapshot.** Right after ticking, run `llmd snapshot <spec>`. It merges the step into `## [x] Current state`, removes it from the spec and appends it to `.llmd/archive/`. If `llmd` isn't installed, say so and leave the step ticked; don't fold by hand.
14. **Offer a commit.** In a git repo, once the step is folded, offer to commit it with the step's title as the commit message. Commit only if the user says yes.
15. **Never change the spec silently.** Besides ticking the step, `+` → `@`, `// decided:`, replacing `*` lines, adding `~` lines and `llmd snapshot`, propose spec edits to the user instead of making them. If the code you find contradicts the spec, stop and say so.
16. **Report back** with what you built, whether you ticked the step, each `!` check and how you verified it (which test, or what you ran), and any questions that are still open. For `*` lines, list the decisions you made and the files you chose, so the user can review the design along with the diff.

## Planning a step

"Plan the step" (or "plan the next step") means talk it through with the user before anything is built:

1. **Read first**, exactly as for implementing: the whole spec, the step's files and references, and the other specs' step titles.
2. **Discuss.** Raise everything at once: what's unclear or contradicts the code, what's missing (error cases, `!` checks the step should prove, files the step will have to touch), and what clashes with other specs. Answer the step's `?` lines with options, not just questions back.
3. **Propose concrete spec edits:** `?` lines, `!` checks, new or changed lines, `~` lines, or whole new steps. Make them only once the user agrees.
4. **Never write code** while planning. The step is built later, with "implement".

## Writing a spec from existing code

When asked to describe code "as llmd":

- Write one spec per feature to `.llmd/<feature>.llmd`, plus `.llmd/app.llmd` for the shared setup, unless the user names another place. Code with no clear features, like a small tool or a library, gets a single spec.
- Put each spec's code in one `## [x] Current state` step, so new work can follow as plain `##` steps. A shared file goes in each spec with only that feature's part.
- Write one `@path` unit per file, in the order a reader would follow the flow (entry point first).
- List types with `:`, plus fields and methods with their real signatures.
- Give each method one to three short logic lines that say what it does, not how. Use `Name.Method` for calls into other units.
- Turn anything unclear or suspicious into a `?` line rather than guessing.
- Leave out trivial getters, generated code and tests unless asked.
