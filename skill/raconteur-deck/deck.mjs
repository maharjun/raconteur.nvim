// The agent's view of a deck folder.
//
//   node deck.mjs <deck-dir> check                                print problems; exit 1 if any
//   node deck.mjs <deck-dir> pending                              requests to serve, oldest first
//   node deck.mjs <deck-dir> conversation <card> [--upto <id>]    a card's conversation
import { readDeck } from "./folder.mjs";

const S = globalThis.DeckState;
const USAGE = "usage: node deck.mjs <deck-dir> check | pending | conversation <card> [--upto <message-id>]";

function fail(message) {
  console.error(message);
  process.exit(1);
}

const [dir, command, ...rest] = process.argv.slice(2);
if (!dir) fail(USAGE);
const state = readDeck(dir);

if (command === "check") {
  const problems = [...state.unreadable.map((file) => `${file} is not valid JSON`), ...S.checkDeck(state)];
  problems.forEach((p) => console.log(p));
  console.log(problems.length ? `${problems.length} problems` : "deck is valid");
  process.exit(problems.length ? 1 : 0);
} else if (command === "pending") {
  console.log(JSON.stringify(S.pendingRequests(state), null, 2));
} else if (command === "conversation" && (rest.length === 1 || (rest.length === 3 && rest[1] === "--upto"))) {
  const [cardId, , upto] = rest;
  const card = state.cards[cardId];
  if (!card) fail(`no card ${cardId}`);
  if (rest.length > 1 && (!state.messages[upto] || state.messages[upto].card_id !== cardId)) {
    fail(`${upto} is not a message of card ${cardId}`);
  }
  const { head, digest, messages } = S.conversation(state, cardId, { upto });
  console.log(JSON.stringify({ card: cardId, title: card.title, head, digest, messages }, null, 2));
} else {
  fail(USAGE);
}
