// Local deck server: serves the page and turns each page action into whole-document writes in
// the deck folder. It is the only writer of settings, heads, user messages, requests and
// inbox.log; the agent writes everything else (see the @typedefs in state.js).
//
//   node server.mjs <deck-dir> [port]       prints the page's URL
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { readDeck, writeDoc } from "./folder.mjs";

const S = globalThis.DeckState;
const HERE = path.dirname(fileURLToPath(import.meta.url));
const RELAY = path.join(HERE, "relay.lua");
const STATIC = { "/": ["page.html", "text/html"], "/state.js": ["state.js", "text/javascript"] };

const dir = path.resolve(process.argv[2] || "");
const port = Number(process.argv[3] || 0);
if (!process.argv[2] || !fs.existsSync(dir)) {
  console.error("usage: node server.mjs <deck-dir> [port]");
  process.exit(1);
}

/** Kept across reads, so a document caught mid-write by the agent is served from its last good
 *  copy. */
const lastGood = new Map();
const readState = () => readDeck(dir, { lastGood });

/** Ids the server makes: a prefix, then base36 time and randomness, so they sort roughly by
 *  creation and never collide within a deck. */
function newId(prefix) {
  return prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

/** A sentence the page shows the user as the reason a request was refused. */
function refuse(sentence) {
  throw new Error(sentence);
}

/** The card a request names, refused unless it is an existing card. */
function cardOf(state, cardId) {
  if (typeof cardId !== "string" || !S.ID.test(cardId) || !Object.hasOwn(state.cards, cardId)) {
    refuse("That card no longer exists.");
  }
  return cardId;
}

/** The worktree the deck explains, which every git and Neovim request runs against. */
function worktreeOf(state) {
  if (!state.meta || typeof state.meta.worktree !== "string") {
    refuse("The deck has no worktree yet.");
  }
  return state.meta.worktree;
}

/** Writes a request for the agent and wakes it with one inbox line, the only kind of line
 *  inbox.log holds. */
function createRequest(kind, cardId, arg, at) {
  const id = newId("r-");
  const args = { [S.REQUEST_ARG[kind]]: arg };
  writeDoc(dir, S.docPath("requests", id), { kind, card_id: cardId, args, created_at: at });
  fs.appendFileSync(path.join(dir, "inbox.log"), JSON.stringify({ request: id, at }) + "\n");
  return id;
}

/** Runs one relay command (relay.lua) with its JSON request; resolves to its JSON result. */
function relay(command, request) {
  return new Promise((resolve) => {
    const child = spawn("nvim", ["-l", RELAY, command]);
    let out = "";
    child.stdout.on("data", (d) => { out += d; });
    child.on("error", (e) => resolve({ ok: false, error: "Couldn't run Neovim: " + e.message }));
    child.on("close", () => {
      try {
        resolve(JSON.parse(out));
      } catch {
        resolve({ ok: false, error: "The relay printed no result." });
      }
    });
    child.stdin.end(JSON.stringify(request));
  });
}

/** The deck as the page draws it, plus the worktree's current branch (null when git can't
 *  say), read live so it is never stale. */
function getState() {
  const state = readState();
  const worktree = state.meta && state.meta.worktree;
  const git = worktree
    && spawnSync("git", ["-C", worktree, "rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf8" });
  return { ...state, branch: git && git.status === 0 ? git.stdout.trim() : null };
}

/** Saves the user's question and asks the agent to answer it; the message is written before
 *  its request, so the agent never sees a request for a missing message. */
function ask({ card_id, body_md }) {
  const cardId = cardOf(readState(), card_id);
  if (typeof body_md !== "string" || !body_md.trim()) refuse("The message is empty.");
  const at = new Date().toISOString();
  const message = newId("m-");
  const doc = { card_id: cardId, role: "user", body_md, created_at: at };
  writeDoc(dir, S.docPath("messages", message), doc);
  return { ok: true, message, request: createRequest("answer", cardId, message, at) };
}

/** Asks the agent to compress a card's conversation up to and including `upto`, which must be
 *  a message the page still shows live. */
function compress({ card_id, upto }) {
  const state = readState();
  const cardId = cardOf(state, card_id);
  if (!S.conversation(state, cardId).messages.some((m) => m.id === upto)) {
    refuse("That message is no longer in the conversation.");
  }
  return { ok: true, request: createRequest("compress", cardId, upto, new Date().toISOString()) };
}

/** Records the user's choice of head for a card (undo or a history branch): null or one of the
 *  card's nodes. */
function setHead({ card_id, node }) {
  const state = readState();
  const cardId = cardOf(state, card_id);
  const ofCard = typeof node === "string" && Object.hasOwn(state.nodes, node)
    && state.nodes[node].card_id === cardId;
  if (node !== null && !ofCard) refuse("That point in the history no longer exists.");
  writeDoc(dir, S.docPath("heads", cardId), { node, at: new Date().toISOString() });
  return { ok: true };
}

/** Saves the Neovim server address `goto` opens files in. */
function setSettings({ nvim_server }) {
  if (typeof nvim_server !== "string" || !nvim_server.trim()) {
    refuse("The Neovim server address is empty.");
  }
  writeDoc(dir, S.docPath("settings"), { nvim_server: nvim_server.trim() });
  return { ok: true };
}

/** Opens a file in the deck's Neovim through the relay, which also verifies that Neovim runs in
 *  the deck's worktree; the relay's result is the reply. */
function goTo({ file, line, heading, sha }) {
  const state = readState();
  const server = (state.settings && state.settings.nvim_server) || S.DEFAULT_NVIM_SERVER;
  return relay("goto", { server, worktree: worktreeOf(state), file, line, heading, sha });
}

/** Refills a card's code copies from the worktree through the same relay `fill` the agent
 *  runs, and says which commit they now match. */
async function refresh({ card_id }) {
  const state = readState();
  const cardId = cardOf(state, card_id);
  const card = path.join(dir, S.docPath("cards", cardId));
  const filled = await relay("fill", { worktree: worktreeOf(state), path: card });
  if (!filled.ok) return filled;
  const note = filled.changed
    ? `Code copies updated to ${filled.sha}.` : `Code copies already match ${filled.sha}.`;
  return { ok: true, note };
}

/** One route per page action: each takes the request's JSON body and returns its JSON reply.
 *  A refused request replies `{ok: false, error}`, with a sentence for the user. */
const ROUTES = {
  "GET /api/state": getState,
  "POST /api/ask": ask,
  "POST /api/compress": compress,
  "POST /api/head": setHead,
  "POST /api/settings": setSettings,
  "POST /api/goto": goTo,
  "POST /api/refresh": refresh,
};

const server = http.createServer((req, res) => {
  const pathname = req.url.split("?")[0];
  const file = req.method === "GET" && STATIC[pathname];
  if (file) {
    res.writeHead(200, { "content-type": file[1] + "; charset=utf-8", "cache-control": "no-store" });
    return res.end(fs.readFileSync(path.join(HERE, file[0])));
  }
  const route = ROUTES[`${req.method} ${pathname}`];
  let raw = "";
  req.on("data", (d) => { raw += d; });
  req.on("end", async () => {
    let result;
    try {
      const body = raw ? JSON.parse(raw) : {};
      if (body === null || typeof body !== "object") refuse("The request is not a JSON object.");
      result = route ? await route(body) : { ok: false, error: "Not found." };
    } catch (e) {
      result = { ok: false, error: e.message };
    }
    const headers = { "content-type": "application/json", "cache-control": "no-store" };
    res.writeHead(route ? 200 : 404, headers);
    res.end(JSON.stringify(result));
  });
});

server.listen(port, "127.0.0.1", () => console.log(`http://127.0.0.1:${server.address().port}/`));
