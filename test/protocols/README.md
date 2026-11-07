# Deck test protocols

Each protocol tests one interface. Every case is a row in the file's `CASES` table, so the file
itself is the list of what is covered.

| Protocol | Interface | Run |
| --- | --- | --- |
| `deck_model.mjs` | `deck/state.js`: fence and link parsing, a card's conversation, the undo tree, deck rules | `node test/protocols/deck_model.mjs` |
| `deck_relay.lua` | `scripts/deck.lua`: `verify`, `goto`, `fill` against headless Neovim servers | `nvim --headless -u NONE -i NONE -n -l test/protocols/deck_relay.lua` |

Not covered by a protocol yet: the page's rendering and clicks, and the wake path from a page
comment to the Claude session. Both need a signed-in claude.ai view.
