-- Protocol: the deck relay CLI (scripts/deck.lua).
--
-- Interface under test: the three commands the agent runs, called exactly as
-- the agent calls them (a child `nvim -l` process), against real headless
-- Neovim servers. Every case is one row in CASES:
--   { description, argv, stdin?, expect = fields the JSON result must have,
--     error = text the error must contain, opened = "server:file:line" after }
--
-- Fixture: a repo `main` with a second worktree `other`, a plain directory
-- `plain`, and one headless Neovim server in each.
--
-- Run: nvim --headless -u NONE -i NONE -n -l test/protocols/deck_relay.lua
local root = vim.fn.getcwd()
local script = root .. "/scripts/deck.lua"
local dir = vim.fn.tempname()

local function sh(cwd, cmd)
  local r = vim.system(cmd, { cwd = cwd, text = true }):wait()
  assert(r.code == 0, table.concat(cmd, " ") .. ": " .. (r.stderr or ""))
  return vim.trim(r.stdout)
end

local function write(path, lines)
  vim.fn.mkdir(vim.fn.fnamemodify(path, ":h"), "p")
  vim.fn.writefile(lines, path)
end

local main, other, plain = dir .. "/main", dir .. "/other", dir .. "/plain"
write(main .. "/src.lua", { "local a = 1", "local b = 2", "local c = 3", "return a + b + c" })
write(main .. "/edited.lua", { "return 1" })
write(main .. "/guide.md", { "# Guide", "", "## 1. Entry Point", "", "## 2. Core Logic", "text" })
vim.fn.mkdir(plain, "p")
sh(main, { "git", "init", "-q" })
sh(main, { "git", "add", "." })
sh(main, { "git", "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "fixture" })
sh(main, { "git", "worktree", "add", "-q", other })
local sha = sh(main, { "git", "rev-parse", "--short", "HEAD" })
write(main .. "/edited.lua", { "return 2" })

local servers = {}
for name, cwd in pairs({ main = main, other = other, plain = plain }) do
  servers[name] = dir .. "/" .. name .. ".sock"
  vim.fn.jobstart({ "nvim", "--headless", "-u", "NONE", "-i", "NONE", "-n", "--listen", servers[name] }, { cwd = cwd })
end
for _, sock in pairs(servers) do
  assert(vim.wait(5000, function() return vim.uv.fs_stat(sock) ~= nil end), "server did not start: " .. sock)
end

local function where(name)
  local chan = vim.fn.sockconnect("pipe", servers[name], { rpc = true })
  local at = vim.rpcrequest(chan, "nvim_exec_lua",
    [[return vim.fn.expand("%:t") .. ":" .. vim.fn.line(".")]], {})
  vim.fn.chanclose(chan)
  return name .. ":" .. at
end

local card = table.concat({
  "Why one pass?", "",
  "```lua file=src.lua lines=2-3 sha=0000000", "stale copy", "```", "",
  "```lua", "-- plain block stays", "```",
}, "\n")

local CASES = {
  -- verify: is the server's global current directory inside the deck's worktree?
  { "verify: server in the deck's worktree", { "verify", servers.main, main },
    expect = { ok = true, worktree = main } },
  { "verify: server in another worktree of the same repo", { "verify", servers.other, main },
    error = "is in worktree " .. other .. ", but this deck is for " .. main },
  { "verify: server outside any git worktree", { "verify", servers.plain, main },
    error = "which is not a git worktree" },
  { "verify: no server at the address", { "verify", dir .. "/none.sock", main },
    error = "Can't reach Neovim" },

  -- goto: open a file at a line or heading in the user's server.
  { "goto: file at a line", { "goto", servers.main, main, "src.lua", "3" },
    expect = { ok = true, line = 3 }, opened = "main:src.lua:3" },
  { "goto: walkthrough heading by anchor", { "goto", servers.main, main, "guide.md", "#2-core-logic" },
    expect = { ok = true, line = 5 }, opened = "main:guide.md:5" },
  { "goto: missing heading", { "goto", servers.main, main, "guide.md", "#9-nothing" },
    error = "has no heading matching #9-nothing" },
  { "goto: missing file", { "goto", servers.main, main, "gone.lua", "1" },
    error = "gone.lua does not exist" },
  { "goto: server in the wrong worktree opens nothing", { "goto", servers.other, main, "src.lua", "2" },
    error = "but this deck is for", opened = "other::1" },
  { "goto: copy still matches the file", { "goto", servers.main, main, "src.lua", "1", sha },
    expect = { ok = true, changed_since_copy = false } },
  { "goto: file edited since the copy", { "goto", servers.main, main, "edited.lua", "1", sha },
    expect = { ok = true, changed_since_copy = true } },

  -- fill: refresh every dynamic block in a card body.
  { "fill: replaces the old copy and stamps HEAD", { "fill", main }, stdin = card,
    expect = { ok = true, sha = sha, markdown = table.concat({
      "Why one pass?", "",
      "```lua file=src.lua lines=2-3 sha=" .. sha, "local b = 2", "local c = 3", "```", "",
      "```lua", "-- plain block stays", "```",
    }, "\n") } },
  { "fill: directory outside git", { "fill", plain }, stdin = card,
    error = "is not a git worktree" },
}

local failed = 0
for _, case in ipairs(CASES) do
  local argv = vim.list_extend({ "nvim", "-l", script }, case[2])
  local r = vim.system(argv, { stdin = case.stdin or "", text = true }):wait()
  local ok, result = pcall(vim.json.decode, r.stdout)
  local problems = {}
  if not ok then
    problems[#problems + 1] = "output is not JSON: " .. r.stdout .. r.stderr
  else
    for key, value in pairs(case.expect or {}) do
      if result[key] ~= value then
        problems[#problems + 1] = key .. " = " .. vim.inspect(result[key]) .. ", expected " .. vim.inspect(value)
      end
    end
    if case.error and not (result.error or ""):find(case.error, 1, true) then
      problems[#problems + 1] = "error " .. vim.inspect(result.error) .. " lacks " .. vim.inspect(case.error)
    end
    if case.opened and where(case.opened:match("^(%w+)")) ~= case.opened then
      problems[#problems + 1] = "server shows " .. where(case.opened:match("^(%w+)")) .. ", expected " .. case.opened
    end
  end
  if #problems == 0 then
    print("ok   " .. case[1])
  else
    failed = failed + 1
    print("FAIL " .. case[1] .. "\n     " .. table.concat(problems, "\n     "))
  end
end

for _, sock in pairs(servers) do
  pcall(function()
    local chan = vim.fn.sockconnect("pipe", sock, { rpc = true })
    vim.rpcnotify(chan, "nvim_command", "qa!")
  end)
end
print(("%d/%d passed"):format(#CASES - failed, #CASES))
os.exit(failed == 0 and 0 or 1)
