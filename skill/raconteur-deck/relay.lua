--- Deck relay: the bridge between the deck (its server and the agent) and the user's Neovim.
--- It runs in a normal headless startup, so raconteur.nvim comes from the user's own Neovim
--- setup, and a deck fills code exactly as the user's plugin renders it:
---
---   nvim --headless -n -i NONE -S relay.lua < <request>
---
--- The request is one JSON object naming its `command`; the result is one JSON object on
--- stdout ({ ok = true, ... } or { ok = false, error = "<sentence for the user>" }), and Neovim
--- always exits, 0 when ok:
---
---   {"command": "fill", "worktree": ..., "path": <deck document>}
---   {"command": "goto", "server": ..., "worktree": ..., "file": ..., "line"?, "heading"?, "sha"?}
local M = {}

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

--- Connect to the Neovim at `server`, but only when its global current directory is inside
--- `worktree`, so a deck never opens files in a session working on another checkout.
--- @return integer|nil chan  open channel when verified
--- @return table|nil   failure  { ok = false, error } otherwise
local function connect_in_worktree(server, worktree)
  local chan = connect(server)
  if not chan then
    return nil, { ok = false, error = "Can't reach Neovim at " .. server .. ". Start it with nvim --listen " .. server .. "." }
  end
  local cwd = vim.rpcrequest(chan, "nvim_call_function", "getcwd", { -1, -1 })
  local code, toplevel = git(cwd, { "rev-parse", "--show-toplevel" })
  local expected = normalize(worktree)
  if code ~= 0 then
    vim.fn.chanclose(chan)
    return nil, { ok = false, error = "Neovim at " .. server .. " is in " .. cwd .. ", which is not a git worktree. This deck is for " .. expected .. "." }
  end
  toplevel = normalize(toplevel)
  if toplevel ~= expected then
    vim.fn.chanclose(chan)
    return nil, { ok = false, error = "Neovim at " .. server .. " is in worktree " .. toplevel .. ", but this deck is for " .. expected .. "." }
  end
  return chan
end

--- GitHub-style heading anchor: lowercase, drop every ASCII character that is not a letter,
--- digit, space, hyphen or underscore, then turn each space into a hyphen.
--- "## 2. Core Logic" -> "2-core-logic".
local function slug(text)
  return (text:lower():gsub("[^%w _%-\128-\255]", ""):gsub(" ", "-"))
end

--- Line of the heading whose anchor is `anchor`; as on GitHub, the nth repeat of a slug is
--- `<slug>-<n>`.
local function find_heading(abs_path, anchor)
  local seen, n = {}, 0
  for line in io.lines(abs_path) do
    n = n + 1
    local text = line:match("^#+%s+(.-)%s*$")
    if text then
      local base = slug(text)
      local id = seen[base] and base .. "-" .. seen[base] or base
      seen[base] = (seen[base] or 0) + 1
      if id == anchor then return n end
    end
  end
end

--- Open `file` in the Neovim at `server`, at `line` or at the heading whose anchor is `heading`.
--- With `sha`, the result says whether the file changed since the deck's copy was made at it.
--- @param request { server: string, worktree: string, file: string, line?: integer, heading?: string, sha?: string }
function M.goto(request)
  local root = normalize(request.worktree)
  local abs = root .. "/" .. request.file
  if vim.fn.filereadable(abs) ~= 1 then
    return { ok = false, error = request.file .. " does not exist in " .. root .. "." }
  end
  local line = request.line or 1
  if request.heading then
    line = find_heading(abs, request.heading)
    if not line then
      return { ok = false, error = request.file .. " has no heading matching #" .. request.heading .. "." }
    end
  end
  local chan, failure = connect_in_worktree(request.server, root)
  if not chan then return failure end
  vim.rpcrequest(chan, "nvim_exec_lua", [[
    local path, line = ...
    vim.cmd("tab drop " .. vim.fn.fnameescape(path))
    vim.api.nvim_win_set_cursor(0, { math.min(line, vim.api.nvim_buf_line_count(0)), 0 })
    vim.cmd("normal! zz")
  ]], { abs, line })
  vim.fn.chanclose(chan)
  local result = { ok = true, file = request.file, line = line }
  if request.sha then
    -- Exit 1 means the file differs between the copy's commit and the working tree.
    local code = git(root, { "diff", "--quiet", request.sha, "--", request.file })
    if code == 0 or code == 1 then result.changed_since_copy = code == 1 end
  end
  return result
end

--- Fill every dynamic block in the `body_md` of the deck document at `path` with the worktree's
--- current lines, stamped with the short HEAD. The document is rewritten whole (temp file and
--- rename) only when its body changed, so an unchanged document keeps its bytes.
--- @return table { ok, sha, changed } or { ok = false, error }
function M.fill(worktree, path)
  local root = normalize(worktree)
  local code, head = git(root, { "rev-parse", "--short", "HEAD" })
  if code ~= 0 then return { ok = false, error = root .. " is not a git worktree." } end
  if vim.fn.filereadable(path) ~= 1 then return { ok = false, error = "Can't read " .. path .. "." } end
  local parsed, doc = pcall(vim.json.decode, table.concat(vim.fn.readfile(path, "b"), "\n"))
  if not parsed or type(doc) ~= "table" or type(doc.body_md) ~= "string" then
    return { ok = false, error = path .. " is not a deck document with a body_md." }
  end
  local lines = vim.split(doc.body_md, "\n", { plain = true })
  local body = table.concat(require("raconteur.fill").fill_lines(lines, root, { sha = head }), "\n")
  if body == doc.body_md then return { ok = true, sha = head, changed = false } end
  doc.body_md = body
  local temp = path .. ".tmp"
  vim.fn.writefile({ vim.json.encode(doc) }, temp)
  local renamed, err = vim.uv.fs_rename(temp, path)
  if not renamed then return { ok = false, error = "Can't write " .. path .. ": " .. err } end
  return { ok = true, sha = head, changed = true }
end

--- Each command names the string fields its request must carry.
local COMMANDS = {
  fill = { required = { "worktree", "path" }, run = function(r) return M.fill(r.worktree, r.path) end },
  goto = { required = { "server", "worktree", "file" }, run = M.goto },
}

local USAGE = 'usage: one JSON request on stdin: {"command":"fill","worktree","path"} or '
  .. '{"command":"goto","server","worktree","file","line"?,"heading"?,"sha"?}'

local function run(stdin)
  -- A null optional field means the field is absent.
  local parsed, request = pcall(vim.json.decode, stdin, { luanil = { object = true } })
  local command = parsed and type(request) == "table" and COMMANDS[request.command]
  if not command then return { ok = false, error = USAGE } end
  for _, field in ipairs(command.required) do
    if type(request[field]) ~= "string" then return { ok = false, error = USAGE } end
  end
  if not pcall(require, "raconteur.fill") then
    return { ok = false, error = "raconteur.nvim is not installed in this Neovim setup." }
  end
  return command.run(request)
end

-- Any failure still prints a result and exits, so a headless Neovim never waits forever.
local ran, result = xpcall(run, debug.traceback, io.read("*a"))
if not ran then result = { ok = false, error = "The relay failed: " .. tostring(result) } end
io.stdout:write(vim.json.encode(result) .. "\n")
os.exit(result.ok and 0 or 1)
