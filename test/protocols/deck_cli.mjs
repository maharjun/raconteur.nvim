// Protocol: the deck folder and its library (skill/raconteur-deck/folder.mjs), and the agent's
// CLI (skill/raconteur-deck/deck.mjs).
//
// Interface under test: readDeck, writeDoc and the card repository on a real library, and the
// CLI's output and exit code. Every case is one row in CASES: [description, files, run,
// expected], where `files` (paths relative to the library) are written over a fresh copy of the
// base library (null deletes one), the cards are committed, and `run(dir)` gets the deck folder
// `<library>/decks/doc` and returns the result to compare.
//
// Run: node test/protocols/deck_cli.mjs
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { cardRepo, commitCards, readDeck, readStore, writeDoc } from "../../skill/raconteur-deck/folder.mjs";

const CLI = fileURLToPath(new URL("../../skill/raconteur-deck/deck.mjs", import.meta.url));
const T = (second) => new Date(Date.UTC(2026, 10, 7, 10, 0, second)).toISOString();
const card = (title, body, extra = "") => `---\ntitle: ${title}\n${extra}---\n\n${body}\n`;
const CONV = "doc--parser";

// One card compressed once (n1 covers m1-m2); m3 is waiting for its answer.
const BASE = {
  "decks/doc/meta.json": { title: "Parser", worktree: "/work/repo", order: ["parser"] },
  "cards/parser.md": card("Parser", "One pass."),
  "messages/m1.json": { conversation: CONV, role: "user", body_md: "Why?", created_at: T(1) },
  "messages/m2.json": { conversation: CONV, role: "claude", body_md: "Speed.", created_at: T(2) },
  "messages/m3.json": { conversation: CONV, role: "user", body_md: "And?", created_at: T(3) },
  "nodes/n1.json": { conversation: CONV, parent: null, upto: "m2", created_at: T(4),
    digest: [{ kind: "question", text: "Why one pass?", card_id: "parser" }] },
  "decks/doc/requests/r1.json": { kind: "answer", card_id: "parser", args: { message: "m1" }, created_at: T(1) },
  "decks/doc/requests/r3.json": { kind: "answer", card_id: "parser", args: { message: "m3" }, created_at: T(3) },
  "decks/doc/results/r1.json": { status: "done", created_at: T(2) },
};

function cli(...args) {
  return (dir) => {
    const run = spawnSync(process.execPath, [CLI, dir, ...args], { encoding: "utf8" });
    return { code: run.status, out: run.stdout || run.stderr };
  };
}

const json = (run) => (dir) => {
  const { code, out } = run(dir);
  return { code, out: JSON.parse(out) };
};

const git = (dir, ...args) => spawnSync("git", ["-C", cardRepo(dir), ...args], { encoding: "utf8" }).stdout.trim();
const editCard = (dir, id, text) => fs.writeFileSync(path.join(cardRepo(dir), `${id}.md`), text);
const subjects = (dir) => git(dir, "log", "--format=%s").split("\n");

// The library folder doubles as its worktree. e35e7ae8597a is the hash of src.lua's lines 2-3,
// the value test/protocols/deck_relay.lua expects fill to stamp; 000000000000 matches nothing.
const inWorktree = (run) => (dir) => {
  const lib = path.resolve(dir, "..", "..");
  fs.writeFileSync(path.join(lib, "src.lua"), "local a = 1\nlocal b = 2\nlocal c = 3\n");
  writeDoc(dir, "meta.json", { ...BASE["decks/doc/meta.json"], worktree: lib });
  return run(dir);
};
const STALE = {
  "cards/parser.md": card("Parser", [
    "```lua file=src.lua lines=2-3 hash=e35e7ae8597a", "x", "```",
    "```lua file=src.lua lines=1-2 hash=000000000000", "x", "```",
    "```lua file=gone.lua hash=000000000000", "x", "```",
    "```lua file=src.lua lines=1", "x", "```"].join("\n")),
  "messages/m2.json": { ...BASE["messages/m2.json"], body_md: "```lua file=src.lua lines=2-3 hash=000000000000\nx\n```" },
};
const STALE_CARD = [
  { doc: "../../cards/parser.md", card_id: "parser", file: "src.lua", lines: "1-2", hash: "000000000000", current: "a3c6f56a051f" },
  { doc: "../../cards/parser.md", card_id: "parser", file: "gone.lua", lines: null, hash: "000000000000", current: null },
];
const STALE_OUT = [...STALE_CARD,
  { doc: "../../messages/m2.json", card_id: null, file: "src.lua", lines: "2-3", hash: "000000000000", current: "e35e7ae8597a" },
];

