# Deck test protocols

Each file tests one interface of `skill/raconteur-deck/`; its header names the interface and how
to run it.

- `deck_cli.mjs`: `folder.mjs` and `deck.mjs`, the deck folder and the agent's CLI.
- `deck_model.mjs`: `state.js`, the deck's data model and validity rules.
- `deck_relay.lua`: `relay.lua`, the relay CLI against headless Neovim servers.
- `deck_server.mjs`: `server.mjs`, the page's routes.
- `fence_info.lua`: the Lua fence-info parser, on the cases shared with `deck_model.mjs`.

Not covered yet: the page's rendering and clicks in a browser.
