--- Markdown code-fence parser: the one owner of the raconteur fence grammar.
---
--- An opening fence is 3+ backticks followed by an info string of whitespace-separated tokens:
---
---   [lang] file=<path> [lines=<a>-<b> | lines=<a>] [sha=<hex>]
---
--- The first token is `lang` unless it contains `=`. Every token containing `=` is an
--- attribute `key=value`, so a key matches only at a whitespace boundary (`myfile=x` is not
--- `file=`); a repeated key keeps its first value. A fence is a raconteur fence only when
--- `file=` has a value; a `lines=` or `sha=` not in its form is ignored. `sha` is the
--- lowercase-hex commit the body was copied from. Shared cases: test/fixtures/fence_info.json.
---
--- A linear pass over the lines without treesitter, since the info string needs splitting into
--- attributes either way.
local M = {}

local utils = require("raconteur.utils")

--- Split a fence info string into its parts; `file` is nil when it is not a raconteur fence.
--- Example: "lua file=src/auth.lua lines=10-25 sha=3c72705" -> "lua", "src/auth.lua", 10, 25, "3c72705"
--- @param info string
--- @return string|nil lang
--- @return string|nil file
--- @return integer|nil lines_start  1-based
--- @return integer|nil lines_end    1-based
--- @return string|nil sha
local function parse_info_string(info)
  local lang, attrs = nil, {}
  for index, token in ipairs(vim.split(vim.trim(info), "%s+")) do
    local key, value = token:match("^([^=]*)=(.*)$")
    if key then
      attrs[key] = attrs[key] or value
    elseif index == 1 and token ~= "" then
      lang = token
    end
  end
  local file = attrs.file ~= "" and attrs.file or nil
  local lines_start, lines_end = utils.parse_line_range(attrs.lines)
  local sha = attrs.sha and attrs.sha:match("^[0-9a-f]+$")
  return lang, file, lines_start, lines_end, sha
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
    -- Opening fence: optional leading whitespace, 3+ backticks, info string.
    local indent, ticks, info = lines[i]:match("^(%s*)(```+)(.+)$")
    local lang, file, lines_start, lines_end, sha
    if info then lang, file, lines_start, lines_end, sha = parse_info_string(info) end

    if file then
      -- Closing fence: same indent, at least as many backticks, nothing else on the line.
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
            fence_indent     = indent,
            fence_ticks      = ticks,    -- original opening backtick run
            fence_info       = info,     -- everything after the open ticks
            fence_close_text = lines[j], -- exact original closing line
            lang             = lang,
            file             = file,
            lines_start      = lines_start,
            lines_end        = lines_end,
            sha              = sha,
            original_body    = original_body,
          }
          i = j -- advance past the closing fence
          break
        end
        j = j + 1
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
