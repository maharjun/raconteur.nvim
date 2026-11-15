// Protocol: the local deck server's HTTP interface (skill/raconteur-deck/server.mjs).
//
// Interface under test: the routes the page calls, against a real server process and a library
// on disk. Every case is one row in CASES, run in order:
//   [description, route, request body (null for GET), fields the JSON reply must have,
//    check(reply, written) that throws on a problem, before() run first with the row as `this`,
//    returning the card ids it leaves uncommitted]
// `written` lists the library files the case created or changed (outside the card repository's
// .git), so each check names exactly the documents a route writes; decks/fx/inbox.log among
// them means the route woke the agent. After every case the deck must still pass
// DeckState.checkDeck, and every card change must be committed.
// The Neovim side of /api/goto and /api/refresh is protocol deck_relay.lua; here only the
// pass-through is checked.
//
// Run: node test/protocols/deck_server.mjs
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { cardRepo, commitCards, readDeck, readStore, writeDoc } from "../../skill/raconteur-deck/folder.mjs";

const S = globalThis.DeckState;
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "deck-server-"));
const worktree = path.join(tmp, "repo");
const library = path.join(tmp, "library");
const deck = path.join(library, "decks", "fx");
const sock = path.join(tmp, "none.sock");
const T = (second) => new Date(Date.UTC(2026, 0, 1, 10, 0, second)).toISOString();

// A worktree with one committed file, and a deck "fx" of two cards, each compressed once. Card
// c1 holds a stale copy of the file; its m1 is folded into n1 and m2 is live.
fs.mkdirSync(worktree);
fs.writeFileSync(path.join(worktree, "a.lua"), "local x = 1\nreturn x\n");
const git = (repo, ...args) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
git(worktree, "init", "-q");
git(worktree, "add", ".");
git(worktree, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "fixture");
const sha = git(worktree, "rev-parse", "--short", "HEAD");
const branch = git(worktree, "rev-parse", "--abbrev-ref", "HEAD");
const hash = "30239a616d8c"; // content_hash of a.lua's line 2, "return x"
const card = (title, body, extra = "") => `---\ntitle: ${title}\n${extra}---\n\n${body}\n`;
const BASE = {
  "decks/fx/meta.json": { title: "Fixture", worktree, order: ["c1", "c2"] },
  "cards/c1.md": card("Card one", "Why.\n\n```lua file=a.lua lines=2 sha=0000000\nstale\n```"),
  "cards/c2.md": card("Card two", "Other."),
  "messages/m1.json": { conversation: "fx--c1", role: "user", body_md: "Why?", created_at: T(1) },
  "messages/m2.json": { conversation: "fx--c1", role: "claude", body_md: "Speed.", created_at: T(2) },
  "messages/m9.json": { conversation: "fx--c2", role: "user", body_md: "How?", created_at: T(1) },
  "nodes/n1.json": { conversation: "fx--c1", parent: null, upto: "m1", digest: [], created_at: T(3) },
  "nodes/n2.json": { conversation: "fx--c2", parent: null, upto: "m9", digest: [], created_at: T(3) },
};
for (const [relPath, doc] of Object.entries(BASE)) writeDoc(library, relPath, doc);
commitCards(deck, "Add the fixture's cards", { Cause: "authored", Deck: "fx" });
const cards = cardRepo(deck);

const read = (rel) => JSON.parse(fs.readFileSync(path.join(library, rel), "utf8"));
const readCard = (id) => S.parseCard(fs.readFileSync(path.join(cards, `${id}.md`), "utf8"));
const lastInbox = () => JSON.parse(fs.readFileSync(path.join(deck, "inbox.log"), "utf8").trim().split("\n").at(-1));
const lastCommit = () => git(cards, "log", "-1", "--format=%s|%(trailers:only,unfold)");

