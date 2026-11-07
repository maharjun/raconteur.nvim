// Protocol: the local deck server's HTTP interface (deck/server.mjs).
//
// Interface under test: the routes the page calls, against a real server process and a deck
// folder on disk. Every case is one row in CASES, run in order:
//   [description, route, request body (null for GET), fields the JSON reply must have,
//    check(reply, written) that throws on a problem, before() run first]
// `written` lists the deck files the case created or changed, so each check names exactly the
// documents a route writes; inbox.log among them means the route woke the agent. After every
// case the deck must still pass DeckState.checkDeck.
// The Neovim side of /api/goto and /api/refresh is protocol deck_relay.lua; here only the
// pass-through is checked.
//
// Run: node test/protocols/deck_server.mjs
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readDeck, writeDoc } from "../../deck/folder.mjs";

const S = globalThis.DeckState;
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "deck-server-"));
const worktree = path.join(tmp, "repo");
const deck = path.join(tmp, "deck");
const sock = path.join(tmp, "none.sock");
const T = (second) => new Date(Date.UTC(2026, 0, 1, 10, 0, second)).toISOString();

// A worktree with one committed file, and a deck of two cards, each compressed once. Card c1
// holds a stale copy of the file; its m1 is folded into n1 and m2 is live.
fs.mkdirSync(worktree);
fs.writeFileSync(path.join(worktree, "a.lua"), "local x = 1\nreturn x\n");
const git = (...args) => execFileSync("git", ["-C", worktree, ...args], { encoding: "utf8" }).trim();
git("init", "-q");
git("add", ".");
git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "fixture");
const sha = git("rev-parse", "--short", "HEAD");
const branch = git("rev-parse", "--abbrev-ref", "HEAD");
const BASE = {
  "meta.json": { title: "Fixture", worktree, order: ["c1", "c2"] },
  "cards/c1.json": { title: "Card one", body_md: "Why.\n\n```lua file=a.lua lines=2 sha=0000000\nstale\n```" },
  "cards/c2.json": { title: "Card two", body_md: "Other." },
  "messages/m1.json": { card_id: "c1", role: "user", body_md: "Why?", created_at: T(1) },
  "messages/m2.json": { card_id: "c1", role: "claude", body_md: "Speed.", created_at: T(2) },
  "messages/m9.json": { card_id: "c2", role: "user", body_md: "How?", created_at: T(1) },
  "nodes/n1.json": { card_id: "c1", parent: null, upto: "m1", digest: [], created_at: T(3) },
  "nodes/n2.json": { card_id: "c2", parent: null, upto: "m9", digest: [], created_at: T(3) },
};
for (const [relPath, doc] of Object.entries(BASE)) writeDoc(deck, relPath, doc);

const read = (rel) => JSON.parse(fs.readFileSync(path.join(deck, rel), "utf8"));
const lastInbox = () => JSON.parse(fs.readFileSync(path.join(deck, "inbox.log"), "utf8").trim().split("\n").at(-1));

/** Every file under the deck folder with its content. */
function snapshot(folder = deck, prefix = "") {
  return Object.assign({}, ...fs.readdirSync(folder, { withFileTypes: true }).map((entry) => {
    const rel = prefix + entry.name;
    const full = path.join(folder, entry.name);
    return entry.isDirectory() ? snapshot(full, rel + "/") : { [rel]: fs.readFileSync(full, "utf8") };
  }));
}

/** A check that the case wrote exactly these files; a function entry names a file from the reply. */
const writes = (...files) => (reply, written) =>
  assert.deepEqual(written, files.map((f) => (typeof f === "function" ? f(reply) : f)).sort());
const refused = writes();

