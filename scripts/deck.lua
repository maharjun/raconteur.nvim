#!/usr/bin/env -S nvim -l
--- Deck relay CLI: one JSON request on stdin, one JSON result on stdout, exit 0 when ok.
---
---   nvim -l scripts/deck.lua fill < {"worktree": ..., "path": <deck document>}
---   nvim -l scripts/deck.lua goto < {"server": ..., "worktree": ..., "file": ..., "line"?: ..., "heading"?: ..., "sha"?: ...}
local script_dir = debug.getinfo(1, "S").source:match("@?(.*/)")
package.path = script_dir .. "../lua/?.lua;" .. script_dir .. "../lua/?/init.lua;" .. package.path

local deck = require("raconteur.deck")

--- Each command names the string fields its request must carry.
local COMMANDS = {
  fill = { required = { "worktree", "path" }, run = function(r) return deck.fill(r.worktree, r.path) end },
  goto = { required = { "server", "worktree", "file" }, run = deck.goto },
}

local USAGE = 'usage: nvim -l scripts/deck.lua fill|goto, with one JSON request on stdin: '
  .. 'fill {"worktree","path"}; goto {"server","worktree","file","line"?,"heading"?,"sha"?}'

local function run(name, stdin)
  local command = COMMANDS[name]
  -- A null optional field means the field is absent.
  local parsed, request = pcall(vim.json.decode, stdin, { luanil = { object = true } })
  if not command or not parsed or type(request) ~= "table" then return { ok = false, error = USAGE } end
  for _, field in ipairs(command.required) do
    if type(request[field]) ~= "string" then return { ok = false, error = USAGE } end
  end
  return command.run(request)
end

local result = run((arg or {})[1], io.read("*a"))
io.stdout:write(vim.json.encode(result) .. "\n")
os.exit(result.ok and 0 or 1)
