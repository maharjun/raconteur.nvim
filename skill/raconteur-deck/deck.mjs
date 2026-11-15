// The agent's view of a deck folder and its library.
//
//   node deck.mjs <deck-dir> check                                print problems; exit 1 if any
//   node deck.mjs <deck-dir> pending                              requests to serve, oldest first
//   node deck.mjs <deck-dir> conversation <card> [--upto <id>]    a card's conversation
//   node deck.mjs <deck-dir> stale                                code copies whose lines changed,
//                                                                 and forks whose original changed
//   node deck.mjs <deck-dir> commit <subject> [--request <id> | --cause <cause>]
//                                                                 commit every card change
//   node deck.mjs <deck-dir> fork <card> <fork-id>                copy a card for this deck alone
//   node deck.mjs <deck-dir> history <card>                       the commits of the card shown
import fs from "node:fs";
import path from "node:path";
import { cardRepo, codeHashes, commitCards, readDeck, readStore, writeDoc } from "./folder.mjs";

const S = globalThis.DeckState;
const USAGE = "usage: node deck.mjs <deck-dir> check | pending | conversation <card> [--upto <message-id>] | stale"
  + " | commit <subject> [--request <id> | --cause <authored|edit|refill>] | fork <card> <fork-id> | history <card>";

function fail(message) {
  console.error(message);
  process.exit(1);
}

const print = (value) => console.log(JSON.stringify(value, null, 2));

const [dir, command, ...rest] = process.argv.slice(2);
if (!dir) fail(USAGE);
const state = readDeck(dir);

/** The card a command names, which must exist in the library. */
function knownCard(cardId) {
  if (!S.cardOf(state, cardId)) fail(`no card ${cardId}`);
  return cardId;
}

/** The trailers of a commit made while serving a request: what it was, for which card, and in
 *  which conversation. */
function requestTrailers(requestId) {
  const request = state.requests[requestId];
  if (!request) fail(`no request ${requestId}`);
  return {
    Cause: request.kind, Deck: state.deck, Request: requestId, Card: request.card_id,
    Conversation: request.kind === "reconcile" ? null : S.conversationOf(state, request.card_id),
    Node: request.kind === "compress" ? `n-${requestId}` : null,
  };
}

if (command === "check" && !rest.length) {
  const unreadable = state.unreadable.map((file) =>
    `${file} ${file.endsWith(".md") ? "has no front matter between --- lines" : "is not valid JSON"}`);
  const uncommitted = readStore(dir).uncommitted.map((cardId) =>
    `${S.docPath("cards", cardId)}: has changes that are not committed`);
  const problems = [...unreadable, ...S.checkDeck(state), ...uncommitted];
  problems.forEach((p) => console.log(p));
  console.log(problems.length ? `${problems.length} problems` : "deck is valid");
  process.exit(problems.length ? 1 : 0);
} else if (command === "stale" && !rest.length) {
  print({ code: S.outOfDateBlocks(state, codeHashes(state)), forks: S.behindForks(state, readStore(dir)) });
} else if (command === "pending" && !rest.length) {
  print(S.pendingRequests(state));
} else if (command === "conversation" && (rest.length === 1 || (rest.length === 3 && rest[1] === "--upto"))) {
  const [cardId, , upto] = rest;
  const card = S.cardOf(state, knownCard(cardId));
  const { conversation, head, digest, messages } = S.conversation(state, cardId);
  if (rest.length > 1 && !messages.some((m) => m.id === upto)) {
    fail(`${upto} is not a live message of card ${cardId}'s conversation`);
  }
  const input = rest.length > 1 ? S.conversation(state, cardId, { upto }).messages : messages;
  const shown = S.shownId(state, cardId);
  const stale = S.outOfDateBlocks(state, codeHashes(state)).filter((b) => b.card_id === shown);
  const fork = S.forkStatus(state, readStore(dir), cardId);
  print({ card: cardId, file: S.docPath("cards", shown), title: card.title, conversation, head, digest, messages: input, stale, fork });
} else if (command === "commit" && (rest.length === 1 || (rest.length === 3 && ["--request", "--cause"].includes(rest[1])))) {
  const [subject, flag, value] = rest;
  if (flag === "--cause" && !["authored", "edit", "refill"].includes(value)) fail(USAGE);
  const trailers = flag === "--request" ? requestTrailers(value) : { Cause: value || "edit", Deck: state.deck };
  try {
    print({ commit: commitCards(dir, subject, trailers) });
  } catch (e) {
    fail(e.message);
  }
} else if (command === "fork" && rest.length === 2) {
  const [cardId, forkId] = rest;
  if (!Object.hasOwn(state.cards, cardId)) fail(`no card ${cardId}`);
  if (!S.ID.test(forkId) || Object.hasOwn(state.cards, forkId)) fail(`${forkId} is not a free card id`);
  if (S.shownId(state, cardId) !== cardId) fail(`this deck already shows ${S.shownId(state, cardId)} for ${cardId}`);
  const store = readStore(dir);
  const base = (store.history[cardId] || [])[0];
  if (!base || store.uncommitted.includes(cardId)) fail(`commit ${cardId} before forking it`);
  const copy = { ...state.cards[cardId], forked_from: `${cardId}@${base.commit}` };
  fs.writeFileSync(path.join(cardRepo(dir), `${forkId}.md`), S.formatCard(copy));
  writeDoc(dir, "meta.json", { ...state.meta, aliases: { ...(state.meta.aliases || {}), [cardId]: forkId } });
  print({ fork: forkId, file: S.docPath("cards", forkId), original: cardId, base: base.commit });
} else if (command === "history" && rest.length === 1) {
  const shown = S.shownId(state, knownCard(rest[0]));
  print({ card: rest[0], file: S.docPath("cards", shown), commits: readStore(dir).history[shown] || [] });
} else {
  fail(USAGE);
}
