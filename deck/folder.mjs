// Reads and writes a deck folder: one JSON file per document, at DeckState.docPath.
import fs from "node:fs";
import path from "node:path";
import "./state.js";

const { SINGLETONS, COLLECTIONS, docPath } = globalThis.DeckState;

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

/** Writes one whole document through a temp file and a rename, so a reader never sees it half
 *  written. */
export function writeDoc(dir, relPath, data) {
  const file = path.join(dir, relPath);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n");
  fs.renameSync(tmp, file);
}
