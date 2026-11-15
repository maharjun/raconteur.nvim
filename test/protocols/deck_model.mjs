// Protocol: the deck and library model (skill/raconteur-deck/state.js).
//
// Interface under test: the pure functions the page renders from and the agent checks its
// writes with. Input is a deck state as readDeck returns it (and, for forks, a Store); output is plain data. Every case is
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
const C1 = "a".repeat(40);
const C2 = "b".repeat(40);
const commit = (hash, Cause) => ({ commit: hash, at: T(0), subject: "s", trailers: { Cause } });

// Deck "doc" of a library. Card "parser"'s conversation was compressed twice, the second time on
// a branch made after undoing the first: n1 -> n2 and n1 -> n3, both covering m1-m4. m5 is
// unanswered; card "fill" has a failed answer.
function deck() {
  const message = (card, role, second) => ({ conversation: `doc--${card}`, role, body_md: "text", created_at: T(second) });
  const answer = (card_id, message, second) => ({ kind: "answer", card_id, args: { message }, created_at: T(second) });
  return {
    deck: "doc",
    meta: { title: "Parser", worktree: "/work/repo", order: ["parser", "fill"] },
    settings: null,
    cards: {
      parser: { title: "Parser", body_md: "Filling is in [fill](card://fill)." },
      fill: { title: "Fill", body_md: "Back to [the parser](card://parser)." },
    },
    heads: {},
    nodes: {
      n1: { conversation: "doc--parser", parent: null, upto: "m2", created_at: T(20),
        digest: [{ kind: "question", text: "Why one pass?", card_id: "parser" }] },
      n2: { conversation: "doc--parser", parent: "n1", upto: "m4", created_at: T(21),
        digest: [{ kind: "concept", text: "Closing fences", card_id: "fill" }] },
      n3: { conversation: "doc--parser", parent: "n1", upto: "m4", created_at: T(22),
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

const chose = (node, second) => edited((s) => { s.heads["doc--parser"] = { node, at: T(second) }; });

const ids = (docs) => docs.map((d) => d.id);

// Two sections, a plain one and one of term cards, besides the main sequence.
const withSections = () => edited((s) => {
  s.meta.sections = [
    { id: "protocol", title: "Protocol", cards: ["framing"] },
    { id: "terms", title: "Terms", cards: ["t-fence", "t-pass"] },
  ];
  s.cards["t-pass"] = { title: "Pass", kind: "term", body_md: "A walk over the lines." };
  s.cards["t-fence"] = { title: "Fence", kind: "term", body_md: "A run of backticks." };
  s.cards.framing = { title: "Framing", body_md: "Length, then bytes." };
});

// The deck shows its own copy of "fill", made from commit C1 of the shared card.
const withFork = () => edited((s) => {
  s.cards["fill-doc"] = { title: "Fill, for this deck", forked_from: `fill@${C1}`, body_md: "Ours." };
  s.meta.aliases = { fill: "fill-doc" };
});
const STORE_MOVED = { history: { fill: [commit(C2, "compress"), commit(C1, "authored")] }, uncommitted: [] };
const STORE_SAME = { history: { fill: [commit(C1, "authored")] }, uncommitted: [] };

const block = (attrs) => S.parseFenceInfo(`lua file=a.lua lines=2-3 ${attrs}`);
const BLOCKS_MD = [
  "````lua file=a.lua lines=2-3 sha=1 hash=aaa", "```", "````", "",
  "```lua", "plain", "```", "", "```md file=b.lua", "```",
].join("\n");

const CASES = [
  // parseFenceInfo: which fences are dynamic blocks, and what they point at.
  ...FENCES.map(({ info, expect }) => ["parseFenceInfo", `shared case "${info}"`, [info], expect]),
  ["parseFenceInfo", "empty info is a plain fence", [""], null],
  ["parseFenceInfo", "malformed range and sha are absent", ["lua file=a.lua lines=x sha=XYZ"],
    { lang: "lua", file: "a.lua", start: null, end: null, sha: null, hash: null }],
  ["parseFenceInfo", "the first token of a key decides", ["lua file=a.lua lines=x lines=1-2 file=b.lua"],
    { lang: "lua", file: "a.lua", start: null, end: null, sha: null, hash: null }],
  ["parseFenceInfo", "an empty file= is a plain fence", ["lua file= file=a.lua"], null],

  // dynamicBlocks, blockKey, isOutOfDate, outOfDateBlocks: which copies no longer match.
  ["dynamicBlocks", "dynamic blocks only, a longer fence holding a shorter one", [BLOCKS_MD],
    ["a.lua:2-3", "b.lua"]],
  ["dynamicBlocks", "an unclosed fence is not a block", ["```lua file=a.lua\nx"], []],
  ["isOutOfDate", "the range now hashes to something else", [block("hash=aaa"), { "a.lua:2-3": "bbb" }], true],
  ["isOutOfDate", "the range can't be read", [block("hash=aaa"), { "a.lua:2-3": null }], true],
  ["isOutOfDate", "the range still hashes to its hash", [block("hash=aaa"), { "a.lua:2-3": "aaa" }], false],
  ["isOutOfDate", "a block without a hash can't tell", [block(""), { "a.lua:2-3": "bbb" }], false],
  ["isOutOfDate", "no current hash for the range yet", [block("hash=aaa"), {}], false],
  ["outOfDateBlocks", "per document, cards then messages", [edited((s) => {
    s.cards.fill.body_md = "```lua file=a.lua lines=2-3 hash=aaa\nx\n```";
    s.messages.m2.body_md = "```lua file=b.lua sha=1 hash=ccc\nx\n```\n```lua file=a.lua lines=2-3 hash=bbb\nx\n```";
  }), { "a.lua:2-3": "bbb", "b.lua": null }], [
    { doc: "../../cards/fill.md", card_id: "fill", file: "a.lua", lines: "2-3", hash: "aaa", current: "bbb" },
    { doc: "../../messages/m2.json", card_id: null, file: "b.lua", lines: null, hash: "ccc", current: null },
  ]],

  // parseCard, formatCard, forkedFrom: the card file and what a fork records.
  ["parseCard", "front matter, then the body after one blank line",
    ["---\ntitle: Pass\nkind: term\n---\n\nA walk.\n\nMore.\n"],
    { title: "Pass", kind: "term", body_md: "A walk.\n\nMore.\n" }],
  ["parseCard", "a title holding a colon", ["---\ntitle: Fill: the engine\n---\nBody"],
    { title: "Fill: the engine", body_md: "Body" }],
  ["parseCard", "no front matter", ["# Pass\n\nA walk."], null],
  ["parseCard", "a front matter line that is not key: value", ["---\ntitle Pass\n---\n\nA walk."], null],
  ["formatCard", "fixed field order, one trailing newline",
    [{ body_md: "A walk.\n\n", forked_from: `t-pass@${C1}`, kind: "term", title: "Pass" }],
    `---\ntitle: Pass\nkind: term\nforked_from: t-pass@${C1}\n---\n\nA walk.\n`],
  ["forkedFrom", "card and commit", [{ title: "F", forked_from: `fill@${C1}`, body_md: "" }], { card: "fill", commit: C1 }],
  ["forkedFrom", "a short commit is malformed", [{ title: "F", forked_from: "fill@abc1234", body_md: "" }], null],
  ["forkedFrom", "no fork", [{ title: "F", body_md: "" }], null],

  // parseLink: the deck's two link kinds, web links, and everything refused.
  ["parseLink", "card link", ["card://fill"], { kind: "card", id: "fill" }],
  ["parseLink", "walkthrough section", ["walkthrough://docs/walkthrough.md#2-core-logic"],
    { kind: "walkthrough", path: "docs/walkthrough.md", heading: "2-core-logic" }],
  ["parseLink", "whole walkthrough", ["walkthrough://docs/walkthrough.md"],
    { kind: "walkthrough", path: "docs/walkthrough.md", heading: null }],
  ["parseLink", "web link", ["https://neovim.io"], { kind: "web", href: "https://neovim.io" }],
  ["parseLink", "script link is refused", ["javascript:alert(1)"], null],

  // deckCards, sectionOf, cardsInSection, isTermCard: the deck lists cards; the card says what it is.
  ["deckCards", "main sequence, then each section", [withSections()], ["parser", "fill", "framing", "t-fence", "t-pass"]],
  ["sectionOf", "a card of the main sequence", [withSections(), "parser"], null],
  ["sectionOf", "the section listing a card", [withSections(), "framing"],
    { id: "protocol", title: "Protocol", cards: ["framing"] }],
  ["cardsInSection", "main sequence in order", [withSections(), null], ["parser", "fill"]],
  ["cardsInSection", "term section in order", [withSections(), "terms"], ["t-fence", "t-pass"]],
  ["cardsInSection", "a listed card missing from the library is left out",
    [edited((s) => { s.meta.order.push("gone"); }), null], ["parser", "fill"]],
  ["isTermCard", "a card of kind term", [withSections(), "t-pass"], true],
  ["isTermCard", "a card without a kind", [withSections(), "framing"], false],
  // definitionOf: the first paragraph, however many sentences, with its links.
  ["definitionOf", "the first paragraph of several sentences, links kept",
    [{ title: "Job", body_md: "A unit of work that a [pass](card://t-pass) runs.\nIt waits for its gate.\n\nMore." }],
    "A unit of work that a [pass](card://t-pass) runs.\nIt waits for its gate."],
  ["definitionOf", "a body of one paragraph", [{ title: "Pass", body_md: "A walk over the lines.\n" }],
    "A walk over the lines."],
  ["definitionOf", "an empty body", [{ title: "Gate", body_md: "" }], ""],

  // shownId, cardOf, forkStatus, behindForks: a deck's own copy of a shared card.
  ["shownId", "a card the deck has no fork of", [withFork(), "parser"], "parser"],
  ["shownId", "the deck's fork", [withFork(), "fill"], "fill-doc"],
  ["cardOf", "the fork's text wherever the deck shows the card", [withFork(), "fill"],
    { title: "Fill, for this deck", forked_from: `fill@${C1}`, body_md: "Ours." }],
  ["forkStatus", "the shared card changed since the copy", [withFork(), STORE_MOVED, "fill"],
    { card: "fill", fork: "fill-doc", original: "fill", base: C1, latest: C2, behind: true }],
  ["forkStatus", "the copy is up to date", [withFork(), STORE_SAME, "fill"],
    { card: "fill", fork: "fill-doc", original: "fill", base: C1, latest: C1, behind: false }],
  ["forkStatus", "no history yet can't tell", [withFork(), null, "fill"],
    { card: "fill", fork: "fill-doc", original: "fill", base: C1, latest: null, behind: false }],
  ["forkStatus", "a card that is no fork", [withFork(), STORE_MOVED, "parser"], null],
  ["behindForks", "only forks whose original moved", [withFork(), STORE_MOVED], ["fill"]],
  ["behindForks", "none when every fork is up to date", [withFork(), STORE_SAME], []],

  // conversationOf: the deck keeps one conversation per card, by default its own.
  ["conversationOf", "the default, named after deck and card", [deck(), "parser"], "doc--parser"],
  ["conversationOf", "a conversation the deck names, shared with another deck",
    [edited((s) => { s.meta.conversations = { parser: "other--parser" }; }), "parser"], "other--parser"],

  // head: the newer of the user's choice and the conversation's newest node.
  ["head", "newest node when nothing was chosen", [deck(), "parser"], "n3"],
  ["head", "never compressed", [deck(), "fill"], null],
  ["head", "a choice after the newest node wins", [chose("n1", 30), "parser"], "n1"],
  ["head", "a choice of the start", [chose(null, 30), "parser"], null],
  ["head", "a choice older than the newest node loses", [chose("n1", 21), "parser"], "n3"],
  ["head", "a compress after a choice wins", [edited((s) => {
    s.heads["doc--parser"] = { node: "n1", at: T(30) };
    s.nodes.n4 = { conversation: "doc--parser", parent: "n1", upto: "m5", digest: [], created_at: T(31) };
  }), "parser"], "n4"],
  ["head", "another deck's conversation under the same card is its own",
    [edited((s) => { s.meta.conversations = { parser: "other--parser" }; }), "parser"], null],

  // conversation: the head's digest, then the messages after its upto, in time order.
  ["conversation", "head n3 covers up to m4", [deck(), "parser"],
    { conversation: "doc--parser", head: "n3", digest: ["Why one pass?"], messages: ["m5"] }],
  ["conversation", "never compressed: all messages, no digest", [deck(), "fill"],
    { conversation: "doc--fill", head: null, digest: [], messages: ["f1"] }],
  ["conversation", "undo to n1 shows m3 again", [chose("n1", 30), "parser"],
    { conversation: "doc--parser", head: "n1", digest: ["Why one pass?"], messages: ["m3", "m4", "m5"] }],
  ["conversation", "undo to the start shows every message", [chose(null, 30), "parser"],
    { conversation: "doc--parser", head: null, digest: [], messages: ["m1", "m2", "m3", "m4", "m5"] }],
  ["conversation", "compress input stops at upto", [chose("n1", 30), "parser", { upto: "m4" }],
    { conversation: "doc--parser", head: "n1", digest: ["Why one pass?"], messages: ["m3", "m4"] }],

  // undoTarget and children: moving through the undo tree.
  ["undoTarget", "from n3 to its parent", [deck(), "parser"], { node: "n1" }],
  ["undoTarget", "from the first node to the start", [chose("n1", 30), "parser"], { node: null }],
  ["undoTarget", "nothing to undo", [deck(), "fill"], null],
  ["children", "two branches after n1, oldest first", [deck(), "parser", "n1"], ["n2", "n3"]],
  ["children", "redo from the start", [deck(), "parser", null], ["n1"]],

  // pendingRequests, requestStatus, answerStatus, compressStatus, reconcileStatus.
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
  ["reconcileStatus", "a waiting reconcile", [(() => {
    const s = withFork();
    s.requests.rr = { kind: "reconcile", card_id: "fill", args: { commit: C2 }, created_at: T(40) };
    return s;
  })(), "fill"], { request: "rr", status: "waiting", error: null }],
  ["reconcileStatus", "never asked", [withFork(), "fill"], null],

  // checkDeck, schema: field types, enums, required and unknown fields, ids and times.
  ["checkDeck", "valid deck", [deck()], []],
  ["checkDeck", "settings are valid too", [edited((s) => { s.settings = { nvim_server: "/tmp/x.sock" }; })], []],
  ["checkDeck", "sections are valid", [withSections()], []],
  ["checkDeck", "a fork and its alias are valid", [withFork()], []],
  ["checkDeck", "library cards the deck doesn't list are fine",
    [edited((s) => { s.cards.extra = { title: "Extra", body_md: "" }; })], []],
  ["checkDeck", "section listed twice", [edited((s) => {
    s.meta.sections = [{ id: "a", title: "A", cards: [] }, { id: "a", title: "B", cards: [] }];
  })], ["meta.json: sections lists a twice"]],
  ["checkDeck", "a section without its cards", [edited((s) => { s.meta.sections = [{ id: "a", title: "A" }]; })],
    ["meta.json: sections[0].cards is missing"]],
  ["checkDeck", "card kind outside its enum", [edited((s) => { s.cards.fill.kind = "glossary"; })],
    ["../../cards/fill.md: kind is not one of term"]],
  ["checkDeck", "a card no longer names a section", [edited((s) => { s.cards.fill.section = "terms"; })],
    ["../../cards/fill.md: section is not a known field"]],
  ["checkDeck", "meta is required", [edited((s) => { s.meta = null; })], ["meta.json is missing"]],
  ["checkDeck", "unknown field", [edited((s) => { s.messages.m1.status = "done"; })],
    ["../../messages/m1.json: status is not a known field"]],
  ["checkDeck", "missing field", [edited((s) => { delete s.nodes.n1.created_at; })],
    ["../../nodes/n1.json: created_at is missing"]],
  ["checkDeck", "time not as toISOString prints it",
    [edited((s) => { s.messages.m1.created_at = "2026-11-07T10:00:01Z"; })],
    ["../../messages/m1.json: created_at is not an ISO UTC time"]],
  ["checkDeck", "role outside its enum", [edited((s) => { s.messages.m1.role = "assistant"; })],
    ["../../messages/m1.json: role is not one of user, claude"]],
  ["checkDeck", "digest entry kind outside its enum", [edited((s) => { s.nodes.n1.digest[0].kind = "note"; })],
    ["../../nodes/n1.json: digest[0].kind is not one of question, concept"]],
  ["checkDeck", "nullable field of the wrong type", [edited((s) => { s.nodes.n1.parent = 3; })],
    ["../../nodes/n1.json: parent is not an id or null"]],
  ["checkDeck", "file name that is not an id",
    [edited((s) => { s.messages["bad id"] = { ...s.messages.m5 }; })],
    ["../../messages/bad id.json: file name is not an id"]],
  ["checkDeck", "an alias keyed by something that is not an id",
    [edited((s) => { s.meta.aliases = { "bad id": "fill" }; })],
    ["meta.json: aliases.bad id is not keyed by an id"]],

  // checkDeck, cross-document rules.
  ["checkDeck", "the deck lists a missing card", [edited((s) => { s.meta.order.push("gone"); })],
    ["meta.json: lists missing card gone"]],
  ["checkDeck", "a card listed twice, once in a section", [edited((s) => {
    s.meta.sections = [{ id: "a", title: "A", cards: ["fill"] }];
  })], ["meta.json: lists card fill twice"]],
  ["checkDeck", "an alias to a missing card", [edited((s) => { s.meta.aliases = { fill: "gone" }; })],
    ["meta.json: aliases.fill names missing card gone"]],
  ["checkDeck", "an alias to a card that is not its fork", [edited((s) => { s.meta.aliases = { fill: "parser" }; })],
    ["meta.json: aliases.fill names parser, which is not a fork of fill"]],
  ["checkDeck", "forked_from with a short commit", [edited((s) => { s.cards.fill.forked_from = "parser@abc1234"; })],
    ["../../cards/fill.md: forked_from is not <card>@<full commit hash>"]],
  ["checkDeck", "forked_from a missing card", [edited((s) => { s.cards.fill.forked_from = `gone@${C1}`; })],
    ["../../cards/fill.md: forked_from names missing card gone"]],
  ["checkDeck", "head chooses another conversation's node",
    [edited((s) => { s.heads["doc--fill"] = { node: "n1", at: T(30) }; })],
    ["../../heads/doc--fill.json: node n1 belongs to conversation doc--parser"]],
  ["checkDeck", "node parent does not exist", [edited((s) => { s.nodes.n2.parent = "n9"; })],
    ["../../nodes/n2.json: parent n9 does not exist"]],
  ["checkDeck", "node upto earlier than its parent's", [edited((s) => { s.nodes.n2.upto = "m1"; })],
    ["../../nodes/n2.json: upto m1 is earlier than parent n1's upto m2"]],
  ["checkDeck", "node upto of another conversation", [edited((s) => { s.nodes.n1.upto = "f1"; })],
    ["../../nodes/n1.json: upto f1 is not a message of conversation doc--parser"]],
  ["checkDeck", "digest links a missing card",
    [edited((s) => { s.nodes.n3.digest[0].card_id = "gone"; })],
    ["../../nodes/n3.json: digest links missing card gone"]],
  ["checkDeck", "card body links a missing card",
    [edited((s) => { s.cards.fill.body_md = "See [x](card://gone)."; })],
    ["../../cards/fill.md: body_md links missing card gone"]],
  ["checkDeck", "message links a missing card",
    [edited((s) => { s.messages.m2.body_md = "See <card://gone>."; })],
    ["../../messages/m2.json: body_md links missing card gone"]],
  ["checkDeck", "request for a missing card", [edited((s) => { s.requests.rf.card_id = "gone"; })],
    ["requests/rf.json: card gone does not exist"]],
  ["checkDeck", "request args not the kind's one argument",
    [edited((s) => { s.requests.rc.args = { message: "m4" }; })], ["requests/rc.json: args is not {upto}"]],
  ["checkDeck", "answer request for another conversation's message",
    [edited((s) => { s.requests.r1.args.message = "f1"; })],
    ["requests/r1.json: args.message f1 is not a message of conversation doc--parser"]],
  ["checkDeck", "a reconcile request for the deck's fork", [(() => {
    const s = withFork();
    s.requests.rr = { kind: "reconcile", card_id: "fill", args: { commit: C2 }, created_at: T(40) };
    return s;
  })()], []],
  ["checkDeck", "a reconcile request for a card with no fork, at a short commit", [edited((s) => {
    s.requests.rr = { kind: "reconcile", card_id: "parser", args: { commit: "abc1234" }, created_at: T(40) };
  })], ["requests/rr.json: card parser has no fork in this deck", "requests/rr.json: args.commit is not a full commit hash"]],
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
  conversation: (r) => ({ conversation: r.conversation, head: r.head, digest: r.digest.map((e) => e.text), messages: ids(r.messages) }),
  children: ids,
  pendingRequests: ids,
  behindForks: (forks) => forks.map((f) => f.card),
  dynamicBlocks: (blocks) => blocks.map(S.blockKey),
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
