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
local diffview  = require("raconteur.diffview")
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

--- Attach to a markdown buffer: check for code references and set up the
--- toggle keymap.  Does NOT auto-render — the buffer opens in edit mode
--- and the user toggles into view mode when ready.
---
--- @param bufnr? integer
function M.attach(bufnr)
  bufnr = bufnr or vim.api.nvim_get_current_buf()
  if M.state[bufnr] then return end

  -- Quick check: does this buffer have any raconteur code blocks?
  local blocks = parser.parse(bufnr)
  if #blocks == 0 then return end

  M.state[bufnr] = { rendered = false, blocks = nil }

  local km = config.get().keymaps
  vim.keymap.set("n", km.toggle_edit, function() M.toggle(bufnr) end,
    { buffer = bufnr, silent = true, desc = "Raconteur: toggle edit" })
  vim.keymap.set("n", km.goto_source, function() M.goto_source(bufnr) end,
    { buffer = bufnr, silent = true, desc = "Raconteur: go to source" })
  vim.keymap.set("n", km.diff_open, function()
    diffview.open_diff(bufnr, M.state[bufnr], "", "DiffviewOpen")
  end, { buffer = bufnr, silent = true, desc = "Raconteur: diff (working tree)" })
  vim.keymap.set("n", km.diff_main, function()
    diffview.open_diff(bufnr, M.state[bufnr], "origin/main...HEAD", "DiffviewOpen origin/main...HEAD")
  end, { buffer = bufnr, silent = true, desc = "Raconteur: diff against main" })
  vim.keymap.set("n", km.diff_target, function()
    if not diffview.diff_target then
      utils.notify("No diff target set. Use :RaconteurDiffTarget <rev> to set one.", vim.log.levels.WARN)
      return
    end
    diffview.open_diff(bufnr, M.state[bufnr], diffview.diff_target, "DiffviewOpen " .. diffview.diff_target)
  end, { buffer = bufnr, silent = true, desc = "Raconteur: diff with custom target" })

  -- Strip rendered content before writing so only the original markdown
  -- (with empty fence bodies) hits disk.  Re-render afterwards.
  local augroup = vim.api.nvim_create_augroup("raconteur_buf_" .. bufnr, { clear = true })

  vim.api.nvim_create_autocmd("BufWritePre", {
    group    = augroup,
    buffer   = bufnr,
    callback = function()
      local st = M.state[bufnr]
      if st and st.rendered then
        vim.bo[bufnr].modifiable = true
        renderer.clear_all(bufnr, st.blocks)
        st._pre_write = true
      end
    end,
  })

  vim.api.nvim_create_autocmd("BufWritePost", {
    group    = augroup,
    buffer   = bufnr,
    callback = function()
      local st = M.state[bufnr]
      if st and st._pre_write then
        st._pre_write = nil
        local blocks = parser.parse(bufnr)
        if #blocks > 0 then
          st.blocks = renderer.render_all(bufnr, blocks)
          st.rendered = true
          vim.bo[bufnr].modifiable = false
          vim.bo[bufnr].modified = false
        end
      end
    end,
  })

  -- Clean up when the buffer is wiped out.
  vim.api.nvim_create_autocmd("BufWipeout", {
    group    = augroup,
    buffer   = bufnr,
    once     = true,
    callback = function()
      M.state[bufnr] = nil
      vim.api.nvim_del_augroup_by_id(augroup)
    end,
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

  -- Render, then restore the modified flag and lock the buffer.
  -- Inserting content is a display concern, not a real edit.
  local was_modified = vim.bo[bufnr].modified
  vim.bo[bufnr].modifiable = true
  local block_states = renderer.render_all(bufnr, blocks)
  vim.bo[bufnr].modifiable = false
  vim.bo[bufnr].modified = was_modified

  M.state[bufnr] = { rendered = true, blocks = block_states }
  M._set_keymaps(bufnr)
end

--- Remove all rendered content, restoring the original empty fence bodies.
--- @param bufnr? integer
function M.clear(bufnr)
  bufnr = bufnr or vim.api.nvim_get_current_buf()
  local st = M.state[bufnr]
  if not st or not st.rendered then return end

  -- Restore content, then restore the modified flag.
  local was_modified = vim.bo[bufnr].modified
  vim.bo[bufnr].modifiable = true
  renderer.clear_all(bufnr, st.blocks)
  vim.bo[bufnr].modified = was_modified

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
--- Works in both view mode (uses extmarks) and edit mode (re-parses).
--- @param bufnr? integer
function M.goto_source(bufnr)
  bufnr = bufnr or vim.api.nvim_get_current_buf()
  local st = M.state[bufnr]

  if st and st.rendered then
    navigator.goto_source_rendered(bufnr, st.blocks, renderer.namespace())
  else
    local blocks = parser.parse(bufnr)
    navigator.goto_source_parsed(bufnr, blocks)
  end
end

-- ── Keymaps ──────────────────────────────────────────────────────────

--- Set view-mode keymaps (refresh).  Cross-mode keymaps are set in attach().
--- @param bufnr integer
function M._set_keymaps(bufnr)
  local km = config.get().keymaps
  vim.keymap.set("n", km.refresh, function() M.refresh(bufnr) end,
    { buffer = bufnr, silent = true, desc = "Raconteur: refresh" })
end

--- Remove view-mode keymaps.  Cross-mode keymaps persist.
--- @param bufnr integer
function M._clear_keymaps(bufnr)
  local km = config.get().keymaps
  pcall(vim.keymap.del, "n", km.refresh, { buffer = bufnr })
end

return M
