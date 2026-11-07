-- Protocol: the fence grammar (lua/raconteur/parser.lua).
--
-- Interface under test: parser.parse_lines on one fence whose open line carries the case's info
-- string. Every case is one row in CASES, read from test/fixtures/fence_info.json, which
-- test/protocols/deck_model.mjs runs through skill/raconteur-deck/state.js too:
--   { info, expect = { lang, file, start, end, sha } or null when it is not a raconteur fence }
-- A JSON null field means the block's field is nil.
--
-- Run: nvim --headless -u NONE -i NONE -n -l test/protocols/fence_info.lua
local root = vim.fn.getcwd()
package.path = root .. "/lua/?.lua;" .. root .. "/lua/?/init.lua;" .. package.path

local parser = require("raconteur.parser")
local CASES = vim.json.decode(table.concat(vim.fn.readfile(root .. "/test/fixtures/fence_info.json"), "\n"))

local FIELDS = { lang = "lang", file = "file", start = "lines_start", ["end"] = "lines_end", sha = "sha" }

local failed = 0
for _, case in ipairs(CASES) do
  local blocks = parser.parse_lines({ "```" .. case.info, "body", "```" })
  local problems = {}
  if case.expect == vim.NIL then
    if #blocks ~= 0 then problems[#problems + 1] = "parsed as a raconteur fence" end
  elseif #blocks ~= 1 then
    problems[#problems + 1] = "not parsed as a raconteur fence"
  else
    for key, field in pairs(FIELDS) do
      local want = case.expect[key]
      if want == vim.NIL then want = nil end
      if blocks[1][field] ~= want then
        problems[#problems + 1] = key .. " = " .. vim.inspect(blocks[1][field]) .. ", expected " .. vim.inspect(want)
      end
    end
  end
  if #problems == 0 then
    print("ok   " .. case.info)
  else
    failed = failed + 1
    print("FAIL " .. case.info .. "\n     " .. table.concat(problems, "\n     "))
  end
end

print(("%d/%d passed"):format(#CASES - failed, #CASES))
os.exit(failed == 0 and 0 or 1)
