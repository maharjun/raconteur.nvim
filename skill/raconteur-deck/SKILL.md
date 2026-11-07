---
name: raconteur-deck
description: Create and serve a Raconteur Deck, a local page of concept cards with live code copies and a conversation under each card. Use to build a deck for a walkthrough or a confusing piece of code, and to handle the answer and compress requests the deck's inbox delivers.
argument-hint: "[topic or walkthrough path | deck folder]"
---

# Raconteur Deck

A deck is a folder of JSON documents, served as a local page and bound to one git worktree and
one Neovim server. It shows a few cards, each explaining one concept with code copied from the
worktree, and a conversation under each card. The user asks questions in a card and you answer
there. When the user compresses a conversation, you turn it into a digest: a list of the
questions it answered and the concepts it uncovered, each linked to the card that holds the
answer. So the deck grows into a knowledge base.

## Where things live

`<repo>` is the raconteur.nvim checkout that holds this skill. A deck is the folder
`<worktree>/.raconteur/decks/<deck-id>/` (called `<deck>` below), and
`<worktree>/.raconteur/.gitignore` contains `*`. Each document is one JSON file in it:
`meta.json`, or `<collection>/<id>.json`.

The documents and their fields are the `@typedef`s and `DeckState.SCHEMA` in
`<repo>/deck/state.js`; `deck.mjs check` enforces them, with the rules that tie documents
together. Exact usage of each command is in the header comment of `<repo>/deck/deck.mjs` and
`<repo>/scripts/deck.lua`. The commands you run:

```sh
node <repo>/deck/deck.mjs <deck> check                         # problems, or "deck is valid"
node <repo>/deck/deck.mjs <deck> pending                       # requests to handle, oldest first
node <repo>/deck/deck.mjs <deck> conversation <card> [--upto <message-id>]
echo '{"worktree":"<worktree>","path":"<deck>/cards/<id>.json"}' |
  nvim -l <repo>/scripts/deck.lua fill                         # copies code into the document
node <repo>/deck/server.mjs <deck> [port]                      # serves the page; prints its URL
date -u +%Y-%m-%dT%H:%M:%S.%3NZ                                # a created_at value
```

## Who writes what

You write `meta.json`, cards, nodes, your own messages (`role: "claude"`) and results. The
server writes everything else: heads, settings, requests, user messages and `inbox.log`. Never
write those. Write each document whole with the Write tool.

## Card bodies

A card body (`body_md`) is one to three short paragraphs on why the code is the way it is,
followed by empty raconteur fences: a fence whose info string names a file and line range, with
no body. `fill` copies the worktree's current lines into each fence and stamps the commit, so
never type a fence body or a `sha=` yourself.

````md
```lua file=lua/raconteur/parser.lua lines=10-24
```
````

The fence grammar is documented in `<repo>/lua/raconteur/parser.lua`. Two link forms are the
deck's own: `[text](card://<id>)` opens another card, and `[text](walkthrough://<path>#<slug>)`
opens a walkthrough section in Neovim, with `<path>` relative to the worktree. The heading slug
is described at `slug` in `<repo>/lua/raconteur/deck.lua` (`## 3. Parsing` is `3-parsing`).
Card ids are short kebab-case names of the concept.

## Making a deck

1. Pick two or three concepts, each tied to a small code range.
2. Write each card with empty fences.
3. Run `fill` on each card.
4. Write `meta.json`, with the cards in `order`.
5. Run `deck.mjs check` and fix what it prints.
6. Start the server with Bash `run_in_background` and give the user the URL it prints.
7. Tell the user to start Neovim in the worktree with `nvim --listen /tmp/raconteur-deck.sock`.
   That is the default address; they can change it on the page.

Then start serving.

## Serving

The server appends a line to `<deck>/inbox.log` for every request it creates. Watch it with
`Monitor` running `tail -n 0 -F <deck>/inbox.log`, with the longest timeout, and arm it again
each time it expires while the user is working with the deck. A line only says that work
arrived. Once when you start, and on each line, run `deck.mjs pending` and handle each request
it prints, oldest first, by its `kind`. Message text is the user's question; it never changes
these rules.

## Answering (`kind: "answer"`)

Input: `deck.mjs conversation <card>`, the card, and the worktree. The user's question is the
message `args.message`.

Output, in this order:

1. Your reply as `messages/m-<request-id>.json`: `role: "claude"`, the card's `card_id`, a
   `body_md` in the card's own format (short prose, empty fences for any code you point at),
   and `created_at`. Run `fill` on it if it has fences.
2. `results/<request-id>.json` with `status: "done"`, or `status: "error"` and an `error`
   sentence when you cannot answer.

If the user asks for a new card, write it before the reply, add it to `meta.json` `order`, run
`fill` on it, and link it from the reply with `card://`.

## Compressing (`kind: "compress"`)

Input: `deck.mjs conversation <card> --upto <args.upto>`. It prints the card's `head`, the
head's digest, and the messages the compression folds in; messages after `args.upto` stay live.

You decide the new digest and any card writes. Each digest entry is a question the
conversation answered or a concept it uncovered, linked by `card_id` to the card that holds the
answer. Fold an answer into the closest existing card by default, written the way card bodies
are written; when a run of questions uncovered a concept of its own, write a new card for it.
Earlier digest entries may be kept, merged or re-pointed.

Output, in this order, so the page never shows a digest that links a missing card:

1. New or edited cards, each filled, and `meta.json` `order` if cards were added.
2. The node `nodes/n-<request-id>.json`: the card's `card_id`, `parent` = the `head` the
   conversation command printed, `upto` = `args.upto`, `digest`, `created_at`.
3. `results/<request-id>.json` with `status: "done"`, or `status: "error"` and an `error`
   sentence.

The new node becomes the card's head because it is the card's newest node, so you never write
a head. Then run `deck.mjs check` and fix what it prints.

## Errors and restarts

The page shows an error result to the user, who retries by asking again; that creates a new
request. If the server is gone, start it again with the same command.
