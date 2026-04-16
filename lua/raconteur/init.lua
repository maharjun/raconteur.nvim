--- raconteur.nvim — PR walkthrough documents for Neovim.
---
--- Public API:
---   require("raconteur").setup(opts)   — initialise with user config
---   require("raconteur").render()      — render code references in buffer
---   require("raconteur").clear()       — remove rendered content
---   require("raconteur").refresh()     — re-read source files and re-render
---   require("raconteur").toggle()      — switch view / edit mode
---   require("raconteur").goto_source() — jump to source file in previous tab
local M = {}

local config    = require("raconteur.config")
local parser    = require("raconteur.parser")
local renderer  = require("raconteur.renderer")
local navigator = require("raconteur.navigator")
local utils     = require("raconteur.utils")

--- Per-buffer state.
--- @type table<integer, { rendered: boolean, blocks: table[]|nil }>
M.state = {}

-- ── Setup ────────────────────────────────────────────────────────────

--- Initialise the plugin.  Call this from your Neovim config:
---   require("raconteur").setup({})
---
--- @param opts? table  see config.lua for available options
function M.setup(opts)
  config.setup(opts)

  if config.get().auto_render then
    vim.api.nvim_create_autocmd("FileType", {
      group    = vim.api.nvim_create_augroup("raconteur", { clear = true }),
      pattern  = "markdown",
      callback = function(ev)
        -- Defer so the buffer is fully loaded and treesitter can attach
        -- for syntax highlighting of the injected code.
        vim.schedule(function()
          M.attach(ev.buf)
        end)
      end,
    })
  end
end

-- ── Buffer attach / detach ───────────────────────────────────────────

--- Attach to a markdown buffer: parse, render, and set keymaps.
--- Called automatically on FileType if auto_render is enabled, or manually
--- via :RaconteurRender.
---
--- @param bufnr? integer
function M.attach(bufnr)
  bufnr = bufnr or vim.api.nvim_get_current_buf()
  if M.state[bufnr] and M.state[bufnr].rendered then return end

  local blocks = parser.parse(bufnr)
  if #blocks == 0 then return end

  vim.bo[bufnr].modifiable = true
  local block_states = renderer.render_all(bufnr, blocks)
  vim.bo[bufnr].modifiable = false

  M.state[bufnr] = { rendered = true, blocks = block_states }
  M._set_keymaps(bufnr)

  -- Clean up when the buffer is wiped out.
  vim.api.nvim_create_autocmd("BufWipeout", {
    buffer   = bufnr,
    once     = true,
    callback = function() M.state[bufnr] = nil end,
  })
end

-- ── Public commands ──────────────────────────────────────────────────

--- Render all code references in the current buffer.
--- @param bufnr? integer
function M.render(bufnr)
  bufnr = bufnr or vim.api.nvim_get_current_buf()

  if M.state[bufnr] and M.state[bufnr].rendered then
    M.clear(bufnr)
  end

  local blocks = parser.parse(bufnr)
  if #blocks == 0 then
    utils.notify("No code references found")
    return
  end

  vim.bo[bufnr].modifiable = true
  local block_states = renderer.render_all(bufnr, blocks)
  vim.bo[bufnr].modifiable = false

  M.state[bufnr] = { rendered = true, blocks = block_states }
  M._set_keymaps(bufnr)
end

--- Remove all rendered content, restoring the original empty fence bodies.
--- @param bufnr? integer
function M.clear(bufnr)
  bufnr = bufnr or vim.api.nvim_get_current_buf()
  local st = M.state[bufnr]
  if not st or not st.rendered then return end

  vim.bo[bufnr].modifiable = true
  renderer.clear_all(bufnr, st.blocks)

  M.state[bufnr] = { rendered = false, blocks = nil }
  M._clear_keymaps(bufnr)
end

--- Re-read source files and re-render.
--- @param bufnr? integer
function M.refresh(bufnr)
  bufnr = bufnr or vim.api.nvim_get_current_buf()
  M.clear(bufnr)
  M.render(bufnr)
end

--- Toggle between rendered (read-only) view and editable mode.
--- @param bufnr? integer
function M.toggle(bufnr)
  bufnr = bufnr or vim.api.nvim_get_current_buf()
  local st = M.state[bufnr]
  if st and st.rendered then
    M.clear(bufnr)
  else
    M.render(bufnr)
  end
end

--- Jump to the source file for the code block under the cursor.
--- @param bufnr? integer
function M.goto_source(bufnr)
  bufnr = bufnr or vim.api.nvim_get_current_buf()
  local st = M.state[bufnr]
  if not st or not st.rendered then
    utils.notify("Buffer not rendered", vim.log.levels.WARN)
    return
  end
  navigator.goto_source(bufnr, st.blocks, renderer.namespace())
end

-- ── Keymaps (buffer-local, view mode only) ───────────────────────────

--- @param bufnr integer
function M._set_keymaps(bufnr)
  local km  = config.get().keymaps
  local set = function(lhs, fn, desc)
    vim.keymap.set("n", lhs, fn, { buffer = bufnr, silent = true, desc = desc })
  end
  set(km.goto_source, function() M.goto_source(bufnr) end, "Raconteur: go to source")
  set(km.refresh,     function() M.refresh(bufnr)     end, "Raconteur: refresh")
  set(km.toggle_edit, function() M.toggle(bufnr)      end, "Raconteur: toggle edit")
end

--- @param bufnr integer
function M._clear_keymaps(bufnr)
  local km = config.get().keymaps
  for _, lhs in ipairs({ km.goto_source, km.refresh, km.toggle_edit }) do
    pcall(vim.keymap.del, "n", lhs, { buffer = bufnr })
  end
end

return M
