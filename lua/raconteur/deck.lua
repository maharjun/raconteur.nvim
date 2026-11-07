--- Deck relay: the agent's bridge between a deck artifact and the user's
--- Neovim session.  Every function returns a plain table that the CLI
--- (scripts/deck.lua) prints as JSON: { ok = true, ... } or
--- { ok = false, error = "<sentence for the user>" }.
local M = {}

local fill = require("raconteur.fill")
local parser = require("raconteur.parser")

local function normalize(path)
  return (vim.fn.resolve(vim.fn.fnamemodify(path, ":p")):gsub("/$", ""))
end

local function git(dir, args)
  local result = vim.system(vim.list_extend({ "git", "-C", dir }, args), { text = true }):wait()
  return result.code, vim.trim(result.stdout or "")
end

local function connect(server)
  local mode = server:match("^[%w%.%-]+:%d+$") and "tcp" or "pipe"
  local ok, chan = pcall(vim.fn.sockconnect, mode, server, { rpc = true })
  if not ok or chan == 0 then return nil end
  return chan
end

--- GitHub-style heading anchor: "## 2. Core Logic" -> "2-core-logic".
local function slug(text)
  return (text:lower():gsub("[^%w%s%-]", ""):gsub("%s+", "-"))
end

local function find_heading(abs_path, heading)
  local n = 0
  for line in io.lines(abs_path) do
    n = n + 1
    local text = line:match("^#+%s+(.-)%s*$")
    if text and (slug(text) == heading or text == heading) then return n end
  end
end

--- Check that the nvim server's global current directory is inside the
--- deck's worktree.  The channel is returned open for the caller to use.
function M.verify(server, worktree)
  local chan = connect(server)
  if not chan then
    return { ok = false, error = "Can't reach Neovim at " .. server .. ". Start it with nvim --listen " .. server .. "." }
  end
  local cwd = vim.rpcrequest(chan, "nvim_call_function", "getcwd", { -1, -1 })
  local code, toplevel = git(cwd, { "rev-parse", "--show-toplevel" })
  local expected = normalize(worktree)
  if code ~= 0 then
    vim.fn.chanclose(chan)
    return { ok = false, error = "Neovim at " .. server .. " is in " .. cwd .. ", which is not a git worktree. This deck is for " .. expected .. "." }
  end
  toplevel = normalize(toplevel)
  if toplevel ~= expected then
    vim.fn.chanclose(chan)
    return { ok = false, error = "Neovim at " .. server .. " is in worktree " .. toplevel .. ", but this deck is for " .. expected .. "." }
  end
  return { ok = true, worktree = toplevel, cwd = cwd }, chan
end

--- Open <file> in the nvim server at a line, or at a markdown heading.
--- @param target { file: string, line?: integer, heading?: string, sha?: string }
function M.goto(server, worktree, target)
  local abs = normalize(worktree) .. "/" .. target.file
  if vim.fn.filereadable(abs) ~= 1 then
    return { ok = false, error = target.file .. " does not exist in " .. normalize(worktree) .. "." }
  end
  local line = target.line or 1
  if target.heading then
    line = find_heading(abs, target.heading)
    if not line then
      return { ok = false, error = target.file .. " has no heading matching #" .. target.heading .. "." }
    end
  end
  local verified, chan = M.verify(server, worktree)
  if not verified.ok then return verified end
  vim.rpcrequest(chan, "nvim_exec_lua", [[
    local path, line = ...
    vim.cmd("tab drop " .. vim.fn.fnameescape(path))
    vim.api.nvim_win_set_cursor(0, { math.min(line, vim.api.nvim_buf_line_count(0)), 0 })
    vim.cmd("normal! zz")
  ]], { abs, line })
  vim.fn.chanclose(chan)
  local result = { ok = true, file = target.file, line = line }
  if target.sha then
    -- Exit 1 means the file differs between the copy's commit and the working tree.
    local code = git(normalize(worktree), { "diff", "--quiet", target.sha, "--", target.file })
    if code == 0 or code == 1 then result.changed_since_copy = code == 1 end
  end
  return result
end

--- Fill every dynamic block in a card body with the worktree's current lines
--- and stamp it with sha=<HEAD>.
function M.fill(worktree, markdown)
  local root = normalize(worktree)
  local code, head = git(root, { "rev-parse", "--short", "HEAD" })
  if code ~= 0 then return { ok = false, error = root .. " is not a git worktree." } end
  local lines = vim.split(markdown, "\n", { plain = true })
  for _, block in ipairs(parser.parse_lines(lines)) do
    local info = block.fence_info:gsub("%s+sha=%S+", "") .. " sha=" .. head
    lines[block.fence_open_line + 1] = block.fence_indent .. block.fence_ticks .. info
  end
  return { ok = true, sha = head, markdown = table.concat(fill.fill_lines(lines, root), "\n") }
end

return M
