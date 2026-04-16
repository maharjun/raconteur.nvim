--- Shared utilities: git root resolution, file I/O, path helpers.
local M = {}

-- Cache git roots keyed by directory path.  Avoids shelling out or walking
-- the filesystem on every render/refresh.
local git_root_cache = {}

--- Find the git repository root for the given buffer.
--- Uses vim.fs.root() which walks up from the buffer's directory.
--- Result is cached per-directory so repeated calls are free.
--- @param bufnr? integer  defaults to current buffer
--- @return string|nil
function M.git_root(bufnr)
  local path = vim.api.nvim_buf_get_name(bufnr or 0)
  if path == "" then return nil end
  local dir = vim.fn.fnamemodify(path, ":h")

  if git_root_cache[dir] ~= nil then
    -- Explicit nil sentinel stored as false to distinguish "not cached" from "no root".
    return git_root_cache[dir] or nil
  end

  local root = vim.fs.root(dir, ".git")
  git_root_cache[dir] = root or false
  return root
end

--- Parse a line-range string like "10-25" or "10".
--- @param range_str? string
--- @return integer|nil start_line  1-based
--- @return integer|nil end_line    1-based
function M.parse_line_range(range_str)
  if not range_str then return nil, nil end
  local s, e = range_str:match("^(%d+)%-(%d+)$")
  if s and e then return tonumber(s), tonumber(e) end
  local single = range_str:match("^(%d+)$")
  if single then
    local n = tonumber(single)
    return n, n
  end
  return nil, nil
end

--- Resolve a repo-relative path to an absolute path via the buffer's git root.
--- Returns nil if the git root can't be found or the file doesn't exist.
--- @param relative string  e.g. "src/auth.lua"
--- @param bufnr?  integer
--- @return string|nil
function M.resolve_path(relative, bufnr)
  local root = M.git_root(bufnr)
  if not root then return nil end
  local abs = root .. "/" .. relative
  if vim.fn.filereadable(abs) == 1 then return abs end
  return nil
end

--- Read lines from a file, optionally limited to a 1-based [start, end] range.
---
--- Performance: uses io.open + iterator so we never load the full file into
--- memory when a range is specified — we bail as soon as end_line is reached.
--- @param abs_path   string
--- @param start_line? integer  1-based, inclusive
--- @param end_line?   integer  1-based, inclusive
--- @return string[]|nil lines
--- @return string|nil   err
function M.read_file_lines(abs_path, start_line, end_line)
  local f = io.open(abs_path, "r")
  if not f then return nil, "file not found" end

  local lines = {}
  local n = 0
  local s = start_line or 1

  for line in f:lines() do
    n = n + 1
    if end_line and n > end_line then break end
    if n >= s then lines[#lines + 1] = line end
  end
  f:close()

  if #lines == 0 and start_line then
    return {}, "line range out of bounds"
  end
  return lines, nil
end

--- Prefixed vim.notify wrapper.
--- @param msg   string
--- @param level? integer  vim.log.levels.*
function M.notify(msg, level)
  vim.notify("[raconteur] " .. msg, level or vim.log.levels.INFO)
end

return M
