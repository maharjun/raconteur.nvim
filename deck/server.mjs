// Local deck server: serves the page, the deck's documents, and its Neovim requests.
//
//   node deck/server.mjs <deck-dir> [port]
//
// <deck-dir> holds one JSON file per document (<collection>/<id>.json) and inbox.log, where a
// line is appended for every user message and compress request; the Claude session watches it.
// The server's address is written to <deck-dir>/server.json.
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RELAY = path.join(HERE, "..", "scripts", "deck.lua");
const COLLECTIONS = ["deck", "cards", "nodes", "messages", "actions"];
const ID = /^[A-Za-z0-9_-]{1,100}$/;

const dir = path.resolve(process.argv[2] || "");
const port = Number(process.argv[3] || 0);
if (!process.argv[2] || !fs.existsSync(dir)) {
  console.error("usage: node deck/server.mjs <deck-dir> [port]");
  process.exit(1);
}

// A file caught mid-write by the agent fails to parse; serve its last good copy until it settles.
const lastGood = new Map();
function readCollection(collection) {
  const folder = path.join(dir, collection);
  const docs = {};
  if (!fs.existsSync(folder)) return docs;
  for (const file of fs.readdirSync(folder)) {
    if (!file.endsWith(".json")) continue;
    const full = path.join(folder, file);
    try {
      lastGood.set(full, JSON.parse(fs.readFileSync(full, "utf8")));
    } catch { /* keep the last good copy */ }
    if (lastGood.has(full)) docs[file.slice(0, -5)] = lastGood.get(full);
  }
  return docs;
}

function readState() {
  return {
    meta: readCollection("deck").meta || null,
    cards: readCollection("cards"), nodes: readCollection("nodes"),
    messages: readCollection("messages"), actions: readCollection("actions"),
  };
}

function writeDoc(collection, id, data, merge) {
  const file = path.join(dir, collection, id + ".json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const before = merge && fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(merge ? { ...before, ...data } : data, null, 1));
  fs.renameSync(tmp, file);
}

function wake(event) {
  fs.appendFileSync(path.join(dir, "inbox.log"), JSON.stringify({ ...event, at: new Date().toISOString() }) + "\n");
}

function relay(args, stdin = "") {
  return new Promise((resolve) => {
    const child = spawn("nvim", ["-l", RELAY, ...args]);
    let out = "";
    child.stdout.on("data", (d) => { out += d; });
    child.on("error", (e) => resolve({ ok: false, error: "Couldn't run Neovim: " + e.message }));
    child.on("close", () => {
      try { resolve(JSON.parse(out)); } catch { resolve({ ok: false, error: "The relay printed no result." }); }
    });
    child.stdin.end(stdin);
  });
}

async function handle(req, body) {
  const meta = readState().meta || {};
  if (req.url === "/api/state") return readState();
  if (req.url === "/api/write") {
    const { collection, id, data, merge } = body;
    if (!COLLECTIONS.includes(collection) || !ID.test(id || "") || typeof data !== "object" || !data) {
      return { ok: false, error: "Not a deck document." };
    }
    writeDoc(collection, id, data, !!merge);
    if (!merge && collection === "messages" && data.role === "user") wake({ type: "message", id, card_id: data.card_id });
    if (!merge && collection === "actions" && data.kind === "compress") wake({ type: "compress", id, card_id: data.card_id });
    return { ok: true };
  }
  if (req.url === "/api/goto") {
    const where = body.heading ? "#" + body.heading : String(body.line || 1);
    return relay(["goto", meta.nvim_server || "", meta.worktree || "", body.file || "", where, ...(body.sha ? [body.sha] : [])]);
  }
  if (req.url === "/api/refresh") {
    const card = readState().cards[body.card_id];
    if (!card) return { ok: false, error: "That card no longer exists." };
    const filled = await relay(["fill", meta.worktree || ""], card.body_md || "");
    if (!filled.ok) return filled;
    if (filled.markdown === card.body_md) return { ok: true, note: `Code copies already match ${filled.sha}.` };
    writeDoc("cards", body.card_id, { body_md: filled.markdown }, true);
    return { ok: true, note: `Code copies updated to ${filled.sha}.` };
  }
  return null;
}

const STATIC = { "/": ["page.html", "text/html"], "/state.js": ["state.js", "text/javascript"] };

const server = http.createServer((req, res) => {
  const file = req.method === "GET" && STATIC[req.url.split("?")[0]];
  if (file) {
    res.writeHead(200, { "content-type": file[1] + "; charset=utf-8", "cache-control": "no-store" });
    return res.end(fs.readFileSync(path.join(HERE, file[0])));
  }
  let raw = "";
  req.on("data", (d) => { raw += d; });
  req.on("end", async () => {
    let result;
    try {
      result = await handle(req, raw ? JSON.parse(raw) : {});
    } catch (e) {
      result = { ok: false, error: e.message };
    }
    res.writeHead(result ? 200 : 404, { "content-type": "application/json" });
    res.end(JSON.stringify(result || { ok: false, error: "Not found." }));
  });
});

server.listen(port, "127.0.0.1", () => {
  const url = `http://127.0.0.1:${server.address().port}/`;
  fs.writeFileSync(path.join(dir, "server.json"), JSON.stringify({ url, pid: process.pid }) + "\n");
  console.log(url);
});
