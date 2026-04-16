# Test PR Walkthrough: Greeter Enhancements

This walkthrough covers the changes to the greeter module. Open it in
Neovim with raconteur.nvim installed and use `<leader>re` to toggle
into view mode.

## 1. New Template Field

We added a configurable `template` field so callers can customise the
greeting format without changing the function:

```lua file=test/fixtures/greet.lua lines=4-5
```

## 2. Updated `greet()` Signature

The `greet` function now accepts an optional `template` parameter.  If
omitted it falls back to `M.template`:

```lua file=test/fixtures/greet.lua lines=7-14
```

## 3. Bulk Greeting

A new `greet_many()` function handles lists of names in one call:

```lua file=test/fixtures/greet.lua lines=22-31
```

## 4. Full File

For reference, here is the entire module after the changes:

```lua file=test/fixtures/greet.lua
```
