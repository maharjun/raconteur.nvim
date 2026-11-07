// Protocol: the deck model (skill/raconteur-deck/state.js).
//
// Interface under test: the pure functions the page renders from and the agent checks its
// writes with. Input is a deck state as readDeck returns it; output is plain data. Every case is
// one row in CASES: [function, description, arguments, expected result]. The fence rows also run
// every case in test/fixtures/fence_info.json, which the Lua parser test shares.
//
// Run: node test/protocols/deck_model.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import "../../skill/raconteur-deck/state.js";

const S = globalThis.DeckState;
const FENCES = JSON.parse(fs.readFileSync(new URL("../fixtures/fence_info.json", import.meta.url), "utf8"));

const T = (second) => new Date(Date.UTC(2026, 10, 7, 10, 0, second)).toISOString();

// Card "parser" was compressed twice, the second time on a branch made after undoing the first:
// n1 -> n2 and n1 -> n3, both covering m1-m4. m5 is unanswered; card "fill" has a failed answer.
function deck() {
  const message = (card_id, role, second) => ({ card_id, role, body_md: "text", created_at: T(second) });
  const answer = (card_id, message, second) => ({ kind: "answer", card_id, args: { message }, created_at: T(second) });
  return {
    meta: { title: "Parser", worktree: "/work/repo", order: ["parser", "fill"] },
    settings: null,
    cards: {
      parser: { title: "Parser", body_md: "Filling is in [fill](card://fill)." },
      fill: { title: "Fill", body_md: "Back to [the parser](card://parser)." },
    },
    heads: {},
    nodes: {
      n1: { card_id: "parser", parent: null, upto: "m2", created_at: T(20),
        digest: [{ kind: "question", text: "Why one pass?", card_id: "parser" }] },
      n2: { card_id: "parser", parent: "n1", upto: "m4", created_at: T(21),
        digest: [{ kind: "concept", text: "Closing fences", card_id: "fill" }] },
      n3: { card_id: "parser", parent: "n1", upto: "m4", created_at: T(22),
        digest: [{ kind: "question", text: "Why one pass?", card_id: "parser" }] },
    },
    messages: {
      m1: message("parser", "user", 1), m2: message("parser", "claude", 2),
      m3: message("parser", "user", 3), m4: message("parser", "claude", 4),
      m5: message("parser", "user", 5), f1: message("fill", "user", 1),
    },
    requests: {
      r1: answer("parser", "m1", 1), r3: answer("parser", "m3", 3), r5: answer("parser", "m5", 5),
      rf: answer("fill", "f1", 1),
      rc: { kind: "compress", card_id: "parser", args: { upto: "m4" }, created_at: T(19) },
    },
    results: {
      r1: { status: "done", created_at: T(2) }, r3: { status: "done", created_at: T(4) },
      rc: { status: "done", created_at: T(22) },
      rf: { status: "error", error: "The answer could not be written.", created_at: T(2) },
    },
  };
}

function edited(edit) {
  const state = deck();
  edit(state);
  return state;
}

const chose = (node, second) => edited((s) => { s.heads.parser = { node, at: T(second) }; });

const ids = (docs) => docs.map((d) => d.id);

