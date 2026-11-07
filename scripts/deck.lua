#!/usr/bin/env -S nvim -l
--- Deck relay CLI.  Prints one JSON object: {"ok":true,...} or {"ok":false,"error":...}.
---
---   nvim -l scripts/deck.lua verify <server> <worktree>
---   nvim -l scripts/deck.lua goto   <server> <worktree> <file> [line|#heading] [sha]
---   nvim -l scripts/deck.lua fill   <worktree> < card.md
local script_dir = debug.getinfo(1, "S").source:match("@?(.*/)")
package.path = script_dir .. "../lua/?.lua;" .. script_dir .. "../lua/?/init.lua;" .. package.path

local deck = require("raconteur.deck")
local args = arg or {}
local command = args[1]
local result

if command == "verify" and args[3] then
  result = deck.verify(args[2], args[3])
elseif command == "goto" and args[4] then
  local where = args[5] or "1"
  result = deck.goto(args[2], args[3], {
    file = args[4],
    line = tonumber(where),
    heading = where:match("^#(.+)$"),
    sha = args[6],
  })
elseif command == "fill" and args[2] then
  result = deck.fill(args[2], io.read("*a"))
else
  result = { ok = false, error = "usage: verify <server> <worktree> | goto <server> <worktree> <file> [line|#heading] [sha] | fill <worktree> < card.md" }
end

io.stdout:write(vim.json.encode(result) .. "\n")
os.exit(result.ok and 0 or 1)
