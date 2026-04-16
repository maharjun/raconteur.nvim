--- Markdown code-fence parser.
---
--- Scans a buffer for fenced code blocks whose info-string contains a
--- `file=<path>` attribute and optional `lines=<start>-<end>` range.
---
--- Complexity: single linear pass over buffer lines, O(n).
--- No treesitter dependency — the opening-fence regex is unambiguous in
--- Markdown and treesitter's info_string node would still need regex to
--- extract key=value pairs.  Treesitter *does* give us free syntax
--- highlighting inside fences, but that works automatically once the
--- content is placed between the backtick delimiters.
local M = {}

local utils = require("raconteur.utils")

--- Extract lang, file path, and line range from a fence info string.
--- Example: "lua file=src/auth.lua lines=10-25"
---   -> "lua", "src/auth.lua", 10, 25
--- @param info string
--- @return string|nil lang
--- @return string|nil file
--- @return integer|nil lines_start  1-based
--- @return integer|nil lines_end    1-based
local function parse_info_string(info)
  local lang = info:match("^(%S+)")
  local file = info:match("file=(%S+)")
  local lines_str = info:match("lines=(%S+)")
  local lines_start, lines_end = utils.parse_line_range(lines_str)
  return lang, file, lines_start, lines_end
end

--- Parse all raconteur code blocks from a list of lines.
---
--- Returns a list of block descriptors ordered top-to-bottom.  Line numbers
--- are **0-indexed** to match the nvim_buf_* API convention.
---
--- @param lines string[]  buffer or file lines
--- @return table[]  blocks  list of block descriptors
function M.parse_lines(lines)
  local blocks = {}
  local i = 1

  while i <= #lines do
    local line = lines[i]
    -- Match opening fence: optional leading whitespace, 3+ backticks, info string.
    -- The info string must be non-empty (at minimum "file=..." is required).
    local indent, ticks, info = line:match("^(%s*)(```+)(.+)$")

    if indent and info and info:match("file=") then
      local lang, file, lines_start, lines_end = parse_info_string(vim.trim(info))

      if file then
        -- Build the pattern for the matching closing fence: same indent,
        -- same number (or more) backticks, nothing else on the line.
        local close_pat = "^" .. indent .. string.rep("`", #ticks) .. "+%s*$"
        local body_start = i + 1
        local j = body_start

        while j <= #lines do
          if lines[j]:match(close_pat) then
            -- Collect the original body (may be empty or contain a fallback snapshot).
            local original_body = {}
            for k = body_start, j - 1 do
              original_body[#original_body + 1] = lines[k]
            end

            blocks[#blocks + 1] = {
              fence_open_line  = i - 1, -- 0-indexed
              fence_close_line = j - 1, -- 0-indexed
              lang             = lang,
              file             = file,
              lines_start      = lines_start,
              lines_end        = lines_end,
              original_body    = original_body,
            }
            i = j -- advance past the closing fence
            break
          end
          j = j + 1
        end
      end
    end
    i = i + 1
  end

  return blocks
end

--- Parse all raconteur code blocks in a buffer.
--- Convenience wrapper around parse_lines().
--- @param bufnr? integer  defaults to current buffer
--- @return table[]  blocks
function M.parse(bufnr)
  bufnr = bufnr or vim.api.nvim_get_current_buf()
  local lines = vim.api.nvim_buf_get_lines(bufnr, 0, -1, false)
  return M.parse_lines(lines)
end

return M
