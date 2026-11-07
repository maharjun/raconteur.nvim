// Reads and writes a deck folder: one JSON file per document, at DeckState.docPath.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import "./state.js";

const { SINGLETONS, COLLECTIONS, docPath, codeDocs, dynamicBlocks, blockKey } = globalThis.DeckState;

/** Reads every document of a deck folder into the DeckState shape. A file that fails to parse is
 *  served from its copy in `lastGood` (a Map the caller keeps across reads); with no copy it is
 *  left out and listed in `unreadable`. */
export function readDeck(dir, { lastGood } = {}) {
  const state = { unreadable: [] };
  const read = (relPath) => {
    const file = path.join(dir, relPath);
    let raw;
    try {
      raw = fs.readFileSync(file, "utf8");
    } catch {
      return undefined;
    }
    try {
      const doc = JSON.parse(raw);
      if (lastGood) lastGood.set(file, doc);
      return doc;
    } catch {
      if (lastGood && lastGood.has(file)) return lastGood.get(file);
      state.unreadable.push(relPath);
      return undefined;
    }
  };
  for (const kind of SINGLETONS) state[kind] = read(docPath(kind)) ?? null;
  for (const kind of COLLECTIONS) {
    state[kind] = {};
    const folder = path.join(dir, kind);
    const files = fs.existsSync(folder) ? fs.readdirSync(folder).filter((f) => f.endsWith(".json")) : [];
    for (const file of files.sort()) {
      const id = file.slice(0, -".json".length);
      const doc = read(docPath(kind, id));
      if (doc !== undefined) state[kind][id] = doc;
    }
  }
  return state;
}

/** The CodeHashes of every block range the deck copies, read from its worktree now. A range's
 *  hash is lua/raconteur/utils.lua content_hash of its lines, which are split on "\n" alone and
 *  hashed as bytes (latin1 round-trips them), so the two always agree. */
export function codeHashes(state) {
  const worktree = state.meta && state.meta.worktree;
  const files = new Map();
  const linesOf = (file) => {
    if (!files.has(file)) {
      let lines = null;
      try {
        const text = fs.readFileSync(path.join(worktree, file), "latin1");
        lines = text.split("\n");
        if (text.endsWith("\n")) lines.pop();
      } catch {
        // Missing or unreadable: no lines, so no hash.
      }
      files.set(file, lines);
    }
    return files.get(file);
  };
  const hashes = {};
  if (typeof worktree !== "string") return hashes;
  for (const { body_md } of codeDocs(state)) {
    for (const block of dynamicBlocks(body_md)) {
      const all = linesOf(block.file);
      const lines = all && (block.start ? all.slice(block.start - 1, block.end) : all);
      hashes[blockKey(block)] = lines && lines.length
        ? crypto.createHash("sha256").update(lines.join("\n"), "latin1").digest("hex").slice(0, 12)
        : null;
    }
  }
  return hashes;
}

/** Writes one whole document through a temp file and a rename, so a reader never sees it half
 *  written. */
export function writeDoc(dir, relPath, data) {
  const file = path.join(dir, relPath);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n");
  fs.renameSync(tmp, file);
}
