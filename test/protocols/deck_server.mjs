// Protocol: the local deck server's HTTP interface (deck/server.mjs).
//
// Interface under test: the routes the page calls, against a real server process and a deck
// folder on disk. Every case is one row in CASES, run in order:
//   [description, route, request body (null for GET), fields the JSON reply must have,
//    check(folder) -> problem text or null, for what must be true on disk afterwards]
// The Neovim side of /api/goto is protocol deck_relay.lua; here only its pass-through is checked.
//
// Run: node test/protocols/deck_server.mjs
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "deck-server-"));
const worktree = path.join(tmp, "repo");
const deck = path.join(tmp, "deck");

// A worktree with one committed file, and a deck whose only card holds a stale copy of it.
fs.mkdirSync(worktree);
fs.writeFileSync(path.join(worktree, "a.lua"), "local x = 1\nreturn x\n");
const git = (...args) => execFileSync("git", ["-C", worktree, ...args], { encoding: "utf8" }).trim();
git("init", "-q");
git("add", ".");
git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "fixture");
const sha = git("rev-parse", "--short", "HEAD");
const put = (rel, doc) => {
  fs.mkdirSync(path.dirname(path.join(deck, rel)), { recursive: true });
  fs.writeFileSync(path.join(deck, rel), typeof doc === "string" ? doc : JSON.stringify(doc));
};
put("deck/meta.json", { title: "Fixture", worktree, nvim_server: path.join(tmp, "none.sock"), order: ["c1"] });
put("cards/c1.json", { title: "Card one", head: null, body_md: "Why.\n\n```lua file=a.lua lines=2 sha=0000000\nstale\n```" });

const read = (rel) => JSON.parse(fs.readFileSync(path.join(deck, rel), "utf8"));
const inbox = () => (fs.existsSync(path.join(deck, "inbox.log"))
  ? fs.readFileSync(path.join(deck, "inbox.log"), "utf8").trim().split("\n").map((l) => JSON.parse(l)) : []);
const lastInbox = () => inbox().at(-1) || {};

const CASES = [
  ["state lists the deck's documents", "/api/state", null,
    { "meta.title": "Fixture", "cards.c1.title": "Card one" }, null],

  // Writes: what reaches disk, and which writes wake the Claude session.
  ["user message is saved and wakes Claude", "/api/write",
    { collection: "messages", id: "m1", data: { card_id: "c1", role: "user", body_md: "Why?", status: "pending" } },
    { ok: true }, () => (read("messages/m1.json").body_md === "Why?" && lastInbox().type === "message" && lastInbox().id === "m1"
      ? null : "message file or inbox line missing")],
  ["compress request wakes Claude", "/api/write",
    { collection: "actions", id: "a1", data: { card_id: "c1", kind: "compress", args: { upto: "m1" }, status: "pending" } },
    { ok: true }, () => (lastInbox().type === "compress" && lastInbox().id === "a1" ? null : "no compress line in inbox")],
  ["undo merges head into the card and wakes nobody", "/api/write",
    { collection: "cards", id: "c1", data: { head: "n1" }, merge: true },
    { ok: true }, () => (read("cards/c1.json").title === "Card one" && read("cards/c1.json").head === "n1" && inbox().length === 2
      ? null : "card fields lost or inbox grew")],
  ["unknown collection is refused", "/api/write", { collection: "secrets", id: "x", data: {} },
    { ok: false }, () => (fs.existsSync(path.join(deck, "secrets")) ? "wrote a secrets folder" : null)],
  ["path in an id is refused", "/api/write", { collection: "cards", id: "../../x", data: {} },
    { ok: false }, () => (fs.existsSync(path.join(tmp, "x.json")) ? "wrote outside the deck" : null)],

  // Neovim and git requests the server runs itself.
  ["goto passes the relay's error through", "/api/goto", { file: "a.lua", line: 2 },
    { ok: false }, null],
  ["refresh replaces a stale copy", "/api/refresh", { card_id: "c1" },
    { ok: true, note: `Code copies updated to ${sha}.` },
    () => (read("cards/c1.json").body_md.includes(`sha=${sha}\nreturn x\n`) ? null : "card body not refilled")],
  ["refresh of a current card changes nothing", "/api/refresh", { card_id: "c1" },
    { ok: true, note: `Code copies already match ${sha}.` }, null],
  ["refresh of a missing card", "/api/refresh", { card_id: "gone" },
    { ok: false, error: "That card no longer exists." }, null],

  // A file the agent is still writing is served from its last good copy.
  ["half-written card keeps its last good copy", "/api/state", null,
    { "cards.c1.title": "Card one" }, null, () => put("cards/c1.json", "{\"title\": \"Car")],
];

const server = spawn("node", [path.join(root, "deck/server.mjs"), deck, "0"]);
const url = await new Promise((resolve, reject) => {
  server.stdout.once("data", (d) => resolve(String(d).trim()));
  server.once("exit", () => reject(new Error("server exited")));
});
const get = (obj, dotted) => dotted.split(".").reduce((o, k) => (o == null ? o : o[k]), obj);

let failed = 0;
for (const [description, route, body, expect, check, before] of CASES) {
  if (before) before();
  const res = await fetch(new URL(route, url), body
    ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }
    : {});
  const reply = await res.json();
  const problems = Object.entries(expect)
    .filter(([key, value]) => get(reply, key) !== value)
    .map(([key, value]) => `${key} = ${JSON.stringify(get(reply, key))}, expected ${JSON.stringify(value)}`);
  const disk = check && check();
  if (disk) problems.push(disk);
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
