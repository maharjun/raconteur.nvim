-- Protocol: the deck relay CLI (skill/raconteur-deck/relay.lua).
--
-- Interface under test: the commands the deck server and the agent run, called exactly as they
-- call them (a child `nvim -l relay.lua` with one JSON request on stdin), against real headless
-- Neovim servers. Every case is one row in CASES:
--   { description, command, request (encoded as stdin with its command; `stdin` overrides it
--     with raw text), install = "unset" for a relay whose raconteur-path is missing,
--     expect = fields the JSON result must have, error = text the error must contain,
--     opened = "server:file:line" after,
--     card = deck document written to a fresh file whose path the runner puts in request.path,
--     after = body_md the file holds afterwards, or `false` for byte-for-byte unchanged }
-- Every case also checks the exit code: 0 for ok results, 1 otherwise.
--
-- Fixture: a repo `main` with a second worktree `other`, a plain directory `plain`, and one
-- headless Neovim server in each. The relay runs from an installed copy whose raconteur-path
-- names this checkout, as the agent sets it up.
--
-- Run: nvim --headless -u NONE -i NONE -n -l test/protocols/deck_relay.lua
local root = vim.fn.getcwd()
local dir = vim.fn.tempname()

--- Installed copies of the relay: `set` knows this checkout through raconteur-path, `unset` has
--- no raconteur-path yet.
local scripts = {}
for _, install in ipairs({ "set", "unset" }) do
  vim.fn.mkdir(dir .. "/" .. install, "p")
  scripts[install] = dir .. "/" .. install .. "/relay.lua"
  vim.fn.writefile(vim.fn.readfile(root .. "/skill/raconteur-deck/relay.lua"), scripts[install])
end
vim.fn.writefile({ root }, dir .. "/set/raconteur-path")

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
write(main .. "/guide.md", {
  "# Guide", "", "## 1. Entry Point", "", "## 2. Core Logic", "text", "## Notes", "## Notes",
})
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

local stale = table.concat({
  "Why one pass?", "",
  "```lua file=src.lua lines=2-3 sha=0000000", "stale copy", "```", "",
  "```lua", "-- plain block stays", "```",
}, "\n")
local filled = table.concat({
  "Why one pass?", "",
  "```lua file=src.lua lines=2-3 sha=" .. sha, "local b = 2", "local c = 3", "```", "",
  "```lua", "-- plain block stays", "```",
}, "\n")

local function go(fields)
  return vim.tbl_extend("keep", fields, { server = servers.main, worktree = main })
end

