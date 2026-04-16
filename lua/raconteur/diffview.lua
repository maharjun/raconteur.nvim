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

--- Try to find the rightmost window showing our file and jump to the
--- target line.  DiffView lays out windows left-to-right: file panel →
--- old version → new version.  We want the new (right) side.
--- @param file       string   repo-relative path (plain substring match)
--- @param line_start integer  1-based
--- @return boolean  true if the window was found and focused
local function try_focus_file(file, line_start)
  local target_win, target_buf
  for _, win in ipairs(vim.api.nvim_tabpage_list_wins(0)) do
    local buf = vim.api.nvim_win_get_buf(win)
    local name = vim.api.nvim_buf_get_name(buf)
    if name:find(file, 1, true) then
      target_win = win
      target_buf = buf
    end
  end
  if not target_win then return false end

  vim.api.nvim_set_current_win(target_win)
  local line_count = vim.api.nvim_buf_line_count(target_buf)
  local target = math.min(line_start, line_count)
  vim.api.nvim_win_set_cursor(target_win, { target, 0 })
  vim.cmd("normal! zz")
  return true
end

--- After DiffView opens, poll until the diff buffers are ready, then
--- focus the right panel at the target line.  DiffView loads buffers
--- asynchronously so we retry a few times with increasing delays.
--- @param file       string  repo-relative path
--- @param line_start integer|nil  1-based
local function jump_after_open(file, line_start)
  if not line_start then return end

  local attempts = 0
  local max_attempts = 4
  local delays = { 50, 150, 300, 500 }

  local function try()
    attempts = attempts + 1
    if try_focus_file(file, line_start) then return end
    if attempts < max_attempts then
      vim.defer_fn(try, delays[attempts + 1])
    end
  end

  vim.defer_fn(try, delays[1])
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

  vim.cmd(cmd)
  vim.cmd("DiffviewToggleFiles")
  jump_after_open(file, lines_start)
end

return M
