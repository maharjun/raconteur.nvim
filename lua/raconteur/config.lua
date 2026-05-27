--- Default configuration and user option merging.
--- All keymaps are buffer-local and only active in rendered (view) mode.
local M = {}

local defaults = {
  -- Automatically render code references when a markdown file is opened.
  auto_render = true,

  keymaps = {
    goto_source = "<leader>gf", -- open referenced file in previous tab
    refresh     = "<leader>rr", -- re-read source files and re-render
    toggle_edit = "<leader>re", -- toggle between view (read-only) and edit mode
    diff_open   = "<leader>gd", -- DiffView: working tree diff for block's file
    diff_main   = "<leader>gm", -- DiffView: diff against main for block's file
    diff_target = "<leader>gt", -- DiffView: diff with custom target (set via :RaconteurDiffTarget)
  },

  -- Show "file:start-end" as virtual text on the opening fence line.
  show_source_path = true,

  -- How to surface errors (missing file, bad range, etc.).
  --   "inline"  – placeholder line inside the fence body
  --   "notify"  – vim.notify only
  --   "ignore"  – silently skip the block
  on_error = "inline",
}

--- @type table
M._config = vim.deepcopy(defaults)

--- Merge user options into defaults. Called once from init.setup().
--- @param opts? table
function M.setup(opts)
  M._config = vim.tbl_deep_extend("force", defaults, opts or {})
end

--- @return table
function M.get()
  return M._config
end

return M
