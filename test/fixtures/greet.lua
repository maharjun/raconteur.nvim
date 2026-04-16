--- A simple greeter module for testing raconteur.nvim.
local M = {}

--- Greet a user by name.
--- @param name string
--- @return string
function M.greet(name)
  return "Hello, " .. name .. "!"
end

--- Greet the whole world.
--- @return string
function M.greet_world()
  return M.greet("world")
end

return M
