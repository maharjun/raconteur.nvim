// Reads and writes a deck folder and its library: one file per document, at DeckState.docPath,
// and the card repository, through git.
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import "./state.js";

const { SINGLETONS, COLLECTIONS, docPath, codeDocs, dynamicBlocks, blockKey, parseCard, CAUSES } = globalThis.DeckState;

/** The library a deck folder belongs to: `<library>/decks/<deck>`. */
export function libraryOf(dir) {
  return path.resolve(dir, "..", "..");
}

/** The card repository of a deck's library. */
export function cardRepo(dir) {
  return path.join(libraryOf(dir), "cards");
}

/** Reads a deck and its library into the DeckState shape. A file that fails to parse is served
 *  from its copy in `lastGood` (a Map the caller keeps across reads); with no copy it is left
 *  out and listed in `unreadable`. */
export function readDeck(dir, { lastGood } = {}) {
  const state = { deck: path.basename(path.resolve(dir)), unreadable: [] };
  const read = (relPath) => {
    const file = path.join(dir, relPath);
    let raw;
    try {
      raw = fs.readFileSync(file, "utf8");
    } catch {
      return undefined;
    }
    const doc = relPath.endsWith(".md") ? parseCard(raw) : parseJson(raw);
    if (doc !== null) {
      if (lastGood) lastGood.set(file, doc);
      return doc;
    }
    if (lastGood && lastGood.has(file)) return lastGood.get(file);
    state.unreadable.push(relPath);
    return undefined;
  };
  for (const kind of SINGLETONS) state[kind] = read(docPath(kind)) ?? null;
  for (const kind of COLLECTIONS) {
    state[kind] = {};
    const suffix = path.extname(docPath(kind, "x"));
    const folder = path.dirname(path.join(dir, docPath(kind, "x")));
    const files = fs.existsSync(folder) ? fs.readdirSync(folder).filter((f) => f.endsWith(suffix)) : [];
    for (const file of files.sort()) {
      const id = file.slice(0, -suffix.length);
      const doc = read(docPath(kind, id));
      if (doc !== undefined) state[kind][id] = doc;
    }
  }
  return state;
}

function parseJson(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** The CodeHashes of every block range the library copies, read from its worktree now. A
 *  range's hash is lua/raconteur/utils.lua content_hash of its lines, which are split on "\n"
 *  alone and hashed as bytes (latin1 round-trips them), so the two always agree. */
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
 *  written. A string is written as it is, anything else as indented JSON. */
export function writeDoc(dir, relPath, data) {
  const file = path.join(dir, relPath);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, typeof data === "string" ? data : JSON.stringify(data, null, 2) + "\n");
  fs.renameSync(tmp, file);
}

// ---------- the card repository ----------

/** Commits by the deck tools carry this identity, so the repository needs no git config. */
const IDENTITY = ["-c", "user.name=Raconteur", "-c", "user.email=raconteur@localhost"];

function git(repo, args, input) {
  const run = spawnSync("git", ["-C", repo, ...args], { encoding: "utf8", input });
  return { code: run.status, out: (run.stdout || "").trimEnd(), err: (run.stderr || "").trim() };
}

function gitOrThrow(repo, args, input) {
  const run = git(repo, args, input);
  if (run.code !== 0) throw new Error(`git ${args[0]} failed in ${repo}: ${run.err}`);
  return run.out;
}

const isRepo = (repo) => fs.existsSync(path.join(repo, ".git"));
const cardIdOf = (file) => (/^([A-Za-z0-9_-]{1,100})\.md$/.exec(file) || [])[1];

/** What git says about a deck's card repository: each card file's commits, newest first, and
 *  the card files with changes not committed. A library whose repository does not exist yet
 *  has no history, and every card file in it is uncommitted. */
export function readStore(dir) {
  const repo = cardRepo(dir);
  if (!isRepo(repo)) {
    const files = fs.existsSync(repo) ? fs.readdirSync(repo) : [];
    return { history: {}, uncommitted: files.map(cardIdOf).filter(Boolean).sort() };
  }
  const history = {};
  const log = git(repo, ["log", "--no-renames", "--name-only",
    "--format=%x1e%H%x1f%cI%x1f%s%x1f%(trailers:only,unfold)%x1f"]);
  for (const entry of log.code === 0 ? log.out.split("\x1e").slice(1) : []) {
    const [commit, at, subject, trailerText, files] = entry.split("\x1f");
    const trailers = Object.fromEntries(trailerText.split("\n").map((line) => /^([A-Za-z-]+): (.*)$/.exec(line))
      .filter(Boolean).map((m) => [m[1], m[2]]));
    for (const file of files.split("\n").map((f) => f.trim()).filter(Boolean)) {
      const cardId = cardIdOf(file);
      if (cardId) (history[cardId] ||= []).push({ commit, at, subject, trailers });
    }
  }
  const status = git(repo, ["status", "--porcelain", "--untracked-files=all", "--no-renames"]);
  const uncommitted = status.out.split("\n").map((line) => cardIdOf(line.slice(3))).filter(Boolean).sort();
  return { history, uncommitted };
}

/** Commits every change in the card repository, creating it first if needed, with the subject
 *  and the trailers (Cause first). Returns the new commit's full hash, or null when there was
 *  nothing to commit. */
export function commitCards(dir, subject, trailers) {
  const repo = cardRepo(dir);
  if (!CAUSES.includes(trailers.Cause)) throw new Error(`Cause must be one of ${CAUSES.join(", ")}`);
  if (!subject.trim() || subject.includes("\n")) throw new Error("The subject must be one line.");
  fs.mkdirSync(repo, { recursive: true });
  if (!isRepo(repo)) gitOrThrow(repo, ["init", "-q", "-b", "main"]);
  gitOrThrow(repo, ["add", "-A", "."]);
  if (git(repo, ["diff", "--cached", "--quiet"]).code === 0) return null;
  const lines = Object.entries(trailers).filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`);
  gitOrThrow(repo, [...IDENTITY, "commit", "-q", "-F", "-"], `${subject.trim()}\n\n${lines.join("\n")}\n`);
  return gitOrThrow(repo, ["rev-parse", "HEAD"]);
}

/** The diff one commit made to one card file. */
export function cardDiff(dir, cardId, commit) {
  return gitOrThrow(cardRepo(dir), ["show", "--format=", "--no-color", "--no-renames", commit, "--", `${cardId}.md`]);
}
