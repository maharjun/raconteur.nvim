// Reads a deck dumped with ArtifactData's out_dir (<dir>/<collection>/<id>.json).
//
//   node deck/check.mjs <dir>                  print rule violations; exit 1 if any
//   node deck/check.mjs <dir> --card <id>      print that card's conversation as JSON
import fs from "node:fs";
import path from "node:path";
import "./state.js";

const [dir, flag, cardId] = process.argv.slice(2);
const read = (collection) => {
  const folder = path.join(dir, collection);
  if (!fs.existsSync(folder)) return {};
  return Object.fromEntries(fs.readdirSync(folder).filter((f) => f.endsWith(".json"))
    .map((f) => [f.slice(0, -5), JSON.parse(fs.readFileSync(path.join(folder, f), "utf8"))]));
};
const state = {
  meta: read("deck").meta || null,
  cards: read("cards"), nodes: read("nodes"), messages: read("messages"), actions: read("actions"),
};

if (flag === "--card") {
  const card = state.cards[cardId];
  if (!card) { console.error(`no card ${cardId}`); process.exit(1); }
  const { digest, messages } = globalThis.DeckState.conversation(state, cardId);
  console.log(JSON.stringify({ card: cardId, title: card.title, head: card.head || null, digest, messages }, null, 1));
} else {
  const problems = globalThis.DeckState.checkDeck(state);
  problems.forEach((p) => console.log(p));
  console.log(problems.length ? `${problems.length} problems` : "deck is valid");
  process.exit(problems.length ? 1 : 0);
}
