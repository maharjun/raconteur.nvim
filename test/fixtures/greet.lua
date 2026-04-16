--- A simple greeter module for testing raconteur.nvim.
local M = {}

--- Default greeting template.
M.template = "Hello, %s!"

--- Greet a user by name.
--- @param name string
--- @param template? string  optional override for the greeting template
--- @return string
function M.greet(name, template)
  local t = template or M.template
  return string.format(t, name)
end

--- Greet the whole world.
--- @return string
function M.greet_world()
  return M.greet("world")
end

--- Greet a list of names, returning one greeting per name.
--- @param names string[]
--- @return string[]
function M.greet_many(names)
  local results = {}
  for _, name in ipairs(names) do
    results[#results + 1] = M.greet(name)
  end
  return results
end

return M
