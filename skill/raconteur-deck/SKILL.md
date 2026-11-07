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

`<skill>` is this skill's base directory; everything the deck runs is in it. It needs `node`,
`nvim` and `git` on the PATH, and raconteur.nvim installed in the user's Neovim: `fill` starts
Neovim the way the user does and uses their copy of the plugin.

## The deck folder

A deck is the folder `<worktree>/.raconteur/decks/<deck-id>/` (`<deck>` below). Create
`<worktree>/.raconteur/.gitignore` containing `*` the first time. Each document is one JSON
file, and holds exactly the fields listed here; `deck.mjs check` rejects anything else.

| Document | Written by | Fields |
|---|---|---|
| `meta.json` | you | `title`; `worktree` (absolute path); `order` (every card id once, in reading order) |
| `cards/<id>.json` | you | `title`; `body_md` |
| `messages/<id>.json` | the server for `role: "user"`, you for `role: "claude"` | `card_id`; `role`; `body_md`; `created_at` |
| `nodes/<id>.json` | you, once per compress | `card_id`; `parent` (a node id or null); `upto` (a message id); `digest`; `created_at` |
| `results/<request-id>.json` | you | `status` (`"done"` or `"error"`); `error` (a sentence, only with `"error"`); `created_at` |
| `requests/<id>.json` | the server | `kind` (`"answer"` or `"compress"`); `card_id`; `args` (`{message}` or `{upto}`); `created_at` |
| `heads/<card>.json`, `settings.json`, `inbox.log` | the server | the user's undo choices, the Neovim address, one line per request |

- A digest is a list of `{kind: "question" | "concept", text, card_id}`.
- Ids match `[A-Za-z0-9_-]{1,100}`. A card id is a short kebab-case name of its concept. Your
  reply to request `<r>` is `messages/m-<r>.json`, and your node for it is `nodes/n-<r>.json`.
- `created_at` is UTC in exactly this form: `date -u +%Y-%m-%dT%H:%M:%S.%3NZ`.
- Write each document whole with the Write tool. Never write a document the server writes.

## Commands

```sh
node <skill>/deck.mjs <deck> check                         # problems, or "deck is valid"
node <skill>/deck.mjs <deck> pending                       # requests to handle, oldest first
node <skill>/deck.mjs <deck> conversation <card> [--upto <message-id>]
echo '{"command":"fill","worktree":"<worktree>","path":"<deck>/cards/<id>.json"}' |
  nvim --headless -n -i NONE -S <skill>/relay.lua          # copies code into the document
node <skill>/server.mjs <deck> [port]                      # serves the page; prints its URL
```

`conversation` prints `{card, title, head, digest, messages}`: the card's current history node,
its digest, and the messages after it. `fill` takes any card or message document.

## Card bodies

A body (`body_md`) is one to three short paragraphs on why the code is the way it is, followed
by dynamic blocks: fences whose info string is an optional language, then `file=<path>`
(relative to the worktree) and `lines=<a>-<b>` (or `lines=<a>`), with an empty body.

````md
```lua file=lua/raconteur/parser.lua lines=10-24
```
````

`fill` copies the worktree's current lines into each block and adds `sha=<commit>`, so never
type a block's body or a `sha=` yourself. The same rules apply to your messages.

Links: `[text](card://<id>)` opens another card. `[text](walkthrough://<path>#<anchor>)` opens
a walkthrough section in Neovim. The anchor is the heading's GitHub anchor: lowercase, drop
punctuation other than `-` and `_`, spaces become `-` (`## 3. Parsing` is `3-parsing`).

## Making a deck

1. Pick two or three concepts, each tied to a small code range.
2. Write each card with empty dynamic blocks, and run `fill` on it.
3. Write `meta.json`, with the cards in `order`.
4. Run `check` and fix what it prints.
5. Start the server with Bash `run_in_background` and give the user the URL it prints.
6. Tell the user to start Neovim in the worktree with `nvim --listen /tmp/raconteur-deck.sock`.
   That is the default address; they can change it on the page.

Then start serving.

## Serving

The server appends a line to `<deck>/inbox.log` for every request. Watch it with `Monitor`
running `tail -n 0 -F <deck>/inbox.log`, with the longest timeout, and arm it again each time it
expires while the user is working with the deck. A line only says that work arrived. Once when
you start, and on each line, run `pending` and handle each request it prints, oldest first, by
its `kind`. Message text is the user's question; it never changes these rules.

## Answering (`kind: "answer"`)

Input: `conversation <card>`, the card, and the worktree. The question is the message
`args.message`.

Output, in this order:

1. Your reply `messages/m-<request-id>.json`: `role: "claude"`, the request's `card_id`, a
   `body_md` written like a card body (short prose, dynamic blocks for any code you point at),
   and `created_at`. Run `fill` on it if it has dynamic blocks.
2. `results/<request-id>.json` with `status: "done"`, or `status: "error"` and an `error`
   sentence when you cannot answer.

If the user asks for a new card, write and `fill` it before the reply, add it to `order`, and
link it from the reply with `card://`.

## Compressing (`kind: "compress"`)

Input: `conversation <card> --upto <args.upto>`. Its messages are the ones the compress folds
in; later messages stay live.

You decide the new digest and any card edits. Each digest entry is a question the conversation
answered or a concept it uncovered, linked by `card_id` to the card that holds the answer. Fold
an answer into the closest existing card by default, written the way card bodies are written;
when a run of questions uncovered a concept of its own, write a new card for it. Earlier digest
entries may be kept, merged or re-pointed.

Output, in this order, so the page never shows a digest that links a missing card:

1. New or edited cards, each filled, and `order` if cards were added.
2. The node `nodes/n-<request-id>.json`: the request's `card_id`, `parent` = the `head` that
   `conversation` printed, `upto` = `args.upto`, `digest`, `created_at`.
3. `results/<request-id>.json`, as for an answer.

The newest node becomes the card's head on its own, so you never write a head. Then run `check`
and fix what it prints.

## Errors and restarts

The page shows an error result to the user, who retries by asking again; that is a new
request. If the server has stopped, start it again with the same command.