/** Every file under the library with its content, leaving out the card repository's .git. */
function snapshot(folder = library, prefix = "") {
  return Object.assign({}, ...fs.readdirSync(folder, { withFileTypes: true }).map((entry) => {
    const rel = prefix + entry.name;
    const full = path.join(folder, entry.name);
    if (entry.name === ".git") return {};
    return entry.isDirectory() ? snapshot(full, rel + "/") : { [rel]: fs.readFileSync(full, "utf8") };
  }));
}

/** A check that the case wrote exactly these files; a function entry names a file from the reply. */
const writes = (...files) => (reply, written) =>
  assert.deepEqual(written, files.map((f) => (typeof f === "function" ? f(reply) : f)).sort());
const refused = writes();
const request = (r) => `decks/fx/requests/${r.request}.json`;

// Deck fx's own copy of c2, made at c2's first commit, after which c2 changed: the copy is behind.
let forkBase;
let c2Latest;
function forkC2ThenMoveIt() {
  forkBase = git(cards, "rev-parse", "HEAD");
  fs.writeFileSync(path.join(cards, "c2-fx.md"), card("Card two", "Ours.", `forked_from: c2@${forkBase}\n`));
  writeDoc(deck, "meta.json", { ...BASE["decks/fx/meta.json"], aliases: { c2: "c2-fx" } });
  commitCards(deck, "Fork c2 for fx", { Cause: "edit", Deck: "fx" });
  fs.writeFileSync(path.join(cards, "c2.md"), card("Card two", "Other, and more."));
  c2Latest = commitCards(deck, "Expand c2", { Cause: "edit", Deck: "other" });
}