const CASES = [
  // parseFenceInfo: which fences are dynamic blocks, and what they point at.
  ...FENCES.map(({ info, expect }) => ["parseFenceInfo", `shared case "${info}"`, [info], expect]),
  ["parseFenceInfo", "empty info is a plain fence", [""], null],
  ["parseFenceInfo", "malformed range and sha are absent", ["lua file=a.lua lines=x sha=XYZ"],
    { lang: "lua", file: "a.lua", start: null, end: null, sha: null }],
  ["parseFenceInfo", "the first token of a key decides", ["lua file=a.lua lines=x lines=1-2 file=b.lua"],
    { lang: "lua", file: "a.lua", start: null, end: null, sha: null }],
  ["parseFenceInfo", "an empty file= is a plain fence", ["lua file= file=a.lua"], null],

  // parseLink: the deck's two link kinds, web links, and everything refused.
  ["parseLink", "card link", ["card://fill"], { kind: "card", id: "fill" }],
  ["parseLink", "walkthrough section", ["walkthrough://docs/walkthrough.md#2-core-logic"],
    { kind: "walkthrough", path: "docs/walkthrough.md", heading: "2-core-logic" }],
  ["parseLink", "whole walkthrough", ["walkthrough://docs/walkthrough.md"],
    { kind: "walkthrough", path: "docs/walkthrough.md", heading: null }],
  ["parseLink", "web link", ["https://neovim.io"], { kind: "web", href: "https://neovim.io" }],
  ["parseLink", "script link is refused", ["javascript:alert(1)"], null],

  // head: the newer of the user's choice and the card's newest node.
  ["head", "newest node when nothing was chosen", [deck(), "parser"], "n3"],
  ["head", "never compressed", [deck(), "fill"], null],
  ["head", "a choice after the newest node wins", [chose("n1", 30), "parser"], "n1"],
  ["head", "a choice of the start", [chose(null, 30), "parser"], null],
  ["head", "a choice older than the newest node loses", [chose("n1", 21), "parser"], "n3"],
  ["head", "a compress after a choice wins", [edited((s) => {
    s.heads.parser = { node: "n1", at: T(30) };
    s.nodes.n4 = { card_id: "parser", parent: "n1", upto: "m5", digest: [], created_at: T(31) };
  }), "parser"], "n4"],

  // conversation: the head's digest, then the messages after its upto, in time order.
  ["conversation", "head n3 covers up to m4", [deck(), "parser"],
    { head: "n3", digest: ["Why one pass?"], messages: ["m5"] }],
  ["conversation", "never compressed: all messages, no digest", [deck(), "fill"],
    { head: null, digest: [], messages: ["f1"] }],
  ["conversation", "undo to n1 shows m3 again", [chose("n1", 30), "parser"],
    { head: "n1", digest: ["Why one pass?"], messages: ["m3", "m4", "m5"] }],
  ["conversation", "undo to the start shows every message", [chose(null, 30), "parser"],
    { head: null, digest: [], messages: ["m1", "m2", "m3", "m4", "m5"] }],
  ["conversation", "compress input stops at upto", [chose("n1", 30), "parser", { upto: "m4" }],
    { head: "n1", digest: ["Why one pass?"], messages: ["m3", "m4"] }],

  // undoTarget and children: moving through the undo tree.
  ["undoTarget", "from n3 to its parent", [deck(), "parser"], { node: "n1" }],
  ["undoTarget", "from the first node to the start", [chose("n1", 30), "parser"], { node: null }],
  ["undoTarget", "nothing to undo", [deck(), "fill"], null],
  ["children", "two branches after n1, oldest first", [deck(), "parser", "n1"], ["n2", "n3"]],
  ["children", "redo from the start", [deck(), "parser", null], ["n1"]],

  // pendingRequests, requestStatus, answerStatus, compressStatus: requests and their results.
  ["pendingRequests", "only the request without a result", [deck()], ["r5"]],
  ["pendingRequests", "oldest first", [edited((s) => { delete s.results.r1; })], ["r1", "r5"]],
  ["requestStatus", "done", [deck(), "r1"], { request: "r1", status: "done", error: null }],
  ["requestStatus", "waiting", [deck(), "r5"], { request: "r5", status: "waiting", error: null }],
  ["requestStatus", "failed with the agent's sentence", [deck(), "rf"],
    { request: "rf", status: "error", error: "The answer could not be written." }],
  ["answerStatus", "answered user message", [deck(), "m1"], { request: "r1", status: "done", error: null }],
  ["answerStatus", "waiting user message", [deck(), "m5"], { request: "r5", status: "waiting", error: null }],
  ["answerStatus", "claude message has no answer request", [deck(), "m2"], null],
  ["compressStatus", "done compress", [deck(), "parser"], { request: "rc", status: "done", error: null }],
  ["compressStatus", "the newest compress counts", [edited((s) => {
    s.requests.rc2 = { kind: "compress", card_id: "parser", args: { upto: "m5" }, created_at: T(40) };
  }), "parser"], { request: "rc2", status: "waiting", error: null }],
  ["compressStatus", "never compressed", [deck(), "fill"], null],

  // checkDeck, schema: field types, enums, required and unknown fields, ids and times.
  ["checkDeck", "valid deck", [deck()], []],
  ["checkDeck", "settings are valid too", [edited((s) => { s.settings = { nvim_server: "/tmp/x.sock" }; })], []],
  ["checkDeck", "meta is required", [edited((s) => { s.meta = null; })], ["meta.json is missing"]],
  ["checkDeck", "unknown field", [edited((s) => { s.messages.m1.status = "done"; })],
    ["messages/m1.json: status is not a known field"]],
  ["checkDeck", "missing field", [edited((s) => { delete s.nodes.n1.created_at; })],
    ["nodes/n1.json: created_at is missing"]],
  ["checkDeck", "time not as toISOString prints it",
    [edited((s) => { s.messages.m1.created_at = "2026-11-07T10:00:01Z"; })],
    ["messages/m1.json: created_at is not an ISO UTC time"]],
  ["checkDeck", "role outside its enum", [edited((s) => { s.messages.m1.role = "assistant"; })],
    ["messages/m1.json: role is not one of user, claude"]],
  ["checkDeck", "digest entry kind outside its enum", [edited((s) => { s.nodes.n1.digest[0].kind = "note"; })],
    ["nodes/n1.json: digest[0].kind is not one of question, concept"]],
  ["checkDeck", "nullable field of the wrong type", [edited((s) => { s.nodes.n1.parent = 3; })],
    ["nodes/n1.json: parent is not an id or null"]],
  ["checkDeck", "file name that is not an id",
    [edited((s) => { s.messages["bad id"] = { ...s.messages.m5 }; })],
    ["messages/bad id.json: file name is not an id"]],

  // checkDeck, cross-document rules.
  ["checkDeck", "order lists a missing card", [edited((s) => { s.meta.order.push("gone"); })],
    ["meta.json: order lists missing card gone"]],
  ["checkDeck", "order lists a card twice", [edited((s) => { s.meta.order.push("fill"); })],
    ["meta.json: order lists card fill twice"]],
  ["checkDeck", "new card left out of order",
    [edited((s) => { s.cards.extra = { title: "Extra", body_md: "" }; })],
    ["meta.json: order leaves out card extra"]],
  ["checkDeck", "head of a missing card", [edited((s) => { s.heads.gone = { node: null, at: T(30) }; })],
    ["heads/gone.json: card gone does not exist"]],
  ["checkDeck", "head chooses another card's node",
    [edited((s) => { s.heads.fill = { node: "n1", at: T(30) }; })],
    ["heads/fill.json: node n1 belongs to card parser"]],
  ["checkDeck", "node parent does not exist", [edited((s) => { s.nodes.n2.parent = "n9"; })],
    ["nodes/n2.json: parent n9 does not exist"]],
  ["checkDeck", "node upto earlier than its parent's", [edited((s) => { s.nodes.n2.upto = "m1"; })],
    ["nodes/n2.json: upto m1 is earlier than parent n1's upto m2"]],
  ["checkDeck", "node upto of another card", [edited((s) => { s.nodes.n1.upto = "f1"; })],
    ["nodes/n1.json: upto f1 is not a message of card parser"]],
  ["checkDeck", "digest links a missing card",
    [edited((s) => { s.nodes.n3.digest[0].card_id = "gone"; })],
    ["nodes/n3.json: digest links missing card gone"]],
  ["checkDeck", "card body links a missing card",
    [edited((s) => { s.cards.fill.body_md = "See [x](card://gone)."; })],
    ["cards/fill.json: body_md links missing card gone"]],
  ["checkDeck", "message links a missing card",
    [edited((s) => { s.messages.m2.body_md = "See <card://gone>."; })],
    ["messages/m2.json: body_md links missing card gone"]],
  ["checkDeck", "message of a missing card", [edited((s) => { s.messages.f1.card_id = "gone"; })],
    ["messages/f1.json: card gone does not exist",
      "requests/rf.json: args.message f1 is not a message of card fill"]],
  ["checkDeck", "request args not the kind's one argument",
    [edited((s) => { s.requests.rc.args = { message: "m4" }; })], ["requests/rc.json: args is not {upto}"]],
  ["checkDeck", "answer request for another card's message",
    [edited((s) => { s.requests.r1.args.message = "f1"; })],
    ["requests/r1.json: args.message f1 is not a message of card parser"]],
  ["checkDeck", "result without a request",
    [edited((s) => { s.results.r9 = { status: "done", created_at: T(9) }; })],
    ["results/r9.json: request r9 does not exist"]],
  ["checkDeck", "failed result without its sentence", [edited((s) => { delete s.results.rf.error; })],
    ["results/rf.json: error is missing"]],
  ["checkDeck", "done result with a sentence", [edited((s) => { s.results.r1.error = "No."; })],
    ["results/r1.json: error is only for status error"]],
];

// Results are compared in a reduced form so rows stay readable.
const REDUCE = {
  conversation: (r) => ({ head: r.head, digest: r.digest.map((e) => e.text), messages: ids(r.messages) }),
  children: ids,
  pendingRequests: ids,
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
