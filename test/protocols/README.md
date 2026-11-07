# Deck test protocols

Each protocol tests one interface. Every case is a row in the file's `CASES` table, so the file
itself is the list of what is covered.

- `deck_model.mjs`: `deck/state.js`. Fence and link parsing, a card's conversation, the undo
  tree, and the rules a deck must keep. Run `node test/protocols/deck_model.mjs`.
- `deck_relay.lua`: `scripts/deck.lua`. `verify`, `goto` and `fill` against headless Neovim
  servers. Run `nvim --headless -u NONE -i NONE -n -l test/protocols/deck_relay.lua`.
- `deck_server.mjs`: `deck/server.mjs`. The page's routes: state, writes and which of them wake
  Claude, refresh, and goto pass-through. Run `node test/protocols/deck_server.mjs`.

Not covered by a protocol yet: the page's rendering and clicks in a browser.
