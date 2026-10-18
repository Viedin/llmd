---
name: llmd
description: Read, write and implement .llmd files, a markdown-based spec format where the user describes files, types, methods and logic top-down and Claude implements it. Use whenever a .llmd file is mentioned, opened or referenced with @, when asked to implement or update a spec, or when asked to describe existing code "as llmd".
---

# LLMD

An `.llmd` file is a spec the user writes so they can steer the architecture without writing the code. It reads top-down, the way code flows. Your job is to turn it into code exactly as described, and to ask when it doesn't say enough.

## Syntax

Indent with 2 spaces. Each level belongs to the line above it.

| Line | Meaning |
|---|---|
| `# Heading` | Markdown heading. Groups the units below it. Any markdown prose is context. |
| `lang: go` | Stack for the whole file, at the top. Write idiomatic code for it. |
| `@path/to/file.go` | A unit: an **existing** file. Children describe what it has or should get. |
| `+path/to/file.go` | A unit: a **new** file to create. |
| `: Name` | A type, class or struct inside the file above. Optional when the file has only one. |
| `- name: Type` | A field (no parentheses). |
| `- Name(args) -> Return` | A method or function (has parentheses). `-> Return` is optional. |
| `- [x] Name(...)` | A method that is implemented. `- [ ] Name(...)` or no box means not done. |
| `- some step` under a method | Logic, in order. Intent, not literal code. |
| `Name.Method` inside a logic line | A call to another unit's method. |
| `@path` inside any line | A reference: read that file or folder for context. |
| `? question` | An open question. It blocks the unit it sits in (or the whole file at top level). |
| `// note` | A note from the user. Context only, never a task. |

Example:

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

## Implementing a spec

1. **Read first.** Read the whole `.llmd` file, every `@` unit file, and every `@` reference before you write anything.
2. **Ask every blocking `?` at once**, before writing code, for the part you've been asked to implement. Once the user answers, replace the line with `// decided: <answer>` so the spec stays the source of truth.
3. **Go top-down, one unit at a time**, in file order. If the user names a unit or method ("implement the Debouncer"), do only that.
4. **Stay inside the spec.** Only create `+` files and only change `@` unit files. If the work needs any other file changed, ask first.
5. **Follow the logic steps in order.** They describe intent: fill in the obvious details (error handling, imports, the project's existing style and helpers) but don't add behaviour the spec doesn't ask for. If a step is ambiguous, ask instead of guessing.
6. **Match the signatures exactly** as written: names, arguments and return types.
7. **Tick `[x]`** on a method only once it is implemented and builds (and its tests pass, if there are any). Once you've created a `+` file, change its unit line to `@`, because the file exists now.
8. **Never change the spec silently.** Besides `[x]` and `// decided:`, propose spec edits to the user instead of making them. If the code you find contradicts the spec, stop and say so.
9. **Report back** with what you implemented, what you ticked, and any questions that are still open.

## Writing a spec from existing code

When asked to describe code "as llmd":

- Write one `@path` unit per file, in the order a reader would follow the flow (entry point first).
- List types with `:`, plus fields and methods with their real signatures. Mark existing methods `[x]`.
- Give each method one to three short logic steps that say what it does, not how. Use `Name.Method` for calls into other units.
- Turn anything unclear or suspicious into a `?` line rather than guessing.
- Leave out trivial getters, generated code and tests unless asked.
