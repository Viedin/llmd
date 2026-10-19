---
name: llmd
description: Read, write and implement .llmd files, a markdown-based spec format where the user describes work as steps (## headings) of files, types, methods and logic, top-down, and the agent implements one step at a time. Use whenever a .llmd file is mentioned, opened or referenced with @, when asked to implement a spec or "the next step", or when asked to describe existing code "as llmd".
---

# LLMD

An `.llmd` file is a spec the user writes so they can steer the architecture without writing the code. It reads top-down, the way code flows. The work is split into **steps**, like issues: each `##` heading is one. Your job is to turn a step into code exactly as described, and to ask when it doesn't say enough.

## Where specs live

Specs live in a `.llmd/` folder at the project root, e.g. `.llmd/flow.llmd`. When the user doesn't name a spec, look there: if there's one, use it; if there are several, ask which one. New specs go there too, unless the user says otherwise. `@` paths in a spec always start from the project root (the folder holding `.llmd/`), not from `.llmd/`.

## Syntax

Indent with 2 spaces. Each level belongs to the line above it.

| Line | Meaning |
|---|---|
| `# Title` | The spec's title. |
| `lang: go` | Stack for the whole file, at the top. Write idiomatic code for it. |
| `## Title` | A **step**: one piece of work, like an issue. Everything down to the next `##` belongs to it. `## [ ] Title` means the same. |
| `## [x] Title` | A done step. Context for later steps; don't redo it. |
| `### Heading` | A subsection inside a step. Part of that step. |
| `@path/to/file.go` | A unit: an **existing** file. Children describe what it has or should get. |
| `+path/to/file.go` | A unit: a **new** file to create. A unit can also be a folder or package, e.g. `+cmd/internal/models`. |
| `: Name` or `- : Name` | A type, class or struct inside the unit above. Optional when the file has only one. |
| `- name: Type` | A field (no parentheses). |
| `- Name(args) -> Return` | A method or function (has parentheses). `-> Return` is optional. |
| `- [x] Name(...)` | The user marked this method done. Treat it as built. You never add these yourself. |
| `- some line` under a method | Logic, in order. Intent, not literal code. |
| `Name.Method` inside a logic line | A call to another unit's method. |
| `@path` inside any line | A reference: read that file or folder for context. |
| `? question` | An open question. It blocks the step it sits in. |
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
2. **Ask every blocking `?` in the step at once**, before writing code. Also ask about anything else you'd otherwise have to guess. Once the user answers, replace each `?` line with `// decided: <answer>` in the same place, so the step keeps its decisions.
3. **Go top-down, one unit at a time**, in the order the step lists them.
4. **Stay inside the step.** Only create its `+` files and only change its `@` unit files. If the work needs any other file changed, ask first.
5. **Follow the logic lines in order.** They describe intent: fill in the obvious details (error handling, imports, the project's existing style and helpers) but don't add behaviour the step doesn't ask for. If a line is ambiguous, ask instead of guessing.
6. **Match the signatures exactly** as written: names, arguments and return types.
7. **Once you've created a `+` file, change its unit line to `@`**, because the file exists now. Do this everywhere the file appears in the spec.
8. **Tick the step** (`## Title` or `## [ ] Title` → `## [x] Title`) only when all of it is built and the code builds (and its tests pass, if there are any). Don't add `[x]` to methods.
9. **Offer a commit.** In a git repo, once the step is ticked, offer to commit it with the step's title as the commit message. Commit only if the user says yes.
10. **Never change the spec silently.** Besides ticking the step, `+` → `@` and `// decided:`, propose spec edits to the user instead of making them. If the code you find contradicts the spec, stop and say so.
11. **Report back** with what you built, whether you ticked the step, and any questions that are still open.

## Writing a spec from existing code

When asked to describe code "as llmd":

- Write it to `.llmd/<name>.llmd` unless the user names another place.
- Put it all in one `## [x] Existing code` step, so new work can follow as plain `##` steps.
- Write one `@path` unit per file, in the order a reader would follow the flow (entry point first).
- List types with `:`, plus fields and methods with their real signatures.
- Give each method one to three short logic lines that say what it does, not how. Use `Name.Method` for calls into other units.
- Turn anything unclear or suspicious into a `?` line rather than guessing.
- Leave out trivial getters, generated code and tests unless asked.
