# Testing DiffView Integration

This directory contains a fixture file and a walkthrough doc for testing
raconteur's DiffView integration (`<leader>gd`, `<leader>gm`, `<leader>gt`).

## Setup

The test fixture `test/fixtures/greet.lua` was committed in two steps:

1. **Baseline** — `1c1a742` — original `greet` module with `greet()` and `greet_world()`
2. **Enhancement** — `eea3586` — adds `M.template`, optional template param, and `greet_many()`

`test/walkthrough.md` is a raconteur walkthrough that references the
changed sections of the enhanced file.

## How to test

1. Open the walkthrough in Neovim:

   ```
   nvim test/walkthrough.md
   ```

2. Set the diff target to the baseline commit:

   ```
   :RaconteurDiffTarget 1c1a742...HEAD
   ```

3. Place your cursor on any code block (e.g. the "Updated greet()
   Signature" section).

4. Press `<leader>gt` — DiffView should open showing only
   `test/fixtures/greet.lua`, with the diff between the baseline and
   HEAD. The cursor should land on the referenced line range.

5. You can also test without a target:
   - `<leader>gd` — working tree diff (only shows changes if you have
     uncommitted edits to `greet.lua`)
   - `<leader>gm` — diff against `origin/main` (requires a remote; use
     `<leader>gt` with a commit range if there's no remote)

6. Move your cursor off any code block and press `<leader>gt` — it
   should fall through to an unscoped `DiffviewOpen 1c1a742...HEAD`
   showing all files changed in that range.

7. Press `<leader>gf` on a code block — this still opens the source file in
   the previous tab (unchanged behaviour).
