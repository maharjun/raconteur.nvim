#!/usr/bin/env -S nvim -l
--- Fill raconteur code blocks in a markdown file with source content.
---
--- Usage:
---   nvim -l scripts/fill.lua <markdown_file> [root_dir]
---
--- If root_dir is omitted, the git root of the markdown file is used.
--- The file is modified in-place.

-- Add the plugin's lua/ to the module path so require("raconteur.*") works
-- regardless of where the script is invoked from.
local script_dir = debug.getinfo(1, "S").source:match("@?(.*/)")
local plugin_root = script_dir .. "../"
package.path = plugin_root .. "lua/?.lua;" .. plugin_root .. "lua/?/init.lua;" .. package.path

local fill = require("raconteur.fill")

-- With nvim -l, positional args are in the global `arg` table.
local args = arg or {}
local filepath = args[1]
local root_dir = args[2]

if not filepath then
  io.stderr:write("Usage: nvim -l scripts/fill.lua <markdown_file> [root_dir]\n")
  os.exit(1)
end

-- Resolve to absolute path.
filepath = vim.fn.fnamemodify(filepath, ":p")

if not root_dir then
  local dir = vim.fn.fnamemodify(filepath, ":h")
  root_dir = vim.fs.root(dir, ".git")
  if not root_dir then
    io.stderr:write("Could not find git root for: " .. filepath .. "\n")
    os.exit(1)
  end
end

local ok, err = fill.fill_file(filepath, root_dir)
if not ok then
  io.stderr:write("Error: " .. err .. "\n")
  os.exit(1)
end

print("Filled: " .. filepath)
