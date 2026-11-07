// Protocol: the deck model (deck/state.js).
//
// Interface under test: the pure functions the page renders from and the
// agent checks its writes with. Input is a deck state as stored in the
// artifact database; output is plain data. Every case is one row in CASES:
// [function, description, arguments, expected result].
//
// Run: node test/protocols/deck_model.mjs
import assert from "node:assert/strict";
import "../../deck/state.js";

const S = globalThis.DeckState;

// One card whose conversation was compressed twice, the second time on a
// branch made after undoing the first: n1 -> n2 and n1 -> n3.
function deck() {
  return {
    meta: { order: ["parser", "fill"] },
    cards: { parser: { head: "n3" }, fill: { head: null } },
    nodes: {
      n1: { card_id: "parser", parent: null, created_at: "1", covers: ["m1", "m2"],
        digest: [{ kind: "question", text: "Why one pass?", card_id: "parser" }] },
      n2: { card_id: "parser", parent: "n1", created_at: "2", covers: ["m1", "m2", "m3"],
        digest: [{ kind: "concept", text: "Closing fences", card_id: "fill" }] },
      n3: { card_id: "parser", parent: "n1", created_at: "3", covers: ["m1", "m2", "m3"],
        digest: [{ kind: "question", text: "Why one pass?", card_id: "parser" }] },
    },
    messages: {
      m1: { card_id: "parser", role: "user", created_at: "a" },
      m2: { card_id: "parser", role: "claude", created_at: "b", reply_to: "m1" },
      m3: { card_id: "parser", role: "user", created_at: "c" },
      m4: { card_id: "parser", role: "user", created_at: "d" },
      m5: { card_id: "fill", role: "user", created_at: "a" },
    },
    actions: {},
  };
}

function edited(edit) {
  const state = deck();
  edit(state);
  return state;
}

const ids = (messages) => messages.map((m) => m.id);

const CASES = [
  // parseFenceInfo: which fences are dynamic blocks, and what they point at.
  ["parseFenceInfo", "plain fence is not a dynamic block", ["lua"], null],
  ["parseFenceInfo", "file and range", ["lua file=a/b.lua lines=10-25"],
    { lang: "lua", file: "a/b.lua", start: 10, end: 25, sha: null }],
  ["parseFenceInfo", "single line and sha", ["lua file=a.lua lines=7 sha=019f3eb"],
    { lang: "lua", file: "a.lua", start: 7, end: 7, sha: "019f3eb" }],
  ["parseFenceInfo", "whole file, no language", ["file=a.lua"],
    { lang: "", file: "a.lua", start: null, end: null, sha: null }],

  // parseLink: the deck's two link kinds, web links, and everything refused.
  ["parseLink", "card link", ["card://fill"], { kind: "card", id: "fill" }],
  ["parseLink", "walkthrough section", ["walkthrough://docs/walkthrough.md#2-core-logic"],
    { kind: "walkthrough", path: "docs/walkthrough.md", heading: "2-core-logic" }],
  ["parseLink", "whole walkthrough", ["walkthrough://docs/walkthrough.md"],
    { kind: "walkthrough", path: "docs/walkthrough.md", heading: null }],
  ["parseLink", "web link", ["https://neovim.io"], { kind: "web", href: "https://neovim.io" }],
  ["parseLink", "script link is refused", ["javascript:alert(1)"], null],

  // conversation: digest of the head, then uncovered messages in time order.
  ["conversation", "head covers m1-m3; m4 stays live", [deck(), "parser"],
    { digest: ["Why one pass?"], messages: ["m4"] }],
  ["conversation", "never compressed: all messages, no digest", [deck(), "fill"],
    { digest: [], messages: ["m5"] }],
  ["conversation", "undo to n1 shows m3 again",
    [edited((s) => { s.cards.parser.head = "n1"; }), "parser"],
    { digest: ["Why one pass?"], messages: ["m3", "m4"] }],
  ["conversation", "undo to the start shows every message",
    [edited((s) => { s.cards.parser.head = null; }), "parser"],
    { digest: [], messages: ["m1", "m2", "m3", "m4"] }],

  // undoTarget and children: moving through the undo tree.
  ["undoTarget", "from n3 to its parent", [deck(), "parser"], "n1"],
  ["undoTarget", "from the first node to the start",
    [edited((s) => { s.cards.parser.head = "n1"; }), "parser"], null],
  ["undoTarget", "nothing to undo", [deck(), "fill"], undefined],
  ["children", "two branches after n1, oldest first", [deck(), "parser", "n1"], ["n2", "n3"]],
  ["children", "redo from the start", [deck(), "parser", null], ["n1"]],

  // checkDeck: each rule a compression must keep.
  ["checkDeck", "valid deck", [deck()], []],
  ["checkDeck", "digest links a missing card",
    [edited((s) => { s.nodes.n3.digest[0].card_id = "gone"; })],
    ["node n3 digest links missing card gone"]],
  ["checkDeck", "node drops a message its parent covered",
    [edited((s) => { s.nodes.n2.covers = ["m1", "m3"]; })],
    ["node n2 drops message m2 covered by its parent"]],
  ["checkDeck", "head points at a missing node",
    [edited((s) => { s.cards.parser.head = "n9"; })], ["card parser head n9 does not exist"]],
  ["checkDeck", "new card left out of order",
    [edited((s) => { s.cards.extra = { head: null }; })], ["card extra is not in order"]],
  ["checkDeck", "node covers another card's message",
    [edited((s) => { s.nodes.n3.covers.push("m5"); })],
    ["node n3 covers message m5 of another card"]],
];

// Results are compared in a reduced form so rows stay readable.
const REDUCE = {
  conversation: (r) => ({ digest: r.digest.map((e) => e.text), messages: ids(r.messages) }),
  children: ids,
};

let failed = 0;
for (const [fn, description, args, expected] of CASES) {
  const result = (REDUCE[fn] || ((r) => r))(S[fn](...args));
  try {
    assert.deepEqual(result, expected);
    console.log(`ok   ${fn}: ${description}`);
  } catch {
    failed += 1;
    console.log(`FAIL ${fn}: ${description}\n     expected ${JSON.stringify(expected)}\n     got      ${JSON.stringify(result)}`);
  }
}
console.log(`${CASES.length - failed}/${CASES.length} passed`);
process.exit(failed ? 1 : 0);
