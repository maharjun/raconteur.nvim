# Deck test protocols

Each file tests one interface; its header names the interface and how to run it.

- `deck_model.mjs`: `deck/state.js`, the deck's data model and validity rules.
- `deck_relay.lua`: `scripts/deck.lua`, the relay CLI against headless Neovim servers.
- `deck_server.mjs`: `deck/server.mjs`, the page's routes.
- `fence_info.lua`: the Lua fence-info parser, on the cases shared with `deck_model.mjs`.

Not covered yet: the page's rendering and clicks in a browser.