// A deck "doc" whose fork of parser was made at the base commit, after which parser changed.
const forkedThenMoved = (dir) => {
  cli("fork", "parser", "parser-doc")(dir);
  cli("commit", "Fork parser for doc")(dir);
  editCard(dir, "parser", card("Parser", "Two passes."));
  cli("commit", "Rewrite parser")(dir);
};

const CASES = [
  // readDeck and writeDoc.
  ["readDeck reads the deck and its library; absent singletons are null", {}, (dir) => {
    const s = readDeck(dir);
    return [s.deck, s.meta.title, s.settings, s.cards.parser, Object.keys(s.messages), Object.keys(s.heads), s.unreadable];
  }, ["doc", "Parser", null, { title: "Parser", body_md: "One pass.\n" }, ["m1", "m2", "m3"], [], []]],
  ["readDeck ignores temp files", { "messages/m4.json.123.tmp": "{", "cards/x.md.123.tmp": "---" },
    (dir) => [Object.keys(readDeck(dir).messages), Object.keys(readDeck(dir).cards)], [["m1", "m2", "m3"], ["parser"]]],
  ["readDeck lists an unparseable file it has no copy of", { "messages/m3.json": "{", "cards/bad.md": "no front matter" }, (dir) => {
    const s = readDeck(dir, { lastGood: new Map() });
    return [Object.keys(s.messages), s.unreadable];
  }, [["m1", "m2"], ["../../cards/bad.md", "../../messages/m3.json"]]],
  ["readDeck serves an unparseable file from its last good copy", {}, (dir) => {
    const lastGood = new Map();
    readDeck(dir, { lastGood });
    fs.writeFileSync(path.join(dir, "../../messages/m3.json"), "{");
    const s = readDeck(dir, { lastGood });
    return [s.messages.m3.body_md, s.unreadable];
  }, ["And?", []]],
  ["writeDoc replaces a whole document, JSON or text", {}, (dir) => {
    writeDoc(dir, "settings.json", { nvim_server: "/tmp/x.sock" });
    writeDoc(dir, "../../heads/doc--parser.json", { node: null, at: T(9) });
    writeDoc(dir, "../../cards/parser.md", card("Parser", "Rewritten."));
    const s = readDeck(dir);
    return [s.settings, s.heads["doc--parser"], s.cards.parser.body_md, fs.readdirSync(dir).filter((f) => f.endsWith(".tmp"))];
  }, [{ nvim_server: "/tmp/x.sock" }, { node: null, at: T(9) }, "Rewritten.\n", []]],

  // The card repository.
  ["readStore: each card's commits, newest first, with trailers", {}, (dir) => {
    editCard(dir, "parser", card("Parser", "Two passes."));
    commitCards(dir, "Rewrite parser", { Cause: "edit", Deck: "doc" });
    const { history, uncommitted } = readStore(dir);
    return [history.parser.map((c) => [c.subject, c.trailers, /^[0-9a-f]{40}$/.test(c.commit)]), uncommitted];
  }, [[["Rewrite parser", { Cause: "edit", Deck: "doc" }, true],
    ["Add cards", { Cause: "authored", Deck: "doc" }, true]], []]],
  ["readStore: new and edited card files are uncommitted", {}, (dir) => {
    editCard(dir, "parser", card("Parser", "Two passes."));
    editCard(dir, "lexer", card("Lexer", "Tokens."));
    return readStore(dir).uncommitted;
  }, ["lexer", "parser"]],
  ["readStore: a library without a repository has every card uncommitted", {}, (dir) => {
    fs.rmSync(path.join(cardRepo(dir), ".git"), { recursive: true });
    return readStore(dir);
  }, { history: {}, uncommitted: ["parser"] }],
  ["commitCards: nothing to commit is null", {}, (dir) => commitCards(dir, "Nothing", { Cause: "edit" }), null],
  ["commitCards: an unknown cause is refused", {}, (dir) => {
    try {
      commitCards(dir, "x", { Cause: "whim" });
    } catch (e) {
      return e.message;
    }
    return "committed";
  }, "Cause must be one of authored, edit, refill, answer, compress, reconcile"],

  // check.
  ["check: valid deck", {}, cli("check"), { code: 0, out: "deck is valid\n" }],
  ["check: problems one per line, then the count", { "messages/m1.json": {
    ...BASE["messages/m1.json"], status: "done" } }, cli("check"),
  { code: 1, out: "../../messages/m1.json: status is not a known field\n1 problems\n" }],
  ["check: an unparseable file is a problem", { "decks/doc/results/r1.json": "{" }, cli("check"),
    { code: 1, out: "results/r1.json is not valid JSON\n1 problems\n" }],
  ["check: a card file without front matter is a problem", { "cards/bad.md": "Body" }, cli("check"),
    { code: 1, out: "../../cards/bad.md has no front matter between --- lines\n1 problems\n" }],
  ["check: a card change not committed is a problem", {}, (dir) => {
    editCard(dir, "parser", card("Parser", "Two passes."));
    return cli("check")(dir);
  }, { code: 1, out: "../../cards/parser.md: has changes that are not committed\n1 problems\n" }],
  ["check: a deck without meta.json", { "decks/doc/meta.json": null }, cli("check"),
    { code: 1, out: "meta.json is missing\n1 problems\n" }],

  // pending.
  ["pending: requests without a result, oldest first", { "decks/doc/results/r1.json": null }, json(cli("pending")),
    { code: 0, out: [
      { id: "r1", ...BASE["decks/doc/requests/r1.json"] }, { id: "r3", ...BASE["decks/doc/requests/r3.json"] }] }],

  // conversation.
  ["conversation: digest of the head, then later messages", {}, json(cli("conversation", "parser")),
    { code: 0, out: { card: "parser", file: "../../cards/parser.md", title: "Parser", conversation: CONV, head: "n1",
      digest: BASE["nodes/n1.json"].digest, messages: [{ id: "m3", ...BASE["messages/m3.json"] }],
      stale: [], fork: null } }],
  ["conversation --upto: the compress input", { "heads/doc--parser.json": { node: null, at: T(9) } },
    json(cli("conversation", "parser", "--upto", "m2")),
    { code: 0, out: { card: "parser", file: "../../cards/parser.md", title: "Parser", conversation: CONV, head: null,
      digest: [], messages: [{ id: "m1", ...BASE["messages/m1.json"] }, { id: "m2", ...BASE["messages/m2.json"] }],
      stale: [], fork: null } }],
  ["conversation: lists the card's out-of-date copies", STALE,
    (dir) => inWorktree(json(cli("conversation", "parser")))(dir).out.stale, STALE_CARD],
  ["conversation: a fork names its file and how far behind it is", {}, (dir) => {
    forkedThenMoved(dir);
    const { out } = json(cli("conversation", "parser"))(dir);
    return [out.file, out.title, out.fork.fork, out.fork.behind, out.fork.base === out.fork.latest];
  }, ["../../cards/parser-doc.md", "Parser", "parser-doc", true, false]],
  ["conversation: unknown card", {}, cli("conversation", "gone"), { code: 1, out: "no card gone\n" }],
  ["conversation --upto: not a live message of the card", {}, cli("conversation", "parser", "--upto", "m9"),
    { code: 1, out: "m9 is not a live message of card parser's conversation\n" }],

  // stale.
  ["stale: copies whose lines changed or can't be read, per document", STALE,
    inWorktree(json(cli("stale"))), { code: 0, out: { code: STALE_OUT, forks: [] } }],
  ["stale: none when every copy matches", {}, inWorktree(json(cli("stale"))), { code: 0, out: { code: [], forks: [] } }],
  // a2bd1fff2786 is lua/raconteur/utils.lua content_hash({ "x\r", "é" }).
  ["stale: hashes bytes as Lua does, carriage returns and UTF-8 included", {
    "cards/parser.md": card("Parser", "```txt file=crlf.txt hash=a2bd1fff2786\nx\n```"),
  }, inWorktree((dir) => {
    fs.writeFileSync(path.resolve(dir, "../../crlf.txt"), "x\r\né\n");
    return json(cli("stale"))(dir);
  }), { code: 0, out: { code: [], forks: [] } }],
  ["stale: a fork whose original changed since the copy", {}, (dir) => {
    forkedThenMoved(dir);
    return json(cli("stale"))(dir).out.forks.map((f) => [f.card, f.fork, f.behind]);
  }, [["parser", "parser-doc", true]]],

  // commit.
  ["commit: every card change, with the cause and deck as trailers", {}, (dir) => {
    editCard(dir, "parser", card("Parser", "Two passes."));
    const { out } = json(cli("commit", "Rewrite parser"))(dir);
    return [/^[0-9a-f]{40}$/.test(out.commit), git(dir, "log", "-1", "--format=%s|%(trailers:only,unfold)")];
  }, [true, "Rewrite parser|Cause: edit\nDeck: doc"]],
  ["commit --request: the request's kind, card and conversation", {}, (dir) => {
    editCard(dir, "parser", card("Parser", "Two passes."));
    cli("commit", "Answer r3", "--request", "r3")(dir);
    return git(dir, "log", "-1", "--format=%(trailers:only,unfold)");
  }, "Cause: answer\nDeck: doc\nRequest: r3\nCard: parser\nConversation: doc--parser"],
  ["commit --request: a compress names its node", {
    "decks/doc/requests/rc.json": { kind: "compress", card_id: "parser", args: { upto: "m2" }, created_at: T(5) },
  }, (dir) => {
    editCard(dir, "parser", card("Parser", "Two passes."));
    cli("commit", "Compress", "--request", "rc")(dir);
    return git(dir, "log", "-1", "--format=%(trailers:only,unfold)");
  }, "Cause: compress\nDeck: doc\nRequest: rc\nCard: parser\nConversation: doc--parser\nNode: n-rc"],
  ["commit: nothing to commit prints null", {}, json(cli("commit", "Nothing")), { code: 0, out: { commit: null } }],
  ["commit --cause: only the causes a person's edit can have", {}, (dir) => cli("commit", "x", "--cause", "answer")(dir).code, 1],
  ["commit --request: unknown request", {}, cli("commit", "x", "--request", "r9"), { code: 1, out: "no request r9\n" }],

  // fork.
  ["fork: copies the card, records its commit, and aliases it in this deck", {}, (dir) => {
    const { out } = json(cli("fork", "parser", "parser-doc"))(dir);
    const s = readDeck(dir);
    return [out.file, out.base === git(dir, "rev-parse", "HEAD"), s.cards["parser-doc"].forked_from === `parser@${out.base}`,
      s.meta.aliases, s.cards["parser-doc"].body_md];
  }, ["../../cards/parser-doc.md", true, true, { parser: "parser-doc" }, "One pass.\n"]],
  ["fork: a forked deck is valid once the copy is committed", {}, (dir) => {
    cli("fork", "parser", "parser-doc")(dir);
    cli("commit", "Fork parser")(dir);
    return cli("check")(dir);
  }, { code: 0, out: "deck is valid\n" }],
  ["fork: a card id already taken", {}, (dir) => {
    editCard(dir, "lexer", card("Lexer", "Tokens."));
    cli("commit", "Add lexer")(dir);
    return cli("fork", "parser", "lexer")(dir);
  }, { code: 1, out: "lexer is not a free card id\n" }],
  ["fork: a card with uncommitted changes", {}, (dir) => {
    editCard(dir, "parser", card("Parser", "Two passes."));
    return cli("fork", "parser", "parser-doc")(dir);
  }, { code: 1, out: "commit parser before forking it\n" }],
  ["fork: a card the deck already forked", {}, (dir) => {
    forkedThenMoved(dir);
    return cli("fork", "parser", "parser-2")(dir);
  }, { code: 1, out: "this deck already shows parser-doc for parser\n" }],

  // history.
  ["history: the commits of the card the deck shows", {}, (dir) => {
    forkedThenMoved(dir);
    const { out } = json(cli("history", "parser"))(dir);
    return [out.file, out.commits.map((c) => c.subject)];
  }, ["../../cards/parser-doc.md", ["Fork parser for doc"]]],
  ["history: a card never forked", {}, (dir) => {
    editCard(dir, "parser", card("Parser", "Two passes."));
    cli("commit", "Rewrite parser")(dir);
    return [json(cli("history", "parser"))(dir).out.commits.map((c) => c.subject), subjects(dir)];
  }, [["Rewrite parser", "Add cards"], ["Rewrite parser", "Add cards"]]],
  ["unknown command prints usage", {}, (dir) => cli("compress")(dir).code, 1],
];

let failed = 0;
for (const [description, files, run, expected] of CASES) {
  const lib = fs.mkdtempSync(path.join(os.tmpdir(), "deck-cli-"));
  const dir = path.join(lib, "decks", "doc");
  for (const [relPath, data] of Object.entries({ ...BASE, ...files })) {
    if (data !== null) writeDoc(lib, relPath, data);
  }
  fs.mkdirSync(dir, { recursive: true });
  commitCards(dir, "Add cards", { Cause: "authored", Deck: "doc" });
  let result;
  try {
    result = run(dir);
    assert.deepEqual(result, expected);
    console.log(`ok   ${description}`);
  } catch (e) {
    failed += 1;
    console.log(`FAIL ${description}\n     expected ${JSON.stringify(expected)}\n     got      ${JSON.stringify(result ?? e.message)}`);
  }
  fs.rmSync(lib, { recursive: true, force: true });
}
console.log(`${CASES.length - failed}/${CASES.length} passed`);
process.exit(failed ? 1 : 0);
