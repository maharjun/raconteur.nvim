// Protocol: the deck folder (skill/raconteur-deck/folder.mjs) and the agent's CLI
// (skill/raconteur-deck/deck.mjs).
//
// Interface under test: readDeck and writeDoc on a real folder, and the CLI's output and exit
// code. Every case is one row in CASES: [description, files, run, expected], where `files` are
// written over a fresh copy of the base deck (null deletes one) and `run(dir)` returns the
// result to compare.
//
// Run: node test/protocols/deck_cli.mjs
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readDeck, writeDoc } from "../../skill/raconteur-deck/folder.mjs";

const CLI = fileURLToPath(new URL("../../skill/raconteur-deck/deck.mjs", import.meta.url));
const T = (second) => new Date(Date.UTC(2026, 10, 7, 10, 0, second)).toISOString();

// One card compressed once (n1 covers m1-m2); m3 is waiting for its answer.
const BASE = {
  "meta.json": { title: "Parser", worktree: "/work/repo", order: ["parser"] },
  "cards/parser.json": { title: "Parser", body_md: "One pass." },
  "messages/m1.json": { card_id: "parser", role: "user", body_md: "Why?", created_at: T(1) },
  "messages/m2.json": { card_id: "parser", role: "claude", body_md: "Speed.", created_at: T(2) },
  "messages/m3.json": { card_id: "parser", role: "user", body_md: "And?", created_at: T(3) },
  "nodes/n1.json": { card_id: "parser", parent: null, upto: "m2", created_at: T(4),
    digest: [{ kind: "question", text: "Why one pass?", card_id: "parser" }] },
  "requests/r1.json": { kind: "answer", card_id: "parser", args: { message: "m1" }, created_at: T(1) },
  "requests/r3.json": { kind: "answer", card_id: "parser", args: { message: "m3" }, created_at: T(3) },
  "results/r1.json": { status: "done", created_at: T(2) },
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

const CASES = [
  // readDeck and writeDoc.
  ["readDeck reads every kind; absent singletons are null", {}, (dir) => {
    const s = readDeck(dir);
    return [s.meta.title, s.settings, Object.keys(s.messages), Object.keys(s.heads), s.unreadable];
  }, ["Parser", null, ["m1", "m2", "m3"], [], []]],
  ["readDeck ignores temp files", { "messages/m4.json.123.tmp": "{" },
    (dir) => Object.keys(readDeck(dir).messages), ["m1", "m2", "m3"]],
  ["readDeck lists an unparseable file it has no copy of", { "messages/m3.json": "{" }, (dir) => {
    const s = readDeck(dir, { lastGood: new Map() });
    return [Object.keys(s.messages), s.unreadable];
  }, [["m1", "m2"], ["messages/m3.json"]]],
  ["readDeck serves an unparseable file from its last good copy", {}, (dir) => {
    const lastGood = new Map();
    readDeck(dir, { lastGood });
    fs.writeFileSync(path.join(dir, "messages/m3.json"), "{");
    const s = readDeck(dir, { lastGood });
    return [s.messages.m3.body_md, s.unreadable];
  }, ["And?", []]],
  ["writeDoc replaces a whole document", {}, (dir) => {
    writeDoc(dir, "settings.json", { nvim_server: "/tmp/x.sock" });
    writeDoc(dir, "heads/parser.json", { node: null, at: T(9) });
    const s = readDeck(dir);
    return [s.settings, s.heads.parser, fs.readdirSync(dir).filter((f) => f.endsWith(".tmp"))];
  }, [{ nvim_server: "/tmp/x.sock" }, { node: null, at: T(9) }, []]],

  // check.
  ["check: valid deck", {}, cli("check"), { code: 0, out: "deck is valid\n" }],
  ["check: problems one per line, then the count", { "messages/m1.json": {
    ...BASE["messages/m1.json"], status: "done" } }, cli("check"),
  { code: 1, out: "messages/m1.json: status is not a known field\n1 problems\n" }],
  ["check: an unparseable file is a problem", { "results/r1.json": "{" }, cli("check"),
    { code: 1, out: "results/r1.json is not valid JSON\n1 problems\n" }],
  ["check: a deck without meta.json", { "meta.json": null }, cli("check"),
    { code: 1, out: "meta.json is missing\n1 problems\n" }],

  // pending.
  ["pending: requests without a result, oldest first", { "results/r1.json": null }, json(cli("pending")),
    { code: 0, out: [
      { id: "r1", ...BASE["requests/r1.json"] }, { id: "r3", ...BASE["requests/r3.json"] }] }],

  // conversation.
  ["conversation: digest of the head, then later messages", {}, json(cli("conversation", "parser")),
    { code: 0, out: { card: "parser", title: "Parser", head: "n1",
      digest: BASE["nodes/n1.json"].digest, messages: [{ id: "m3", ...BASE["messages/m3.json"] }] } }],
  ["conversation --upto: the compress input", { "heads/parser.json": { node: null, at: T(9) } },
    json(cli("conversation", "parser", "--upto", "m2")),
    { code: 0, out: { card: "parser", title: "Parser", head: null, digest: [],
      messages: [{ id: "m1", ...BASE["messages/m1.json"] }, { id: "m2", ...BASE["messages/m2.json"] }] } }],
  ["conversation: unknown card", {}, cli("conversation", "gone"), { code: 1, out: "no card gone\n" }],
  ["conversation --upto: not a message of the card", {}, cli("conversation", "parser", "--upto", "m9"),
    { code: 1, out: "m9 is not a message of card parser\n" }],
  ["unknown command prints usage", {}, (dir) => cli("compress")(dir).code, 1],
];

let failed = 0;
for (const [description, files, run, expected] of CASES) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "deck-cli-"));
  for (const [relPath, data] of Object.entries({ ...BASE, ...files })) {
    if (data === null) continue;
    if (typeof data === "string") {
      fs.mkdirSync(path.dirname(path.join(dir, relPath)), { recursive: true });
      fs.writeFileSync(path.join(dir, relPath), data);
    } else {
      writeDoc(dir, relPath, data);
    }
  }
  let result;
  try {
    result = run(dir);
    assert.deepEqual(result, expected);
    console.log(`ok   ${description}`);
  } catch (e) {
    failed += 1;
    console.log(`FAIL ${description}\n     expected ${JSON.stringify(expected)}\n     got      ${JSON.stringify(result ?? e.message)}`);
  }
  fs.rmSync(dir, { recursive: true, force: true });
}
console.log(`${CASES.length - failed}/${CASES.length} passed`);
process.exit(failed ? 1 : 0);
