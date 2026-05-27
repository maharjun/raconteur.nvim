--- Rendering engine: fills fenced code blocks with source file content
--- and manages the extmarks that track rendered regions.
---
--- Key design choices
--- ──────────────────
--- • Blocks are rendered **bottom-to-top** so that inserting lines in one
---   block does not shift the line numbers of blocks above it.
--- • Undo history is suppressed during render/clear by temporarily setting
---   `undolevels = -1`, so the user's undo tree stays clean.
--- • The entire buffer is set to `nomodifiable` after rendering.  A toggle
---   command (in init.lua) switches back to edit mode by clearing all
---   rendered content first.
--- • Each rendered region is tracked by a pair of extmarks (open/close)
---   in the "raconteur" namespace.  These survive cursor movement and
---   (if the user toggles to edit mode) line insertions elsewhere in the
---   buffer, because extmarks have right-gravity by default.
local M = {}

local utils  = require("raconteur.utils")
local config = require("raconteur.config")

local ns_id = vim.api.nvim_create_namespace("raconteur")

--- Render a single block by replacing the fence body with source content.
---
--- IMPORTANT: call blocks bottom-to-top so line offsets stay valid.
---
--- The outer fence is grown if the source contains a pure-backtick line
--- long enough to close it.  CommonMark does not honour backslash escapes
--- inside fenced code blocks, so a longer fence is the only way to keep
--- inner triple-backticks from terminating the wrapping block.
---
--- @param bufnr integer
--- @param block table   block descriptor from parser.parse()
--- @return table|nil    block_state for later clear/navigation, or nil on skip
function M.render_block(bufnr, block)
  local cfg = config.get()
  local abs_path = utils.resolve_path(block.file, bufnr)
  local content_lines, err

  if not abs_path then
    err = "file not found: " .. block.file
    if cfg.on_error == "ignore" then return nil end
    if cfg.on_error == "notify" then
      utils.notify(err, vim.log.levels.ERROR)
      return nil
    end
    content_lines = { "-- [raconteur] " .. err }
  else
    content_lines, err = utils.read_file_lines(abs_path, block.lines_start, block.lines_end)
    if not content_lines then
      local msg = err or "read error"
      if cfg.on_error == "ignore" then return nil end
      if cfg.on_error == "notify" then
        utils.notify(msg, vim.log.levels.ERROR)
        return nil
      end
      content_lines = { "-- [raconteur] " .. msg }
    elseif #content_lines == 0 then
      content_lines = { "-- [raconteur] empty range" }
    end
  end

  -- Grow the outer fence to one tick longer than the longest pure-backtick
  -- line in the source; the existing fence stays as-is when the source has
  -- no such line.
  local needed_ticks = math.max(
    #block.fence_ticks,
    utils.max_fence_backtick_run(content_lines) + 1
  )
  local fence_ticks = string.rep("`", needed_ticks)
  local new_open  = block.fence_indent .. fence_ticks .. block.fence_info
  local new_close = block.fence_indent .. fence_ticks

  -- Replace the entire fence region (open line + body + close line).
  local replacement = { new_open }
  for _, l in ipairs(content_lines) do
    replacement[#replacement + 1] = l
  end
  replacement[#replacement + 1] = new_close

  vim.api.nvim_buf_set_lines(
    bufnr, block.fence_open_line, block.fence_close_line + 1, false, replacement
  )

  local new_close_line = block.fence_open_line + 1 + #content_lines

  local open_extmark = vim.api.nvim_buf_set_extmark(
    bufnr, ns_id, block.fence_open_line, 0, {}
  )
  local close_extmark = vim.api.nvim_buf_set_extmark(
    bufnr, ns_id, new_close_line, 0, {}
  )

  -- Optional: source-path virtual text on the opening fence line.
  if cfg.show_source_path then
    local label = block.file
    if block.lines_start then
      label = label .. ":" .. block.lines_start
      if block.lines_end and block.lines_end ~= block.lines_start then
        label = label .. "-" .. block.lines_end
      end
    end
    vim.api.nvim_buf_set_extmark(bufnr, ns_id, block.fence_open_line, 0, {
      virt_text     = { { "  " .. label, "Comment" } },
      virt_text_pos = "eol",
    })
  end

  return {
    file                = block.file,
    lang                = block.lang,
    lines_start         = block.lines_start,
    lines_end           = block.lines_end,
    original_body       = block.original_body,
    fence_open_text     = block.fence_indent .. block.fence_ticks .. block.fence_info,
    fence_close_text    = block.fence_close_text,
    open_extmark        = open_extmark,
    close_extmark       = close_extmark,
    rendered_line_count = #content_lines,
    error               = err,
  }
end

--- Render all parsed blocks.  Iterates **bottom-to-top** to keep line
--- offsets stable across insertions.
---
--- @param bufnr  integer
--- @param blocks table[]  block descriptors from parser.parse()
--- @return table[]        rendered block states (same indices as input)
function M.render_all(bufnr, blocks)
  local saved = vim.bo[bufnr].undolevels
  vim.bo[bufnr].undolevels = -1

  local states = {}
  for i = #blocks, 1, -1 do
    local st = M.render_block(bufnr, blocks[i])
    if st then states[i] = st end
  end

  vim.bo[bufnr].undolevels = saved
  return states
end

--- Clear all rendered content, restoring original fence bodies.
--- Also iterates bottom-to-top (by extmark position) so offsets stay valid.
---
--- @param bufnr        integer
--- @param block_states table[]
function M.clear_all(bufnr, block_states)
  if not block_states then return end

  local saved = vim.bo[bufnr].undolevels
  vim.bo[bufnr].undolevels = -1

  -- Walk bottom-to-top so earlier regions aren't shifted by later restores.
  for i = #block_states, 1, -1 do
    local bs = block_states[i]
    if bs then
      local open_pos  = vim.api.nvim_buf_get_extmark_by_id(bufnr, ns_id, bs.open_extmark, {})
      local close_pos = vim.api.nvim_buf_get_extmark_by_id(bufnr, ns_id, bs.close_extmark, {})

      if open_pos[1] and close_pos[1] then
        -- Restore the full fence region; render may have grown the fence.
        local restore = { bs.fence_open_text }
        for _, l in ipairs(bs.original_body) do
          restore[#restore + 1] = l
        end
        restore[#restore + 1] = bs.fence_close_text
        vim.api.nvim_buf_set_lines(bufnr, open_pos[1], close_pos[1] + 1, false, restore)
      end
    end
  end

  vim.api.nvim_buf_clear_namespace(bufnr, ns_id, 0, -1)
  vim.bo[bufnr].undolevels = saved
end

--- Expose the namespace id for other modules (navigator uses it to query
--- extmark positions).
--- @return integer
function M.namespace()
  return ns_id
end

return M