const CASES = [
  ["state is the deck plus the worktree's branch", "/api/state", null,
    { "meta.title": "Fixture", "cards.c1.title": "Card one", settings: null, branch }, writes()],

  // Writes: the documents each route writes, and which wake the agent through inbox.log.
  ["ask writes the user message and its answer request, and wakes the agent", "/api/ask",
    { card_id: "c1", body_md: "And?" }, { ok: true }, (reply, written) => {
      const message = (r) => `messages/${r.message}.json`;
      writes("inbox.log", message, (r) => `requests/${r.request}.json`)(reply, written);
      const { at } = lastInbox();
      assert.deepEqual(lastInbox(), { request: reply.request, at });
      assert.deepEqual(read(message(reply)), { card_id: "c1", role: "user", body_md: "And?", created_at: at });
      assert.deepEqual(read(`requests/${reply.request}.json`),
        { kind: "answer", card_id: "c1", args: { message: reply.message }, created_at: at });
      assert.match(reply.message, /^m-/);
      assert.match(reply.request, /^r-/);
    }],
  ["compress writes a compress request for a live message, and wakes the agent", "/api/compress",
    { card_id: "c1", upto: "m2" }, { ok: true }, (reply, written) => {
      writes("inbox.log", (r) => `requests/${r.request}.json`)(reply, written);
      const { at } = lastInbox();
      assert.deepEqual(lastInbox(), { request: reply.request, at });
      assert.deepEqual(read(`requests/${reply.request}.json`),
        { kind: "compress", card_id: "c1", args: { upto: "m2" }, created_at: at });
    }],
  ["head null writes the card's head and wakes nobody", "/api/head", { card_id: "c1", node: null },
    { ok: true }, (reply, written) => {
      writes("heads/c1.json")(reply, written);
      assert.deepEqual(read("heads/c1.json"), { node: null, at: read("heads/c1.json").at });
    }],
  ["head to a node of the card", "/api/head", { card_id: "c1", node: "n1" },
    { ok: true }, (reply, written) => {
      writes("heads/c1.json")(reply, written);
      assert.equal(read("heads/c1.json").node, "n1");
    }],
  ["settings writes the Neovim server and wakes nobody", "/api/settings", { nvim_server: sock },
    { ok: true }, (reply, written) => {
      writes("settings.json")(reply, written);
      assert.deepEqual(read("settings.json"), { nvim_server: sock });
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
  ["compress up to another card's message", "/api/compress", { card_id: "c1", upto: "m9" },
    { ok: false, error: "That message is no longer in the conversation." }, refused],
  ["head to another card's node", "/api/head", { card_id: "c1", node: "n2" },
    { ok: false, error: "That point in the history no longer exists." }, refused],
  ["head without a node", "/api/head", { card_id: "c1" },
    { ok: false, error: "That point in the history no longer exists." }, refused],
  ["settings with an empty address", "/api/settings", { nvim_server: "" },
    { ok: false, error: "The Neovim server address is empty." }, refused],
  ["there is no generic write route", "/api/write", { collection: "cards", id: "x", data: {} },
    { ok: false, error: "Not found." }, refused],

  // The relay commands the server runs, with the deck's worktree and Neovim server filled in.
  ["goto passes the relay's result through", "/api/goto", { file: "a.lua", line: 2 },
    { ok: false, error: `Can't reach Neovim at ${sock}. Start it with nvim --listen ${sock}.` }, refused],
  ["refresh refills a stale card through the relay's fill", "/api/refresh", { card_id: "c1" },
    { ok: true, note: `Code copies updated to ${sha}.` }, (reply, written) => {
      writes("cards/c1.json")(reply, written);
      assert.equal(read("cards/c1.json").title, "Card one");
      assert.ok(read("cards/c1.json").body_md.includes(`sha=${sha}\nreturn x\n`), "card body not refilled");
    }],
  ["refresh of a current card writes nothing", "/api/refresh", { card_id: "c1" },
    { ok: true, note: `Code copies already match ${sha}.` }, writes()],
  ["refresh of a missing card", "/api/refresh", { card_id: "gone" },
    { ok: false, error: "That card no longer exists." }, refused],

  // A file the agent is still writing is served from its last good copy.
  ["half-written card keeps its last good copy", "/api/state", null,
    { "cards.c1.title": "Card one" }, writes(),
    () => fs.writeFileSync(path.join(deck, "cards/c1.json"), "{\"title\": \"Car")],
];

const server = spawn("node", [path.join(root, "deck/server.mjs"), deck, "0"]);
const url = await new Promise((resolve, reject) => {
  server.stdout.once("data", (d) => resolve(String(d).trim()));
  server.once("exit", () => reject(new Error("server exited")));
});
const get = (obj, dotted) => dotted.split(".").reduce((o, k) => (o == null ? o : o[k]), obj);
const lastGood = new Map();

let failed = 0;
for (const [description, route, body, expect, check, before] of CASES) {
  if (before) before();
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
  for (const run of [() => check(reply, written), valid]) {
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