local CASES = {
  -- goto: open a file at a line or heading, only in a server inside the deck's worktree.
  { "goto: file at a line", "goto", go({ file = "src.lua", line = 3 }),
    expect = { ok = true, file = "src.lua", line = 3 }, opened = "main:src.lua:3" },
  { "goto: no line opens line 1", "goto", go({ file = "src.lua" }),
    expect = { ok = true, line = 1 }, opened = "main:src.lua:1" },
  { "goto: null optional fields are absent", "goto", go({ file = "src.lua", line = vim.NIL, heading = vim.NIL }),
    expect = { ok = true, line = 1 } },
  { "goto: walkthrough heading by slug", "goto", go({ file = "guide.md", heading = "2-core-logic" }),
    expect = { ok = true, line = 5 }, opened = "main:guide.md:5" },
  { "goto: repeated heading by its numbered slug", "goto", go({ file = "guide.md", heading = "notes-1" }),
    expect = { ok = true, line = 8 } },
  { "goto: heading text is not a slug", "goto", go({ file = "guide.md", heading = "2. Core Logic" }),
    error = "has no heading matching #2. Core Logic" },
  { "goto: missing heading", "goto", go({ file = "guide.md", heading = "9-nothing" }),
    error = "has no heading matching #9-nothing" },
  { "goto: missing file", "goto", go({ file = "gone.lua", line = 1 }),
    error = "gone.lua does not exist" },
  { "goto: server in another worktree of the same repo opens nothing", "goto",
    go({ server = servers.other, file = "src.lua", line = 2 }),
    error = "is in worktree " .. other .. ", but this deck is for " .. main, opened = "other::1" },
  { "goto: server outside any git worktree", "goto", go({ server = servers.plain, file = "src.lua" }),
    error = "which is not a git worktree" },
  { "goto: no server at the address", "goto", go({ server = dir .. "/none.sock", file = "src.lua" }),
    error = "Can't reach Neovim" },
  { "goto: copy still matches the file", "goto", go({ file = "src.lua", sha = sha }),
    expect = { ok = true, changed_since_copy = false } },
  { "goto: file edited since the copy", "goto", go({ file = "edited.lua", sha = sha }),
    expect = { ok = true, changed_since_copy = true } },

  -- fill: refresh every dynamic block in a deck document's body_md, in place.
  { "fill: replaces the old copy and stamps HEAD", "fill", { worktree = main },
    card = { title = "One pass", body_md = stale },
    expect = { ok = true, sha = sha, changed = true }, after = filled },
  { "fill: an up-to-date document is left byte-for-byte", "fill", { worktree = main },
    card = { title = "One pass", body_md = filled },
    expect = { ok = true, sha = sha, changed = false }, after = false },
  { "fill: directory outside git", "fill", { worktree = plain },
    card = { title = "One pass", body_md = stale },
    error = "is not a git worktree", after = false },
  { "fill: missing document", "fill", { worktree = main, path = dir .. "/cards/none.json" },
    error = "Can't read" },
  { "fill: document without a body_md", "fill", { worktree = main },
    card = { title = "One pass" },
    error = "is not a deck document with a body_md", after = false },

  -- The request itself.
  { "unknown command", "verify", { server = servers.main, worktree = main },
    error = "usage:" },
  { "request missing a required field", "goto", { server = servers.main, file = "src.lua" },
    error = "usage:" },
  { "stdin is not JSON", "fill", nil, stdin = "worktree=" .. main,
    error = "usage:" },
  { "relay without raconteur-path", "fill", { worktree = main }, install = "unset",
    card = { title = "One pass", body_md = stale },
    error = "raconteur-path is missing", after = false },
}

-- Indented JSON, unlike vim.json.encode, so a rewrite of an unchanged document would show.
local function pretty(doc)
  local fields = {}
  for _, key in ipairs(vim.fn.sort(vim.tbl_keys(doc))) do
    fields[#fields + 1] = "  " .. vim.json.encode(key) .. ": " .. vim.json.encode(doc[key])
  end
  return "{\n" .. table.concat(fields, ",\n") .. "\n}\n"
end

local failed = 0
for index, case in ipairs(CASES) do
  local request, card_path, card_text = vim.tbl_extend("force", case[3] or {}, { command = case[2] }), nil, nil
  if case.card then
    card_path = ("%s/cards/card-%d.json"):format(dir, index)
    card_text = pretty(case.card)
    vim.fn.mkdir(dir .. "/cards", "p")
    vim.fn.writefile(vim.split(card_text, "\n", { plain = true }), card_path, "b")
    request = vim.tbl_extend("force", request, { path = card_path })
  end
  local stdin = case.stdin or vim.json.encode(request)
  local r = vim.system({ "nvim", "-l", scripts[case.install or "set"] }, { stdin = stdin, text = true }):wait()
  local ok, result = pcall(vim.json.decode, r.stdout)
  local problems = {}
  if not ok then
    problems[#problems + 1] = "output is not JSON: " .. r.stdout .. r.stderr
  else
    if r.code ~= (result.ok and 0 or 1) then
      problems[#problems + 1] = "exit code " .. r.code .. " for ok = " .. tostring(result.ok)
    end
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
    if card_path then
      local now = table.concat(vim.fn.readfile(card_path, "b"), "\n")
      if case.after == false then
        if now ~= card_text then problems[#problems + 1] = "document was rewritten: " .. now end
      else
        local doc = vim.json.decode(now)
        if doc.body_md ~= case.after then
          problems[#problems + 1] = "body_md = " .. vim.inspect(doc.body_md) .. ", expected " .. vim.inspect(case.after)
        end
        if doc.title ~= case.card.title then problems[#problems + 1] = "title = " .. vim.inspect(doc.title) end
      end
      if vim.uv.fs_stat(card_path .. ".tmp") then problems[#problems + 1] = "temp file left behind" end
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
