--- DiffView integration: context-aware diff opening from raconteur blocks.
---
--- When the cursor is on a raconteur code block, `<leader>gd` / `<leader>gm`
--- open DiffView scoped to that block's file and scroll to the referenced
--- lines.  When the cursor is outside any block, the commands fall through
--- to their normal unscoped behaviour.
local M = {}

--- User-settable diff target, e.g. "origin/main...HEAD" or "HEAD~3".
--- Used by the <leader>gt keymap.  nil means unset.
--- @type string|nil
M.diff_target = nil

local parser    = require("raconteur.parser")
local navigator = require("raconteur.navigator")
local renderer  = require("raconteur.renderer")
local utils     = require("raconteur.utils")

--- Get the file path and line range for the block under the cursor.
--- Works in both rendered and unrendered mode.
--- @param bufnr integer
--- @param state table|nil  per-buffer raconteur state
--- @return string|nil file   repo-relative path
--- @return integer|nil lines_start  1-based
--- @return integer|nil lines_end    1-based
local function block_under_cursor(bufnr, state)
  if state and state.rendered and state.blocks then
    local bs, _ = navigator.find_block_at_cursor(bufnr, state.blocks, renderer.namespace())
    if bs then
      return bs.file, bs.lines_start, bs.lines_end
    end
  else
    local blocks = parser.parse(bufnr)
    if not blocks or #blocks == 0 then return nil end
    local cursor_line = vim.api.nvim_win_get_cursor(0)[1] - 1
    for _, block in ipairs(blocks) do
      if cursor_line >= block.fence_open_line and cursor_line <= block.fence_close_line then
        return block.file, block.lines_start, block.lines_end
      end
    end
  end
  return nil
end

--- After DiffView opens, find the buffer for our target file and jump
--- to the referenced line range.  We listen for the diff_buf_read event
--- via a one-shot User autocmd.
--- @param file       string  repo-relative path
--- @param line_start integer|nil  1-based
local function jump_after_open(file, line_start)
  if not line_start then return end

  -- DiffView fires User DiffviewDiffBufRead when a diff buffer is loaded.
  -- We set a one-shot autocmd that checks whether the loaded buffer matches
  -- our target file, then scrolls to the line.
  local fired = false
  local augroup = vim.api.nvim_create_augroup("raconteur_dv_jump", { clear = true })

  vim.api.nvim_create_autocmd("User", {
    group    = augroup,
    pattern  = "DiffviewDiffBufRead",
    callback = function()
      if fired then return end
      -- Check all windows in the current tab for our file
      vim.schedule(function()
        for _, win in ipairs(vim.api.nvim_tabpage_list_wins(0)) do
          local buf = vim.api.nvim_win_get_buf(win)
          local name = vim.api.nvim_buf_get_name(buf)
          if name:find(file, 1, true) then
            vim.api.nvim_set_current_win(win)
            local line_count = vim.api.nvim_buf_line_count(buf)
            local target = math.min(line_start, line_count)
            vim.api.nvim_win_set_cursor(win, { target, 0 })
            vim.cmd("normal! zz")
            fired = true
            vim.api.nvim_del_augroup_by_id(augroup)
            return
          end
        end
      end)
    end,
  })

  -- Safety: clean up the autocmd after a few seconds if it never fires
  vim.defer_fn(function()
    pcall(vim.api.nvim_del_augroup_by_id, augroup)
  end, 5000)
end

--- Open DiffView scoped to the block under the cursor, or fall through
--- to the unscoped command if the cursor isn't on a block.
--- @param bufnr    integer
--- @param state    table|nil  per-buffer raconteur state
--- @param rev_args string     e.g. "" for working tree or "origin/main...HEAD"
--- @param fallback string     vim command to run when not on a block
function M.open_diff(bufnr, state, rev_args, fallback)
  local file, lines_start, _ = block_under_cursor(bufnr, state)

  if not file then
    vim.cmd(fallback)
    return
  end

  local cmd = "DiffviewOpen"
  if rev_args ~= "" then
    cmd = cmd .. " " .. rev_args
  end
  cmd = cmd .. " -- " .. file

  jump_after_open(file, lines_start)
  vim.cmd(cmd)
end

return M
