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

-- Read, fill, and write to a .filled sibling.
local f = io.open(filepath, "r")
if not f then
  io.stderr:write("Cannot open: " .. filepath .. "\n")
  os.exit(1)
end
local lines = {}
for line in f:lines() do lines[#lines + 1] = line end
f:close()

local filled = fill.fill_lines(lines, root_dir)

local out_path = filepath:gsub("(%.[^.]+)$", ".filled%1")
f = io.open(out_path, "w")
if not f then
  io.stderr:write("Cannot write: " .. out_path .. "\n")
  os.exit(1)
end
for _, line in ipairs(filled) do f:write(line .. "\n") end
f:close()

print("Wrote: " .. out_path)