const CASES = [
  ["state is the deck and library, the worktree's branch, the copies' hashes and the card store",
    "/api/state", null, { deck: "fx", "meta.title": "Fixture", "cards.c1.title": "Card one", settings: null, branch },
    (reply, written) => {
      writes()(reply, written);
      assert.deepEqual(reply.code_hashes, { "a.lua:2-2": hash });
      assert.deepEqual(reply.store.history.c1.map((c) => [c.subject, c.trailers.Cause]),
        [["Add the fixture's cards", "authored"]]);
      assert.deepEqual(reply.store.uncommitted, []);
    }],

  // Writes: the documents each route writes, and which wake the agent through inbox.log.
  ["ask writes the user message in the card's conversation and its answer request, and wakes the agent",
    "/api/ask", { card_id: "c1", body_md: "And?" }, { ok: true }, (reply, written) => {
      const message = (r) => `messages/${r.message}.json`;
      writes("decks/fx/inbox.log", message, request)(reply, written);
      const { at } = lastInbox();
      assert.deepEqual(lastInbox(), { request: reply.request, at });
      assert.deepEqual(read(message(reply)), { conversation: "fx--c1", role: "user", body_md: "And?", created_at: at });
      assert.deepEqual(read(request(reply)),
        { kind: "answer", card_id: "c1", args: { message: reply.message }, created_at: at });
      assert.match(reply.message, /^m-/);
      assert.match(reply.request, /^r-/);
    }],
  ["compress writes a compress request for a live message, and wakes the agent", "/api/compress",
    { card_id: "c1", upto: "m2" }, { ok: true }, (reply, written) => {
      writes("decks/fx/inbox.log", request)(reply, written);
      const { at } = lastInbox();
      assert.deepEqual(lastInbox(), { request: reply.request, at });
      assert.deepEqual(read(request(reply)), { kind: "compress", card_id: "c1", args: { upto: "m2" }, created_at: at });
    }],
  ["head null writes the conversation's head and wakes nobody", "/api/head", { card_id: "c1", node: null },
    { ok: true }, (reply, written) => {
      writes("heads/fx--c1.json")(reply, written);
      assert.deepEqual(read("heads/fx--c1.json"), { node: null, at: read("heads/fx--c1.json").at });
    }],
  ["head to a node of the conversation", "/api/head", { card_id: "c1", node: "n1" },
    { ok: true }, (reply, written) => {
      writes("heads/fx--c1.json")(reply, written);
      assert.equal(read("heads/fx--c1.json").node, "n1");
    }],
  ["settings writes the Neovim server and wakes nobody", "/api/settings", { nvim_server: sock },
    { ok: true }, (reply, written) => {
      writes("decks/fx/settings.json")(reply, written);
      assert.deepEqual(read("decks/fx/settings.json"), { nvim_server: sock });
    }],
  ["state shows the settings", "/api/state", null, { "settings.nvim_server": sock }, writes()],

  // Refusals: nothing is written.
  ["ask to a missing card", "/api/ask", { card_id: "gone", body_md: "?" },
    { ok: false, error: "That card no longer exists." }, refused],
  ["ask with a path for a card id", "/api/ask", { card_id: "../c1", body_md: "?" },
    { ok: false, error: "That card no longer exists." }, refused],
  ["ask with an id every object inherits", "/api/ask", { card_id: "__proto__", body_md: "?" },
    { ok: false, error: "That card no longer exists." }, refused],
  ["ask with an empty message", "/api/ask", { card_id: "c1", body_md: "  " },
    { ok: false, error: "The message is empty." }, refused],
  ["compress up to a message already folded into a node", "/api/compress", { card_id: "c1", upto: "m1" },
    { ok: false, error: "That message is no longer in the conversation." }, refused],
  ["compress up to another conversation's message", "/api/compress", { card_id: "c1", upto: "m9" },
    { ok: false, error: "That message is no longer in the conversation." }, refused],
  ["head to another conversation's node", "/api/head", { card_id: "c1", node: "n2" },
    { ok: false, error: "That point in the history no longer exists." }, refused],
  ["head without a node", "/api/head", { card_id: "c1" },
    { ok: false, error: "That point in the history no longer exists." }, refused],
  ["settings with an empty address", "/api/settings", { nvim_server: "" },
    { ok: false, error: "The Neovim server address is empty." }, refused],
  ["reconcile a card the deck shows unforked", "/api/reconcile", { card_id: "c1" },
    { ok: false, error: "This deck shows the shared card, not a copy of it." }, refused],
  ["diff of a commit outside the card's history", "/api/diff", { card_id: "c1", commit: "0".repeat(40) },
    { ok: false, error: "That commit is not in this card's history." }, refused],
  ["there is no generic write route", "/api/write", { collection: "cards", id: "x", data: {} },
    { ok: false, error: "Not found." }, refused],

  // The relay commands the server runs, with the deck's worktree and Neovim server filled in.
  ["goto passes the relay's result through", "/api/goto", { file: "a.lua", line: 2 },
    { ok: false, error: `Can't reach Neovim at ${sock}. Start it with nvim --listen ${sock}.` }, refused],
  ["refresh refills a stale card through the relay's fill, and commits it", "/api/refresh", { card_id: "c1" },
    { ok: true, note: `Code copies updated to ${sha}.` }, (reply, written) => {
      writes("cards/c1.md")(reply, written);
      assert.equal(readCard("c1").title, "Card one");
      assert.ok(readCard("c1").body_md.includes(`sha=${sha} hash=${hash}\nreturn x\n`), "card body not refilled");
      assert.equal(lastCommit(), `Refill the code copies of c1 at ${sha}|Cause: refill\nDeck: fx\nCard: c1`);
    }],
  ["refresh of a current card writes nothing", "/api/refresh", { card_id: "c1" },
    { ok: true, note: `Code copies already match ${sha}.` }, writes()],
  ["refresh of a missing card", "/api/refresh", { card_id: "gone" },
    { ok: false, error: "That card no longer exists." }, refused],
  ["diff of a card's commit", "/api/diff", { card_id: "c1" }, { ok: true }, (reply, written) => {
    writes()(reply, written);
    assert.match(reply.diff, /^-stale$/m);
    assert.match(reply.diff, /^\+return x$/m);
  }, function () { this[2].commit = git(cards, "rev-parse", "HEAD"); }],

  // A deck's fork of a shared card.
  ["state shows the fork wherever the deck shows the card", "/api/state", null,
    { "meta.aliases.c2": "c2-fx", "cards.c2-fx.body_md": "Ours.\n" }, (reply, written) => {
      writes()(reply, written);
      assert.deepEqual(S.forkStatus(reply, reply.store, "c2"),
        { card: "c2", fork: "c2-fx", original: "c2", base: forkBase, latest: c2Latest, behind: true });
    }, forkC2ThenMoveIt],
  ["reconcile asks the agent to bring the fork up to the original's newest commit", "/api/reconcile",
    { card_id: "c2" }, { ok: true }, (reply, written) => {
      writes("decks/fx/inbox.log", request)(reply, written);
      const { at } = lastInbox();
      assert.deepEqual(read(request(reply)), { kind: "reconcile", card_id: "c2", args: { commit: c2Latest }, created_at: at });
    }],
  ["reconcile of a fork that matches its original", "/api/reconcile", { card_id: "c2" },
    { ok: false, error: "This deck's copy already matches the shared card." }, refused, () => {
      const fork = readCard("c2-fx");
      fs.writeFileSync(path.join(cards, "c2-fx.md"), S.formatCard({ ...fork, forked_from: `c2@${c2Latest}` }));
      commitCards(deck, "Reconcile c2-fx", { Cause: "edit", Deck: "fx" });
    }],

  // A file the agent is still writing is served from its last good copy.
  ["half-written card keeps its last good copy", "/api/state", null,
    { "cards.c1.title": "Card one" }, writes(),
    () => {
      fs.writeFileSync(path.join(cards, "c1.md"), "---\ntitle: Car");
      return ["c1"];
    }],
];

