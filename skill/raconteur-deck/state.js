// The deck's data model: every rule about what a deck and its library hold and what the page
// derives from them. Loaded by the page as a plain script and by Node as a side-effect import;
// both read globalThis.DeckState.
//
// A library is a worktree's `.raconteur/` folder. It holds every card once, in `cards/`, a git
// repository with one file per card, and every conversation's messages, nodes and heads. A deck
// is a folder under `decks/`: which cards it shows and in what order, which conversation it
// keeps under each card, and the requests its page sends the agent.
(function () {
  /**
   * @typedef {Object} Meta  meta.json, written by the agent.
   * @property {string} title
   * @property {string} worktree  Absolute path of the worktree the deck explains.
   * @property {string[]} order  The main sequence: card ids in reading order.
   * @property {Section[]} [sections]  Groups of cards set apart from the main sequence, in the
   *   order the page lists them.
   * @property {Object<string, string>} [aliases]  Card id -> the id of this deck's fork of it:
   *   the deck shows the fork wherever it lists or links the card.
   * @property {Object<string, string>} [conversations]  Card id -> the conversation the deck
   *   keeps under it, when not the default `<deck>--<card>`; two decks naming one conversation
   *   share it.
   *
   * @typedef {Object} Section  One entry of meta.json's sections.
   * @property {string} id
   * @property {string} title
   * @property {string[]} cards  Its card ids in reading order.
   *
   * @typedef {Object} Settings  settings.json, written by the server.
   * @property {string} nvim_server  Neovim server address `goto` opens files in.
   *
   * @typedef {Object} Card  cards/<id>.md in the library, written by the agent and committed:
   *   front matter lines `key: value` between two `---` lines, then the body.
   * @property {string} title  For a term card, the term itself.
   * @property {"term"} [kind]  "term" for a card that defines one term; links to it open its
   *   definition.
   * @property {string} [forked_from]  `<card>@<commit>`: this card is a deck's own copy of
   *   <card>, made from (or last reconciled with) its version at <commit>.
   * @property {string} body_md
   *
   * @typedef {Object} Head  heads/<conversation>.json, written by the server when the user picks
   *   a node.
   * @property {string|null} node  Chosen node, or null for the conversation before any compress.
   * @property {string} at  When the choice was made.
   *
   * @typedef {Object} DigestEntry
   * @property {"question"|"concept"} kind
   * @property {string} text
   * @property {string} card_id  Card the entry links to.
   *
   * @typedef {Object} Node  nodes/<id>.json, written once by the agent per compress.
   * @property {string} conversation
   * @property {string|null} parent  Head of the conversation when the compress ran.
   * @property {string} upto  Last message the digest covers.
   * @property {DigestEntry[]} digest
   * @property {string} created_at
   *
   * @typedef {Object} Message  messages/<id>.json; the server writes user messages, the agent
   *   writes claude messages.
   * @property {string} conversation
   * @property {"user"|"claude"} role
   * @property {string} body_md
   * @property {string} created_at
   *
   * @typedef {Object} Request  requests/<id>.json in the deck, written by the server for the
   *   agent to serve.
   * @property {"answer"|"compress"|"reconcile"} kind
   * @property {string} card_id
   * @property {{message: string}|{upto: string}|{commit: string}} args  The one argument
   *   REQUEST_ARG names.
   * @property {string} created_at
   *
   * @typedef {Object} Result  results/<request id>.json, written by the agent when it is done.
   * @property {"done"|"error"} status
   * @property {string} [error]  Sentence for the user; present exactly when status is error.
   * @property {string} created_at
   *
   * @typedef {Object} State
   * @property {string} deck  The deck's id, its folder's name.
   * @property {Meta|null} meta
   * @property {Settings|null} settings
   * @property {Object<string, Card>} cards  Every card of the library.
   * @property {Object<string, Head>} heads
   * @property {Object<string, Node>} nodes
   * @property {Object<string, Message>} messages
   * @property {Object<string, Request>} requests  The deck's own.
   * @property {Object<string, Result>} results
   * @property {string[]} [unreadable]  Files readDeck could not parse and had no copy of.
   *
   * @typedef {Object} Commit  One commit of the card repository, as the server reads it.
   * @property {string} commit  Full hash.
   * @property {string} at  Commit time.
   * @property {string} subject
   * @property {Object<string, string>} trailers  Deck, Cause, Request, Card, Conversation, Node.
   *
   * @typedef {Object} Store  What git says about the card repository.
   * @property {Object<string, Commit[]>} history  Card file id -> the commits that changed it,
   *   newest first.
   * @property {string[]} uncommitted  Card file ids with changes not committed.
   *
   * @typedef {Object} Block  A dynamic block's fence info, as parseFenceInfo reads it.
   * @property {string|null} lang
   * @property {string} file
   * @property {number|null} start
   * @property {number|null} end
   * @property {string|null} sha  Commit the body was copied from.
   * @property {string|null} hash  Hash of the body as copied (lua/raconteur/utils.lua
   *   content_hash), stamped by `fill`.
   *
   * @typedef {Object<string, string|null>} CodeHashes  Hash of each block range's current
   *   lines in the worktree, by blockKey; null when the lines can't be read.
   */

  const ID = /^[A-Za-z0-9_-]{1,100}$/;
  const COMMIT = /^[0-9a-f]{40}$/;
  const DEFAULT_NVIM_SERVER = "/tmp/raconteur-deck.sock";
  const SINGLETONS = ["meta", "settings"];
  /** The library's collections, shared by its decks, and the deck's own. */
  const LIBRARY = ["cards", "heads", "nodes", "messages"];
  const DECK = ["requests", "results"];
  const COLLECTIONS = [...LIBRARY, ...DECK];

  /** Each request kind takes exactly one argument: a message of the card's conversation, or
   *  for reconcile the commit of the original card to bring the fork up to. */
  const REQUEST_ARG = { answer: "message", compress: "upto", reconcile: "commit" };
  /** The causes a card commit records: what the agent was doing, or a request's kind. */
  const CAUSES = ["authored", "edit", "refill", ...Object.keys(REQUEST_ARG)];

  const id = { type: "id" };
  const text = { type: "string" };
  const time = { type: "time" };

  /** Field specs per document kind; every field is required unless `optional`, and a document
   *  holds no field the table does not list. */
  const SCHEMA = {
    meta: {
      title: text, worktree: text, order: { type: "list", of: id },
      sections: {
        type: "list",
        optional: true,
        of: { type: "object", fields: { id, title: text, cards: { type: "list", of: id } } },
      },
      aliases: { type: "map", of: id, optional: true },
      conversations: { type: "map", of: id, optional: true },
    },
    settings: { nvim_server: text },
    cards: {
      title: text,
      kind: { type: "string", enum: ["term"], optional: true },
      forked_from: { type: "string", optional: true },
      body_md: text,
    },
    heads: { node: { type: "id", nullable: true }, at: time },
    nodes: {
      conversation: id,
      parent: { type: "id", nullable: true },
      upto: id,
      digest: {
        type: "list",
        of: {
          type: "object",
          fields: { kind: { type: "string", enum: ["question", "concept"] }, text, card_id: id },
        },
      },
      created_at: time,
    },
    messages: {
      conversation: id, role: { type: "string", enum: ["user", "claude"] }, body_md: text,
      created_at: time,
    },
    requests: {
      kind: { type: "string", enum: Object.keys(REQUEST_ARG) },
      card_id: id,
      args: {
        type: "object",
        fields: Object.fromEntries(Object.values(REQUEST_ARG).map((arg) => [arg, { ...id, optional: true }])),
      },
      created_at: time,
    },
    results: {
      status: { type: "string", enum: ["done", "error"] }, error: { ...text, optional: true },
      created_at: time,
    },
  };

  /** Where a document lives, relative to the deck folder: library documents two folders up. */
  function docPath(kind, docId) {
    if (SINGLETONS.includes(kind)) return `${kind}.json`;
    const file = `${kind}/${docId}.${kind === "cards" ? "md" : "json"}`;
    return LIBRARY.includes(kind) ? `../../${file}` : file;
  }

  /** Reads a card file: `---`, lines of `key: value`, `---`, then the body (one blank line after
   *  the front matter is not part of it). Returns the card, or null for text that has no front
   *  matter; the schema then checks its fields. */
  function parseCard(textOfFile) {
    const match = /^---\n([\s\S]*?)\n---\n\n?([\s\S]*)$/.exec(textOfFile.replace(/\r\n/g, "\n"));
    if (!match) return null;
    const card = {};
    for (const line of match[1].split("\n")) {
      const field = /^([a-z_]+): ?(.*)$/.exec(line);
      if (!field) return null;
      card[field[1]] = field[2].trim();
    }
    card.body_md = match[2];
    return card;
  }

  /** The text of a card file: its front matter in a fixed order, then its body. */
  function formatCard(card) {
    const front = ["title", "kind", "forked_from"].filter((k) => card[k] !== undefined)
      .map((k) => `${k}: ${card[k]}`);
    return `---\n${front.join("\n")}\n---\n\n${card.body_md.replace(/\n*$/, "\n")}`;
  }

  /** A fork's `forked_from` as {card, commit}, or null when the card is no fork or the value is
   *  malformed. */
  function forkedFrom(card) {
    const match = card && /^([A-Za-z0-9_-]{1,100})@([0-9a-f]{40})$/.exec(card.forked_from || "");
    return match ? { card: match[1], commit: match[2] } : null;
  }

  /** Times are ISO 8601 UTC exactly as `new Date().toISOString()` prints them, so string order
   *  is time order. */
  function isTime(value) {
    return typeof value === "string" && !isNaN(Date.parse(value))
      && new Date(value).toISOString() === value;
  }

  /** Reads a dynamic block's fence info: an optional first-token language (absent when that
   *  token is an attribute), then `file=` (required), `lines=a-b` or `lines=a`, `sha=` and
   *  `hash=`.
   *  Attributes are whole whitespace-separated tokens and the first token of a key decides, so
   *  a malformed value reads as absent; returns null for any other fence. Mirrors
   *  lua/raconteur/parser.lua through test/fixtures/fence_info.json. */
  function parseFenceInfo(info) {
    const tokens = (info || "").trim().split(/\s+/).filter(Boolean);
    const attr = (name) => {
      const token = tokens.find((t) => t.startsWith(name + "="));
      return token ? token.slice(name.length + 1) : "";
    };
    const file = attr("file");
    if (!file) return null;
    const lines = /^(\d+)(?:-(\d+))?$/.exec(attr("lines"));
    const sha = /^[0-9a-f]+$/.exec(attr("sha"));
    const hash = /^[0-9a-f]+$/.exec(attr("hash"));
    return {
      lang: tokens[0].includes("=") ? null : tokens[0],
      file,
      start: lines ? Number(lines[1]) : null,
      end: lines ? Number(lines[2] || lines[1]) : null,
      sha: sha ? sha[0] : null,
      hash: hash ? hash[0] : null,
    };
  }

  /** The dynamic blocks of a markdown body, top to bottom: an open fence whose info is a
   *  dynamic block's, up to the next line of at least as many backticks at the same indent.
   *  The same pass as lua/raconteur/parser.lua. */
  function dynamicBlocks(markdown) {
    const lines = (markdown || "").split("\n");
    const blocks = [];
    for (let i = 0; i < lines.length; i++) {
      const open = /^(\s*)(`{3,})(.+)$/.exec(lines[i]);
      const block = open && parseFenceInfo(open[3]);
      if (!block) continue;
      const close = new RegExp(`^${open[1]}\`{${open[2].length},}\\s*$`);
      const end = lines.findIndex((line, j) => j > i && close.test(line));
      if (end === -1) continue;
      blocks.push(block);
      i = end;
    }
    return blocks;
  }

  /** Names a block's source range, the key of CodeHashes. */
  function blockKey(block) {
    return block.start ? `${block.file}:${block.start}-${block.end}` : block.file;
  }

  /** Whether a block was copied from lines the worktree no longer holds: it has a `hash=` and
   *  the range's current lines hash to something else, or can't be read. A block without a
   *  hash can't tell, so it is never out of date. */
  function isOutOfDate(block, hashes) {
    const key = blockKey(block);
    return block.hash !== null && Object.hasOwn(hashes || {}, key) && hashes[key] !== block.hash;
  }

  /** The documents the library copies code into: every card, then every message, as
   *  {doc, card_id, body_md}; a message's card_id is null. */
  function codeDocs(state) {
    return [
      ...withIds(state.cards).map((c) => ({ doc: docPath("cards", c.id), card_id: c.id, body_md: c.body_md })),
      ...withIds(state.messages).map((m) => ({ doc: docPath("messages", m.id), card_id: null, body_md: m.body_md })),
    ];
  }

  /** Every out-of-date block, per document, for the agent to decide whether to refill:
   *  {doc, card_id, file, lines, hash, current} with `current` the hash the lines have now. */
  function outOfDateBlocks(state, hashes) {
    return codeDocs(state).flatMap(({ doc, card_id, body_md }) =>
      dynamicBlocks(body_md).filter((b) => isOutOfDate(b, hashes)).map((b) => ({
        doc, card_id, file: b.file, lines: b.start ? `${b.start}-${b.end}` : null,
        hash: b.hash, current: hashes[blockKey(b)],
      })));
  }

  // ---------- the deck's view of the library ----------

  const metaOf = (state) => state.meta || { order: [] };

  /** The card file a deck shows for a card id: its fork when the deck has one. */
  function shownId(state, cardId) {
    const aliases = metaOf(state).aliases || {};
    return Object.hasOwn(aliases, cardId) ? aliases[cardId] : cardId;
  }

  /** The card a deck shows for a card id, or undefined when there is none. */
  function cardOf(state, cardId) {
    const shown = shownId(state, cardId);
    return Object.hasOwn(state.cards, shown) ? state.cards[shown] : undefined;
  }

  /** Every card id the deck lists: the main sequence, then each section's. */
  function deckCards(state) {
    const meta = metaOf(state);
    return [...meta.order, ...(meta.sections || []).flatMap((s) => s.cards)];
  }

  /** The section that lists a card, or null for a card of the main sequence or outside the deck. */
  function sectionOf(state, cardId) {
    return (metaOf(state).sections || []).find((s) => s.cards.includes(cardId)) || null;
  }

  /** The ids of one section's cards (null: the main sequence) that exist, in reading order. */
  function cardsInSection(state, sectionId) {
    const meta = metaOf(state);
    const section = sectionId === null ? null : (meta.sections || []).find((s) => s.id === sectionId);
    const ids = sectionId === null ? meta.order : section ? section.cards : [];
    return ids.filter((cardId) => cardOf(state, cardId));
  }

  /** Whether a card defines a term. */
  function isTermCard(state, cardId) {
    const card = cardOf(state, cardId);
    return Boolean(card && card.kind === "term");
  }

  /** A term card's definition: the first paragraph of its body, as markdown, links kept. The
   *  page shows it when the reader hovers over a link to the card. */
  function definitionOf(card) {
    return (card.body_md || "").trim().split(/\n\s*\n/)[0];
  }

  /** The conversation the deck keeps under a card. */
  function conversationOf(state, cardId) {
    const named = metaOf(state).conversations || {};
    return Object.hasOwn(named, cardId) ? named[cardId] : `${state.deck}--${cardId}`;
  }

  /** Where a card the deck shows stands against the card it was forked from: null for a card
   *  that is no fork; otherwise {card, fork, original, base, latest, behind}, where `latest` is
   *  the original's newest commit and `behind` says the original changed since `base`. */
  function forkStatus(state, store, cardId) {
    const fork = shownId(state, cardId);
    const from = forkedFrom(state.cards[fork]);
    if (!from) return null;
    const newest = ((store && store.history[from.card]) || [])[0];
    const latest = newest ? newest.commit : null;
    return { card: cardId, fork, original: from.card, base: from.commit, latest, behind: latest !== null && latest !== from.commit };
  }

  /** The deck's forks whose original changed since they were made or last reconciled. */
  function behindForks(state, store) {
    return [...new Set(deckCards(state))].map((cardId) => forkStatus(state, store, cardId))
      .filter((status) => status && status.behind);
  }

  /** card://<id> and walkthrough://<path>#<heading> are the deck's own links; http(s) links
   *  open in a new tab; anything else is not followed. */
  function parseLink(href) {
    const card = /^card:\/\/([A-Za-z0-9_-]+)$/.exec(href || "");
    if (card) return { kind: "card", id: card[1] };
    const walk = /^walkthrough:\/\/([^#]+)(?:#(.+))?$/.exec(href || "");
    if (walk) return { kind: "walkthrough", path: walk[1], heading: walk[2] || null };
    if (/^https?:\/\//.test(href || "")) return { kind: "web", href };
    return null;
  }

  // ---------- conversations ----------

  /** The one ordering of documents in time: created_at, then id to break ties. */
  function byTime(a, b) {
    return a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1
      : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  }

  function withIds(map) {
    return Object.entries(map || {}).map(([docId, doc]) => ({ id: docId, ...doc }));
  }

  function messageWithId(state, messageId) {
    return { ...state.messages[messageId], id: messageId };
  }

  function inConversation(map, conversationId) {
    return withIds(map).filter((doc) => doc.conversation === conversationId).sort(byTime);
  }

  /** A conversation's head is whichever happened last: the user's choice in
   *  heads/<conversation>.json or its newest node, so a compress moves the head with no head
   *  write. A choice made at the same instant as the newest node wins. */
  function headOf(state, conversationId) {
    const chosen = state.heads[conversationId];
    const newest = inConversation(state.nodes, conversationId).pop();
    if (!newest) return chosen ? chosen.node : null;
    return chosen && chosen.at >= newest.created_at ? chosen.node : newest.id;
  }

  /** The head of the conversation the deck keeps under a card. */
  function head(state, cardId) {
    return headOf(state, conversationOf(state, cardId));
  }

  /** What the agent and the page read as a card's conversation: its id, the head's digest, then
   *  its messages after the head's `upto`. With `upto`, only messages up to and including it:
   *  the input of a compress. */
  function conversation(state, cardId, { upto } = {}) {
    const conversationId = conversationOf(state, cardId);
    const headId = headOf(state, conversationId);
    const node = headId ? state.nodes[headId] : null;
    const after = node ? messageWithId(state, node.upto) : null;
    const until = upto ? messageWithId(state, upto) : null;
    const messages = inConversation(state.messages, conversationId).filter((m) =>
      (!after || byTime(m, after) > 0) && (!until || byTime(m, until) <= 0));
    return { conversation: conversationId, head: headId, digest: node ? node.digest : [], messages };
  }

  /** Undo moves the head to its parent ({node: null} is the conversation before the first
   *  compress); null means there is nothing to undo. */
  function undoTarget(state, cardId) {
    const headId = head(state, cardId);
    if (!headId) return null;
    const node = state.nodes[headId];
    return { node: node ? node.parent : null };
  }

  /** The branches redo can move to from a node (null for the start), oldest first. */
  function children(state, cardId, nodeId) {
    return inConversation(state.nodes, conversationOf(state, cardId))
      .filter((n) => n.parent === (nodeId || null));
  }

  // ---------- requests ----------

  /** Requests the agent has not served yet (no result), oldest first. */
  function pendingRequests(state) {
    return withIds(state.requests).filter((r) => !state.results[r.id]).sort(byTime);
  }

  /** A request is waiting until its result exists, then done or error with the result's
   *  sentence. */
  function requestStatus(state, requestId) {
    const result = state.results[requestId];
    if (!result) return { request: requestId, status: "waiting", error: null };
    return { request: requestId, status: result.status, error: result.error || null };
  }

  function newestRequest(state, kind, matches) {
    const found = withIds(state.requests).filter((r) => r.kind === kind && matches(r)).sort(byTime).pop();
    return found ? requestStatus(state, found.id) : null;
  }

  /** Whether a user message is answered, waiting or failed, from its newest answer request;
   *  null when nothing asked for an answer to it. */
  function answerStatus(state, messageId) {
    return newestRequest(state, "answer", (r) => r.args.message === messageId);
  }

  /** Whether a card's newest compress is done, waiting or failed; null when it was never
   *  compressed. */
  function compressStatus(state, cardId) {
    return newestRequest(state, "compress", (r) => r.card_id === cardId);
  }

  /** Whether a card's newest reconcile is done, waiting or failed; null when none was asked. */
  function reconcileStatus(state, cardId) {
    return newestRequest(state, "reconcile", (r) => r.card_id === cardId);
  }

  // ---------- checks ----------

  const TYPES = {
    string: [(v) => typeof v === "string", "a string"],
    id: [(v) => typeof v === "string" && ID.test(v), "an id"],
    time: [isTime, "an ISO UTC time"],
    list: [Array.isArray, "a list"],
    object: [(v) => v !== null && typeof v === "object" && !Array.isArray(v), "an object"],
    map: [(v) => v !== null && typeof v === "object" && !Array.isArray(v), "an object"],
  };

  /** Problems with one value against its field spec, nested specs included. */
  function checkValue(file, where, value, spec, problems) {
    if (value === null && spec.nullable) return;
    const [ok, name] = TYPES[spec.type];
    const label = where ? `${file}: ${where}` : file;
    if (!ok(value)) return problems.push(`${label} is not ${name}${spec.nullable ? " or null" : ""}`);
    if (spec.enum && !spec.enum.includes(value)) {
      return problems.push(`${label} is not one of ${spec.enum.join(", ")}`);
    }
    if (spec.type === "list") value.forEach((item, i) => checkValue(file, `${where}[${i}]`, item, spec.of, problems));
    if (spec.type === "map") {
      for (const [key, item] of Object.entries(value)) {
        if (!ID.test(key)) problems.push(`${file}: ${where}.${key} is not keyed by an id`);
        else checkValue(file, `${where}.${key}`, item, spec.of, problems);
      }
    }
    if (spec.fields) {
      const field = (name) => (where ? `${where}.${name}` : name);
      for (const [name, sub] of Object.entries(spec.fields)) {
        if (name in value) checkValue(file, field(name), value[name], sub, problems);
        else if (!sub.optional) problems.push(`${file}: ${field(name)} is missing`);
      }
      for (const name of Object.keys(value)) {
        if (!(name in spec.fields)) problems.push(`${file}: ${field(name)} is not a known field`);
      }
    }
  }

  function cardLinks(markdown) {
    return [...markdown.matchAll(/card:\/\/([^\s)\]>"'`]*)/g)].map((m) => m[1]);
  }

  /** Rules that span documents, per kind; each returns problem sentences for one document of
   *  the right shape. */
  const RULES = {
    meta(state, meta) {
      const problems = [];
      const listed = deckCards(state);
      listed.forEach((cardId, i) => {
        if (!Object.hasOwn(state.cards, cardId)) problems.push(`lists missing card ${cardId}`);
        if (listed.indexOf(cardId) !== i) problems.push(`lists card ${cardId} twice`);
      });
      const sectionIds = (meta.sections || []).map((s) => s.id);
      sectionIds.forEach((sectionId, i) => {
        if (sectionIds.indexOf(sectionId) !== i) problems.push(`sections lists ${sectionId} twice`);
      });
      for (const [cardId, forkId] of Object.entries(meta.aliases || {})) {
        const from = forkedFrom(state.cards[forkId]);
        if (!Object.hasOwn(state.cards, forkId)) problems.push(`aliases.${cardId} names missing card ${forkId}`);
        else if (!from || from.card !== cardId) problems.push(`aliases.${cardId} names ${forkId}, which is not a fork of ${cardId}`);
      }
      return problems;
    },
    settings() {
      return [];
    },
    cards(state, card) {
      const problems = linkProblems(state, "body_md", card.body_md);
      if (card.forked_from !== undefined) {
        const from = forkedFrom(card);
        if (!from) problems.push("forked_from is not <card>@<full commit hash>");
        else if (!Object.hasOwn(state.cards, from.card)) problems.push(`forked_from names missing card ${from.card}`);
      }
      return problems;
    },
    heads(state, chosen, conversationId) {
      return chosen.node === null ? [] : nodeOf(state, "node", chosen.node, conversationId);
    },
    nodes(state, node) {
      const problems = [];
      const parent = node.parent === null ? null : state.nodes[node.parent];
      if (node.parent !== null) problems.push(...nodeOf(state, "parent", node.parent, node.conversation));
      const upto = messageOf(state, "upto", node.upto, node.conversation);
      problems.push(...upto);
      if (!upto.length && parent && state.messages[parent.upto]
        && byTime(messageWithId(state, node.upto), messageWithId(state, parent.upto)) < 0) {
        problems.push(`upto ${node.upto} is earlier than parent ${node.parent}'s upto ${parent.upto}`);
      }
      for (const entry of node.digest) {
        if (!Object.hasOwn(state.cards, entry.card_id)) problems.push(`digest links missing card ${entry.card_id}`);
      }
      return problems;
    },
    messages(state, message) {
      return linkProblems(state, "body_md", message.body_md);
    },
    requests(state, request) {
      if (!Object.hasOwn(state.cards, request.card_id)) return [`card ${request.card_id} does not exist`];
      const arg = REQUEST_ARG[request.kind];
      const names = Object.keys(request.args);
      if (names.length !== 1 || names[0] !== arg) return [`args is not {${arg}}`];
      if (request.kind === "reconcile") {
        const problems = forkStatus(state, null, request.card_id) ? [] : [`card ${request.card_id} has no fork in this deck`];
        if (!COMMIT.test(request.args.commit)) problems.push("args.commit is not a full commit hash");
        return problems;
      }
      return messageOf(state, `args.${arg}`, request.args[arg], conversationOf(state, request.card_id));
    },
    results(state, result, requestId) {
      if (!state.requests[requestId]) return [`request ${requestId} does not exist`];
      if (result.status === "error" && !("error" in result)) return ["error is missing"];
      if (result.status !== "error" && "error" in result) return ["error is only for status error"];
      return [];
    },
  };

  function linkProblems(state, field, markdown) {
    return cardLinks(markdown).filter((cardId) => !Object.hasOwn(state.cards, cardId))
      .map((cardId) => `${field} links missing card ${cardId}`);
  }

  function nodeOf(state, field, nodeId, conversationId) {
    const node = state.nodes[nodeId];
    if (!node) return [`${field} ${nodeId} does not exist`];
    return node.conversation === conversationId ? []
      : [`${field} ${nodeId} belongs to conversation ${node.conversation}`];
  }

  function messageOf(state, field, messageId, conversationId) {
    const message = state.messages[messageId];
    return message && message.conversation === conversationId ? []
      : [`${field} ${messageId} is not a message of conversation ${conversationId}`];
  }

  /** Every problem with a deck and its library, one readable sentence each, prefixed with the
   *  file to fix (relative to the deck folder); [] is valid. Each document is checked against
   *  SCHEMA, and only a well-shaped document is checked against the cross-document RULES. */
  function checkDeck(state) {
    const problems = [];
    const checkDoc = (kind, docId, doc) => {
      const file = docPath(kind, docId);
      const own = [];
      if (docId !== undefined && !ID.test(docId)) own.push(`${file}: file name is not an id`);
      checkValue(file, "", doc, { type: "object", fields: SCHEMA[kind] }, own);
      if (!own.length) own.push(...RULES[kind](state, doc, docId).map((p) => `${file}: ${p}`));
      problems.push(...own);
    };
    if (!state.meta) problems.push("meta.json is missing");
    for (const kind of SINGLETONS) if (state[kind]) checkDoc(kind, undefined, state[kind]);
    for (const kind of COLLECTIONS) {
      for (const [docId, doc] of Object.entries(state[kind] || {})) checkDoc(kind, docId, doc);
    }
    return problems;
  }

  globalThis.DeckState = {
    SCHEMA, COLLECTIONS, LIBRARY, DECK, SINGLETONS, ID, COMMIT, DEFAULT_NVIM_SERVER, REQUEST_ARG, CAUSES,
    docPath, parseCard, formatCard, forkedFrom, parseFenceInfo, dynamicBlocks, blockKey, isOutOfDate,
    codeDocs, outOfDateBlocks, shownId, cardOf, deckCards, sectionOf, cardsInSection, isTermCard,
    definitionOf, conversationOf, forkStatus, behindForks, parseLink, head, conversation, undoTarget,
    children, pendingRequests, requestStatus, answerStatus, compressStatus, reconcileStatus, checkDeck,
  };
})();
