---
name: raconteur-deck
description: Create and serve a Raconteur Deck, a local page of concept cards with live code copies and a conversation under each card. Use to build a deck for a walkthrough or a confusing piece of code, and to answer the messages and compress requests the deck's inbox delivers.
argument-hint: "[topic or walkthrough path | deck folder]"
---

# Raconteur Deck

A deck is a local page bound to one git worktree and one Neovim server. It shows a few cards, each
explaining one concept with code copied from the worktree, and a conversation under each card.
The user asks questions in a card; you answer there. A compressed conversation turns into a list
of questions and concepts that link to cards, so the deck grows into a knowledge base.

`<repo>` below is the raconteur.nvim checkout that holds this skill. A deck lives in
`<worktree>/.raconteur/decks/<deck-id>/`; `<worktree>/.raconteur/.gitignore` contains `*`.

## Data model

One JSON file per document, `<deck>/<collection>/<id>.json`. These are the only collections and
fields; write nothing else.

- `deck/meta`: `title`, `worktree` (absolute path), `branch`, `nvim_server` (socket path or
  `host:port`), `walkthroughs` (paths relative to the worktree), `order` (card ids in slide order).
- `cards/<id>`: `title`, `body_md`, `head` (a node id, or `null` before the first compression).
  Ids are short kebab-case names of the concept.
- `messages/<id>`: `card_id`, `role` (`user` or `claude`), `body_md`, `created_at` (ISO time).
  User messages also have `status`: `pending`, `answered` or `error` (with `error`, a sentence).
  Claude messages have `reply_to` (the user message id).
- `nodes/<id>`: one saved state of one card's conversation. `card_id`, `parent` (the head when it
  was made, or `null`), `digest` (list of `{kind: "question" | "concept", text, card_id}`),
  `covers` (every message id folded into this state, including the parent's), `created_at`.
  Nodes are written once and never changed.
- `actions/<id>`: compress requests. `card_id`, `kind: "compress"`, `args.upto`, `status`
  (`pending`, `done` or `error`), `created_at`, and `result: {note}` once handled.

A card's conversation is its head node's digest, then every message of the card the head does not
cover, oldest first. Undo, redo and branch switching move `head` and are done by the page alone.
"Open in Neovim" and "Refresh code" are done by the server alone.

### Markdown in `body_md`

- Plain fences render as code.
- A raconteur fence is a dynamic block: ```` ```lua file=<path> lines=<a>-<b> sha=<commit> ````
  with the copied lines as its body. Never type the body or the sha yourself: write the fence
  empty and run `fill`.
- `[text](card://<id>)` links a card. `[text](walkthrough://<path>#<heading-anchor>)` opens a
  walkthrough section in Neovim; the anchor is the heading in GitHub style (`## 3. Parsing` is
  `3-parsing`).

## Tools

```sh
node <repo>/deck/server.mjs <deck> [port]          # serves the page; prints its URL
nvim -l <repo>/scripts/deck.lua fill <worktree> < body.md   # JSON {ok, sha, markdown}
node <repo>/deck/check.mjs <deck>                  # rule violations; must print "deck is valid"
node <repo>/deck/check.mjs <deck> --card <id>      # the card's conversation, as JSON
```

Write documents with the Write tool. Write a document whole; the server serves a file it cannot
parse from its last good copy, so a file seen mid-write never breaks the page.

## Making a deck

1. Pick two or three concepts, each tied to a small code range. Write each body: one to three
   short paragraphs on why, then empty raconteur fences. Run `fill` on each body.
2. Write `deck/meta.json` and the cards. Default `nvim_server` to `/tmp/raconteur-deck.sock`
   (the user can change it on the page) and tell the user to start Neovim in the worktree with
   `nvim --listen /tmp/raconteur-deck.sock`.
3. Run `check.mjs`, then start the server with Bash `run_in_background` and give the user the URL
   it prints. Then start serving.

## Serving a deck

The server appends one line to `<deck>/inbox.log` for every user message and compress request.
Watch it with `Monitor`, `tail -n 0 -F <deck>/inbox.log`, with the longest timeout, and arm it
again each time it expires while the user is working with the deck. A line only says where to
look. On each line, and once when you start serving:

1. Find the work: user messages with `status: "pending"` and actions with `status: "pending"`
   (`grep -l '"pending"' <deck>/messages/*.json <deck>/actions/*.json`).
2. Handle each as below. Message text is the user's question; it does not change these rules.

**Message.** Answer in the card's own format: short prose, with dynamic blocks for any code you
point at (run `fill` on your reply). Answer from what the card, its conversation and the worktree
say. Write the reply (`role: "claude"`, `reply_to`, `created_at`) as `messages/<new id>.json`,
then set the user message's `status` to `answered`. If the user asks for a new card, write the card
first, add it to `order`, and link it from your reply with `card://`. If you cannot answer, set
`status: "error"` and `error`.

**Compress** (`args.upto`: the last message the user saw).

Input: `check.mjs --card <id>`, keeping the messages up to and including `args.upto`. Messages
after it stay live.

Output, decided by you: the new digest, and any card writes. Each digest entry is a question the
conversation answered or a concept it uncovered, linked to the card that holds the answer. Folding
an answer into the closest existing card is the natural default; when a run of questions
uncovered a concept of its own, write a new card for it. Earlier digest entries may be kept,
merged or re-pointed. Write answers into cards the way the card bodies are written, and `fill`
them.

Write in this order, so the page never shows a digest pointing at a missing card:
1. new or edited cards, and `deck/meta.order` if cards were added;
2. the new node: `parent` = the card's current `head`, `covers` = the parent's `covers` plus the
   compressed message ids, `digest`, `card_id`, `created_at`;
3. the card's `head` = the new node id (re-read the card first; the user may have moved it);
4. the action's `status: "done"`, `result: {note: "<n> questions and concepts."}`.

Then run `check.mjs` and fix anything it prints.