// The server runs from an installed copy of the skill whose raconteur-path names this checkout.
const skill = path.join(tmp, "skill");
fs.cpSync(path.join(root, "skill/raconteur-deck"), skill, { recursive: true });
fs.writeFileSync(path.join(skill, "raconteur-path"), root + "\n");
const server = spawn("node", [path.join(skill, "server.mjs"), deck, "0"]);
const url = await new Promise((resolve, reject) => {
  server.stdout.once("data", (d) => resolve(String(d).trim()));
  server.once("exit", () => reject(new Error("server exited")));
});
const get = (obj, dotted) => dotted.split(".").reduce((o, k) => (o == null ? o : o[k]), obj);
const lastGood = new Map();

let failed = 0;
for (const row of CASES) {
  const [description, route, body, expect, check, before] = row;
  const dirty = (before && before.call(row)) || [];
  const was = snapshot();
  const res = await fetch(new URL(route, url), body
    ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }
    : {});
  const reply = await res.json();
  const now = snapshot();
  const written = Object.keys(now).filter((rel) => now[rel] !== was[rel]).sort();
  const problems = Object.entries(expect)
    .filter(([key, value]) => get(reply, key) !== value)
    .map(([key, value]) => `${key} = ${JSON.stringify(get(reply, key))}, expected ${JSON.stringify(value)}`);
  const valid = () => assert.deepEqual(S.checkDeck(readDeck(deck, { lastGood })), []);
  const committed = () => assert.deepEqual(readStore(deck).uncommitted, dirty);
  for (const run of [() => check(reply, written), valid, committed]) {
    try { run(); } catch (e) { problems.push(e.message.split("\n").join("\n     ")); }
  }
  if (problems.length) {
    failed += 1;
    console.log(`FAIL ${description}\n     ${problems.join("\n     ")}`);
  } else {
    console.log(`ok   ${description}`);
  }
}
server.kill();
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`${CASES.length - failed}/${CASES.length} passed`);
process.exit(failed ? 1 : 0);
