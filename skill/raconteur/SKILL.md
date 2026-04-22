---
name: raconteur
description: Analyse a PR and create walkthrough markdown documents using raconteur.nvim code-reference syntax
argument-hint: "[PR number or URL]"
---

# Raconteur PR Walkthrough

Create markdown walkthrough documents for PR $ARGUMENTS using raconteur.nvim syntax.

## Code block format

~~~markdown
```<lang> file=<path> lines=<start>-<end>
```
~~~

- `file=` — path relative to repo root (required)
- `lines=` — 1-based inclusive range (optional; omit for whole file)
- Body between fences must be empty — the plugin fills it at render time

## Tools available

- `gh` — fetch PR metadata, diff, and file lists (`gh pr view`, `gh pr diff`)
- `git` — inspect history, branches, blame (`git log`, `git diff`, `git show`)
- Read tool — read source files with 1-indexed line numbers
- Write tool — create walkthrough markdown files
- Agent tool — spawn sub-agents for the review pass

## Output location

Write all walkthrough files to `PRWalkthrough/` in the repo root. Create the directory if it doesn't exist.

## Analysing the PR

1. Read the PR description and diff to understand intent
2. Identify the key changes — new modules, modified functions, wiring
3. Group changes by idea or theme. If a PR touches several distinct concerns (e.g. a new feature, a refactor, and a config change), create a separate walkthrough file for each
4. Within each file, order sections to tell a story: motivation, core logic, integration, configuration
5. Each section should reference one coherent unit of change (a function, a config block, a wiring point) — not an entire file unless it's small and new
6. Prefer small focused ranges over large blocks. A 10-line function is better than a 60-line file

## Writing the prose

- Each section: 1-3 sentences of context, then one code block
- Explain *why* the code exists, not *what* it does line-by-line — the reader can see the code
- Connect sections: explain how the piece you just showed feeds into the next one
- Use section headings as a table of contents (`## 1. Entry Point`, `## 2. Core Logic`, etc.)
- Keep it short. A walkthrough for a typical PR is 5-10 sections

## Review pass

After creating the walkthrough files, spawn a sub-agent to review them. The sub-agent should read each walkthrough and the source files it references, then report:

- Sections that are unclear or missing context
- Ranges that are too large or cut mid-statement
- Ordering that doesn't flow logically
- Prose that restates the code instead of explaining intent

Incorporate the feedback, then finalise.

## Line numbers

When you read a file with the Read tool, line numbers are shown at the start of each line (1-indexed). Use those directly in `lines=` attributes. No calculation needed.

If a range boundary falls mid-function, extend it to include the full function signature or closing `end`/`}`.
