--- Fill engine: resolves code references in markdown lines and replaces
--- fence bodies with actual source content.
---
--- Used by the Neovim renderer (via buffer lines) and the standalone
--- fill script (via file I/O).  No buffer or extmark dependencies.
local M = {}

local parser = require("raconteur.parser")
local utils  = require("raconteur.utils")

--- Fill all raconteur code blocks in a list of markdown lines.
---
--- Iterates blocks bottom-to-top (same as the renderer) so that line
--- insertions don't shift earlier blocks.
---
--- @param lines    string[]  markdown content
--- @param root_dir string    git/project root for resolving file= paths
--- @return string[]          filled lines (new table, input is not mutated)
--- @return table[]           block descriptors (with updated line numbers)
function M.fill_lines(lines, root_dir)
  local out = {}
  for _, l in ipairs(lines) do out[#out + 1] = l end

  local blocks = parser.parse_lines(out)

  -- Bottom-to-top so insertions don't shift earlier blocks.
  for i = #blocks, 1, -1 do
    local block = blocks[i]
    local abs_path = root_dir .. "/" .. block.file

    local content_lines, err
    if vim.fn.filereadable(abs_path) == 1 then
      content_lines, err = utils.read_file_lines(abs_path, block.lines_start, block.lines_end)
    else
      err = "file not found: " .. block.file
    end

    if not content_lines or #content_lines == 0 then
      content_lines = { "-- [raconteur] " .. (err or "empty range") }
    end

    -- Replace body between fences (0-indexed block lines → 1-indexed table).
    local body_start = block.fence_open_line + 2  -- table index after opening fence
    local body_end   = block.fence_close_line      -- table index before closing fence
    local new_out = {}
    for j = 1, block.fence_open_line + 1 do
      new_out[#new_out + 1] = out[j]
    end
    for _, cl in ipairs(content_lines) do
      new_out[#new_out + 1] = cl
    end
    for j = block.fence_close_line + 1, #out do
      new_out[#new_out + 1] = out[j]
    end
    out = new_out
  end

  return out, blocks
end

--- Fill a markdown file on disk.  Reads the file, fills it, writes it back.
--- @param filepath string  absolute path to the markdown file
--- @param root_dir string  project root for resolving file= paths
--- @return boolean ok
--- @return string|nil err
function M.fill_file(filepath, root_dir)
  local f = io.open(filepath, "r")
  if not f then return false, "cannot open: " .. filepath end

  local lines = {}
  for line in f:lines() do
    lines[#lines + 1] = line
  end
  f:close()

  local filled = M.fill_lines(lines, root_dir)

  f = io.open(filepath, "w")
  if not f then return false, "cannot write: " .. filepath end
  for _, line in ipairs(filled) do
    f:write(line .. "\n")
  end
  f:close()

  return true, nil
end

return M
