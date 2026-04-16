--- Plugin entry point.  Registers user commands; the FileType autocmd
--- for auto-rendering lives in init.lua and is created by setup().

if vim.g.raconteur_loaded then return end
vim.g.raconteur_loaded = true

vim.api.nvim_create_user_command("RaconteurRender", function()
  require("raconteur").render()
end, { desc = "Render all code references in current buffer" })

vim.api.nvim_create_user_command("RaconteurClear", function()
  require("raconteur").clear()
end, { desc = "Clear all rendered code in current buffer" })

vim.api.nvim_create_user_command("RaconteurRefresh", function()
  require("raconteur").refresh()
end, { desc = "Refresh all rendered code in current buffer" })

vim.api.nvim_create_user_command("RaconteurToggle", function()
  require("raconteur").toggle()
end, { desc = "Toggle between view and edit mode" })
