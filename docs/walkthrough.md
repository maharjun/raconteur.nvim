# raconteur.nvim — Architecture Walkthrough

This document walks through the plugin's internals using raconteur's own
code-reference syntax.  Open it in Neovim with the plugin installed to see
the referenced code rendered inline and to navigate with `gf`.

## 1. Entry Point

Everything starts in `plugin/raconteur.lua`.  It registers the four user
commands and sets a load guard so the file is only sourced once:

```lua file=plugin/raconteur.lua
```

The commands are thin wrappers — all logic lives in `lua/raconteur/init.lua`.

## 2. Setup and Auto-attach

When you call `require("raconteur").setup({})`, the plugin merges your
config and creates a `FileType markdown` autocmd that triggers `attach()`:

```lua file=lua/raconteur/init.lua lines=28-44
```

`attach()` is where the real work starts.  It parses the buffer, renders
every block, locks the buffer, and sets up keymaps:

```lua file=lua/raconteur/init.lua lines=53-73
```

## 3. Parsing

The parser does a single O(n) pass over the buffer lines.  It matches
opening fences with a `file=` attribute, extracts the metadata, then
scans forward for the matching closing fence:

```lua file=lua/raconteur/parser.lua lines=24-30
```

The main loop builds up block descriptors with 0-indexed line numbers
(matching the `nvim_buf_*` API convention):

```lua file=lua/raconteur/parser.lua lines=39-89
```

## 4. Rendering

The renderer is the most involved module.  `render_block()` resolves the
file path, reads the source lines, and replaces the fence body using
`nvim_buf_set_lines`.  It also places extmarks to track the region and
optional virtual text showing the source path:

```lua file=lua/raconteur/renderer.lua lines=31-103
```

Blocks are rendered bottom-to-top so that line insertions in one block
don't shift the positions of blocks above it.  Undo history is suppressed
during the operation to keep the user's undo tree clean:

```lua file=lua/raconteur/renderer.lua lines=111-123
```

Clearing is the inverse — it walks the extmarks bottom-to-top and restores
the original (empty) fence bodies:

```lua file=lua/raconteur/renderer.lua lines=130-153
```

## 5. Navigation

When you press `gf` on a rendered block, the navigator figures out which
block you're in and computes the target line in the source file:

```lua file=lua/raconteur/navigator.lua lines=27-48
```

It then switches to the previous tab page (or creates a new one), reuses
an existing window if the file is already open, and centres the view:

```lua file=lua/raconteur/navigator.lua lines=55-112
```

## 6. Utilities

The utils module provides git-root caching (so repeated renders don't hit
the filesystem), an early-exit file reader that bails at `end_line`, and
path resolution:

```lua file=lua/raconteur/utils.lua lines=13-26
```

The file reader uses `io.open` with a line iterator instead of
`vim.fn.readfile` so that large files with small line ranges don't load
the entire file into memory:

```lua file=lua/raconteur/utils.lua lines=66-85
```

## 7. Configuration

All defaults live in `config.lua`.  Users override them via `setup()`:

```lua file=lua/raconteur/config.lua lines=4-24
```
