// The deck's data model: every rule about what a deck folder holds and what the page derives
// from it. Loaded by the page as a plain script and by Node as a side-effect import; both read
// globalThis.DeckState.
(function () {
  /**
   * @typedef {Object} Meta  meta.json, written by the agent.
   * @property {string} title
   * @property {string} worktree  Absolute path of the worktree the deck explains.
   * @property {string[]} order  Card ids in reading order; lists every card exactly once.
   *
   * @typedef {Object} Settings  settings.json, written by the server.
   * @property {string} nvim_server  Neovim server address `goto` opens files in.
   *
   * @typedef {Object} Card  cards/<id>.json, written by the agent.
   * @property {string} title
   * @property {string} body_md
   *
   * @typedef {Object} Head  heads/<card>.json, written by the server when the user picks a node.
   * @property {string|null} node  Chosen node, or null for the conversation before any compress.
   * @property {string} at  When the choice was made.
   *
   * @typedef {Object} DigestEntry
   * @property {"question"|"concept"} kind
   * @property {string} text
   * @property {string} card_id  Card the entry links to.
   *
   * @typedef {Object} Node  nodes/<id>.json, written once by the agent per compress.
   * @property {string} card_id
   * @property {string|null} parent  Head of the card when the compress ran.
   * @property {string} upto  Last message the digest covers.
   * @property {DigestEntry[]} digest
   * @property {string} created_at
   *
   * @typedef {Object} Message  messages/<id>.json; the server writes user messages, the agent
   *   writes claude messages.
   * @property {string} card_id
   * @property {"user"|"claude"} role
   * @property {string} body_md
   * @property {string} created_at
   *
   * @typedef {Object} Request  requests/<id>.json, written by the server for the agent to serve.
   * @property {"answer"|"compress"} kind
   * @property {string} card_id
   * @property {{message: string}|{upto: string}} args  The one argument REQUEST_ARG names.
   * @property {string} created_at
   *
   * @typedef {Object} Result  results/<request id>.json, written by the agent when it is done.
   * @property {"done"|"error"} status
   * @property {string} [error]  Sentence for the user; present exactly when status is error.
   * @property {string} created_at
   *
   * @typedef {Object} State
   * @property {Meta|null} meta
   * @property {Settings|null} settings
   * @property {Object<string, Card>} cards
   * @property {Object<string, Head>} heads
   * @property {Object<string, Node>} nodes
   * @property {Object<string, Message>} messages
   * @property {Object<string, Request>} requests
   * @property {Object<string, Result>} results
   * @property {string[]} [unreadable]  Files readDeck could not parse and had no copy of.
   */

  const ID = /^[A-Za-z0-9_-]{1,100}$/;
  const DEFAULT_NVIM_SERVER = "/tmp/raconteur-deck.sock";
  const SINGLETONS = ["meta", "settings"];
  const COLLECTIONS = ["cards", "heads", "nodes", "messages", "requests", "results"];

  /** Each request kind takes exactly one argument, a message id of the request's card. */
  const REQUEST_ARG = { answer: "message", compress: "upto" };

  const id = { type: "id" };
  const text = { type: "string" };
  const time = { type: "time" };

  /** Field specs per document kind; every field is required unless `optional`, and a document
   *  holds no field the table does not list. */
  const SCHEMA = {
    meta: { title: text, worktree: text, order: { type: "list", of: id } },
    settings: { nvim_server: text },
    cards: { title: text, body_md: text },
    heads: { node: { type: "id", nullable: true }, at: time },
    nodes: {
      card_id: id,
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
      card_id: id, role: { type: "string", enum: ["user", "claude"] }, body_md: text,
      created_at: time,
    },
    requests: {
      kind: { type: "string", enum: Object.keys(REQUEST_ARG) },
      card_id: id,
      args: { type: "object", fields: { message: { ...id, optional: true }, upto: { ...id, optional: true } } },
      created_at: time,
    },
    results: {
      status: { type: "string", enum: ["done", "error"] }, error: { ...text, optional: true },
      created_at: time,
    },
  };

  /** Where a document lives inside the deck folder. */
  function docPath(kind, docId) {
    return SINGLETONS.includes(kind) ? `${kind}.json` : `${kind}/${docId}.json`;
  }

  /** Times are ISO 8601 UTC exactly as `new Date().toISOString()` prints them, so string order
   *  is time order. */
  function isTime(value) {
    return typeof value === "string" && !isNaN(Date.parse(value))
      && new Date(value).toISOString() === value;
  }

  /** Reads a dynamic block's fence info: an optional first-token language (absent when that
   *  token is an attribute), then `file=` (required), `lines=a-b` or `lines=a`, and `sha=`.
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
    return {
      lang: tokens[0].includes("=") ? null : tokens[0],
      file,
      start: lines ? Number(lines[1]) : null,
      end: lines ? Number(lines[2] || lines[1]) : null,
      sha: sha ? sha[0] : null,
    };
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

  function ofCard(map, cardId) {
    return withIds(map).filter((doc) => doc.card_id === cardId).sort(byTime);
  }

  /** A card's head is whichever happened last: the user's choice in heads/<card>.json or the
   *  card's newest node, so a compress moves the head with no head write. A choice made at the
   *  same instant as the newest node wins. */
  function head(state, cardId) {
    const chosen = state.heads[cardId];
    const newest = ofCard(state.nodes, cardId).pop();
    if (!newest) return chosen ? chosen.node : null;
    return chosen && chosen.at >= newest.created_at ? chosen.node : newest.id;
  }

  /** What the agent and the page read as a card's conversation: the head's digest, then the
   *  card's messages after the head's `upto`. With `upto`, only messages up to and including it:
   *  the input of a compress. */
  function conversation(state, cardId, { upto } = {}) {
    const headId = head(state, cardId);
    const node = headId ? state.nodes[headId] : null;
    const after = node ? messageWithId(state, node.upto) : null;
    const until = upto ? messageWithId(state, upto) : null;
    const messages = ofCard(state.messages, cardId).filter((m) =>
      (!after || byTime(m, after) > 0) && (!until || byTime(m, until) <= 0));
    return { head: headId, digest: node ? node.digest : [], messages };
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
    return ofCard(state.nodes, cardId).filter((n) => n.parent === (nodeId || null));
  }

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

  function newestRequest(state, cardId, kind, matches) {
    const found = ofCard(state.requests, cardId).filter((r) => r.kind === kind && matches(r)).pop();
    return found ? requestStatus(state, found.id) : null;
  }

  /** Whether a user message is answered, waiting or failed, from its newest answer request;
   *  null when nothing asked for an answer to it. */
  function answerStatus(state, messageId) {
    const message = state.messages[messageId];
    if (!message) return null;
    return newestRequest(state, message.card_id, "answer", (r) => r.args.message === messageId);
  }

  /** Whether a card's newest compress is done, waiting or failed; null when it was never
   *  compressed. */
  function compressStatus(state, cardId) {
    return newestRequest(state, cardId, "compress", () => true);
  }

  const TYPES = {
    string: [(v) => typeof v === "string", "a string"],
    id: [(v) => typeof v === "string" && ID.test(v), "an id"],
    time: [isTime, "an ISO UTC time"],
    list: [Array.isArray, "a list"],
    object: [(v) => v !== null && typeof v === "object" && !Array.isArray(v), "an object"],
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
    if (spec.of) value.forEach((item, i) => checkValue(file, `${where}[${i}]`, item, spec.of, problems));
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
      meta.order.forEach((cardId, i) => {
        if (!state.cards[cardId]) problems.push(`order lists missing card ${cardId}`);
        if (meta.order.indexOf(cardId) !== i) problems.push(`order lists card ${cardId} twice`);
      });
      for (const cardId of Object.keys(state.cards)) {
        if (!meta.order.includes(cardId)) problems.push(`order leaves out card ${cardId}`);
      }
      return problems;
    },
    settings() {
      return [];
    },
    cards(state, card) {
      return linkProblems(state, "body_md", card.body_md);
    },
    heads(state, chosen, cardId) {
      if (!state.cards[cardId]) return [`card ${cardId} does not exist`];
      return chosen.node === null ? [] : nodeOfCard(state, "node", chosen.node, cardId);
    },
    nodes(state, node) {
      if (!state.cards[node.card_id]) return [`card ${node.card_id} does not exist`];
      const problems = [];
      const parent = node.parent === null ? null : state.nodes[node.parent];
      if (node.parent !== null) problems.push(...nodeOfCard(state, "parent", node.parent, node.card_id));
      const upto = messageOfCard(state, "upto", node.upto, node.card_id);
      problems.push(...upto);
      if (!upto.length && parent && state.messages[parent.upto]
        && byTime(messageWithId(state, node.upto), messageWithId(state, parent.upto)) < 0) {
        problems.push(`upto ${node.upto} is earlier than parent ${node.parent}'s upto ${parent.upto}`);
      }
      for (const entry of node.digest) {
        if (!state.cards[entry.card_id]) problems.push(`digest links missing card ${entry.card_id}`);
      }
      return problems;
    },
    messages(state, message) {
      if (!state.cards[message.card_id]) return [`card ${message.card_id} does not exist`];
      return linkProblems(state, "body_md", message.body_md);
    },
    requests(state, request) {
      if (!state.cards[request.card_id]) return [`card ${request.card_id} does not exist`];
      const arg = REQUEST_ARG[request.kind];
      const names = Object.keys(request.args);
      if (names.length !== 1 || names[0] !== arg) return [`args is not {${arg}}`];
      return messageOfCard(state, `args.${arg}`, request.args[arg], request.card_id);
    },
    results(state, result, requestId) {
      if (!state.requests[requestId]) return [`request ${requestId} does not exist`];
      if (result.status === "error" && !("error" in result)) return ["error is missing"];
      if (result.status !== "error" && "error" in result) return ["error is only for status error"];
      return [];
    },
  };

  function linkProblems(state, field, markdown) {
    return cardLinks(markdown).filter((cardId) => !state.cards[cardId])
      .map((cardId) => `${field} links missing card ${cardId}`);
  }

  function nodeOfCard(state, field, nodeId, cardId) {
    const node = state.nodes[nodeId];
    if (!node) return [`${field} ${nodeId} does not exist`];
    return node.card_id === cardId ? [] : [`${field} ${nodeId} belongs to card ${node.card_id}`];
  }

  function messageOfCard(state, field, messageId, cardId) {
    const message = state.messages[messageId];
    return message && message.card_id === cardId ? []
      : [`${field} ${messageId} is not a message of card ${cardId}`];
  }

  /** Every problem with a deck, one readable sentence each, prefixed with the file to fix; []
   *  is valid. Each document is checked against SCHEMA, and only a well-shaped document is
   *  checked against the cross-document RULES. */
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
    SCHEMA, COLLECTIONS, SINGLETONS, ID, DEFAULT_NVIM_SERVER, REQUEST_ARG,
    docPath, parseFenceInfo, parseLink, head, conversation, undoTarget, children,
    pendingRequests, requestStatus, answerStatus, compressStatus, checkDeck,
  };
})();
