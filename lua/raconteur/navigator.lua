--- Tab-based navigation: jump from a rendered code block to the source file.
---
--- Behaviour mirrors DiffView's `gf`:
---   1. Determine which rendered block the cursor sits in.
---   2. Compute the corresponding line in the source file.
---   3. Switch to the previous tab page (the "alternate" tab, tracked by
---      Neovim's `tabpagenr("#")`).  If no other tab exists, open a new one.
---   4. If the file is already visible in that tab, focus its window;
---      otherwise `:edit` it.
---   5. Place the cursor on the target line and centre the view.
local M = {}

local utils = require("raconteur.utils")

--- Find the rendered block under the cursor.
---
--- Matches if the cursor is on the opening fence, inside the rendered body,
--- or on the closing fence.  Returns the block state and the 0-based offset
--- of the cursor within the rendered content (useful for computing the
--- target line in the source file).
---
--- @param bufnr        integer
--- @param block_states table[]
--- @param ns_id        integer  extmark namespace
--- @return table|nil   block_state
--- @return integer     offset into rendered content (0-based)
function M.find_block_at_cursor(bufnr, block_states, ns_id)
  if not block_states then return nil, 0 end

  local cursor_line = vim.api.nvim_win_get_cursor(0)[1] - 1 -- 0-indexed

  for _, bs in ipairs(block_states) do
    if bs then
      local open_pos  = vim.api.nvim_buf_get_extmark_by_id(bufnr, ns_id, bs.open_extmark, {})
      local close_pos = vim.api.nvim_buf_get_extmark_by_id(bufnr, ns_id, bs.close_extmark, {})

      if open_pos[1] and close_pos[1]
        and cursor_line >= open_pos[1]
        and cursor_line <= close_pos[1]
      then
        local offset = cursor_line - (open_pos[1] + 1) -- offset into body
        return bs, math.max(0, offset)
      end
    end
  end

  return nil, 0
end

--- Open a file in the previous tab (or a new tab) at the given line.
--- Shared by both rendered and parsed navigation paths.
--- @param abs_path    string
--- @param target_line integer  1-based
local function open_in_tab(abs_path, target_line)
  local cur_tab = vim.api.nvim_get_current_tabpage()
  local tabs    = vim.api.nvim_list_tabpages()

  if #tabs > 1 then
    local prev_tabnr = vim.fn.tabpagenr("#")
    if prev_tabnr > 0 and prev_tabnr ~= vim.fn.tabpagenr() then
      vim.cmd(prev_tabnr .. "tabnext")
    else
      for _, tab_id in ipairs(tabs) do
        if tab_id ~= cur_tab then
          vim.api.nvim_set_current_tabpage(tab_id)
          break
        end
      end
    end

    local target_bufnr = vim.fn.bufnr(abs_path)
    if target_bufnr ~= -1 then
      for _, win in ipairs(vim.api.nvim_tabpage_list_wins(0)) do
        if vim.api.nvim_win_get_buf(win) == target_bufnr then
          vim.api.nvim_set_current_win(win)
          vim.api.nvim_win_set_cursor(win, { target_line, 0 })
          vim.cmd("normal! zz")
          return
        end
      end
    end

    vim.cmd("edit " .. vim.fn.fnameescape(abs_path))
  else
    vim.cmd("tabnew " .. vim.fn.fnameescape(abs_path))
  end

  vim.api.nvim_win_set_cursor(0, { target_line, 0 })
  vim.cmd("normal! zz")
end

--- Navigate from a rendered (view mode) buffer using extmark positions.
--- @param bufnr        integer
--- @param block_states table[]
--- @param ns_id        integer
function M.goto_source_rendered(bufnr, block_states, ns_id)
  local bs, offset = M.find_block_at_cursor(bufnr, block_states, ns_id)
  if not bs then
    utils.notify("No source reference under cursor", vim.log.levels.WARN)
    return
  end

  local abs_path = utils.resolve_path(bs.file, bufnr)
  if not abs_path then
    utils.notify("File not found: " .. bs.file, vim.log.levels.ERROR)
    return
  end

  open_in_tab(abs_path, (bs.lines_start or 1) + offset)
end

--- Navigate from an unrendered (edit mode) buffer using parsed block positions.
--- The cursor just needs to be on or between the fence lines.
--- @param bufnr  integer
--- @param blocks table[]  block descriptors from parser.parse()
function M.goto_source_parsed(bufnr, blocks)
  if not blocks or #blocks == 0 then
    utils.notify("No source reference under cursor", vim.log.levels.WARN)
    return
  end

  local cursor_line = vim.api.nvim_win_get_cursor(0)[1] - 1 -- 0-indexed

  for _, block in ipairs(blocks) do
    if cursor_line >= block.fence_open_line and cursor_line <= block.fence_close_line then
      local abs_path = utils.resolve_path(block.file, bufnr)
      if not abs_path then
        utils.notify("File not found: " .. block.file, vim.log.levels.ERROR)
        return
      end
      open_in_tab(abs_path, block.lines_start or 1)
      return
    end
  end

  utils.notify("No source reference under cursor", vim.log.levels.WARN)
end

return M
