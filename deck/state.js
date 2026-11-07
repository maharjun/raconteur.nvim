// The deck's data model: what the page shows, and what a valid deck looks like.
// Loaded by the page as a plain script and by Node (tests, check.mjs) as a
// side-effect import; both read globalThis.DeckState.
//
// A deck state is { meta, cards, nodes, messages, actions }, each of the last
// four a map from document id to document, as stored in the deck folder.
(function () {
  const DIGEST_KINDS = ["question", "concept"];

  // Same attributes the raconteur parser reads, plus `sha=` (the commit the
  // copied lines came from). Returns null for a plain code fence.
  function parseFenceInfo(info) {
    const text = (info || "").trim();
    const file = /(?:^|\s)file=(\S+)/.exec(text);
    if (!file) return null;
    const lang = /^(\S+)/.exec(text)[1];
    const lines = /(?:^|\s)lines=(\d+)(?:-(\d+))?(?:\s|$)/.exec(text);
    const sha = /(?:^|\s)sha=([0-9a-f]+)(?:\s|$)/.exec(text);
    return {
      lang: lang.startsWith("file=") ? "" : lang,
      file: file[1],
      start: lines ? Number(lines[1]) : null,
      end: lines ? Number(lines[2] || lines[1]) : null,
      sha: sha ? sha[1] : null,
    };
  }

  // card://<id> and walkthrough://<path>#<heading> are the deck's own links;
  // http(s) links open in a new tab; anything else is not followed.
  function parseLink(href) {
    const card = /^card:\/\/([A-Za-z0-9_-]+)$/.exec(href || "");
    if (card) return { kind: "card", id: card[1] };
    const walk = /^walkthrough:\/\/([^#]+)(?:#(.+))?$/.exec(href || "");
    if (walk) return { kind: "walkthrough", path: walk[1], heading: walk[2] || null };
    if (/^https?:\/\//.test(href || "")) return { kind: "web", href };
    return null;
  }

  function byTime(a, b) {
    return a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1
      : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  }

  function withIds(map) {
    return Object.entries(map || {}).map(([id, doc]) => ({ ...doc, id }));
  }

  // A card's conversation: the head node's digest, then every message of the
  // card the head does not cover, oldest first.
  function conversation(state, cardId) {
    const card = state.cards[cardId];
    const head = card && card.head ? state.nodes[card.head] : null;
    const covered = new Set(head ? head.covers : []);
    const messages = withIds(state.messages)
      .filter((m) => m.card_id === cardId && !covered.has(m.id))
      .sort(byTime);
    return { digest: head ? head.digest : [], messages };
  }

  // Undo moves a card's head to the head's parent (null is the conversation
  // before its first compression); redo moves it to one of these children.
  function children(state, cardId, nodeId) {
    return withIds(state.nodes)
      .filter((n) => n.card_id === cardId && (n.parent || null) === (nodeId || null))
      .sort(byTime);
  }

  function undoTarget(state, cardId) {
    const head = state.cards[cardId] && state.cards[cardId].head;
    if (!head) return undefined;
    return state.nodes[head] ? state.nodes[head].parent || null : undefined;
  }

  // Every rule a compression must keep. Returns readable problems; [] is valid.
  function checkDeck(state) {
    const problems = [];
    const order = (state.meta && state.meta.order) || [];
    for (const id of order) {
      if (!state.cards[id]) problems.push(`order lists missing card ${id}`);
    }
    for (const id of Object.keys(state.cards)) {
      if (!order.includes(id)) problems.push(`card ${id} is not in order`);
      const head = state.cards[id].head;
      if (head && !state.nodes[head]) problems.push(`card ${id} head ${head} does not exist`);
      if (head && state.nodes[head] && state.nodes[head].card_id !== id) {
        problems.push(`card ${id} head ${head} belongs to card ${state.nodes[head].card_id}`);
      }
    }
    for (const [id, node] of Object.entries(state.nodes)) {
      const parent = node.parent ? state.nodes[node.parent] : null;
      if (node.parent && !parent) problems.push(`node ${id} parent ${node.parent} does not exist`);
      if (parent && parent.card_id !== node.card_id) {
        problems.push(`node ${id} parent ${node.parent} belongs to another card`);
      }
      const covers = new Set(node.covers || []);
      for (const m of (parent && parent.covers) || []) {
        if (!covers.has(m)) problems.push(`node ${id} drops message ${m} covered by its parent`);
      }
      for (const m of covers) {
        const msg = state.messages[m];
        if (!msg) problems.push(`node ${id} covers missing message ${m}`);
        else if (msg.card_id !== node.card_id) problems.push(`node ${id} covers message ${m} of another card`);
      }
      for (const entry of node.digest || []) {
        if (!DIGEST_KINDS.includes(entry.kind)) problems.push(`node ${id} digest kind ${entry.kind} is unknown`);
        if (!state.cards[entry.card_id]) problems.push(`node ${id} digest links missing card ${entry.card_id}`);
      }
    }
    for (const [id, msg] of Object.entries(state.messages)) {
      if (!state.cards[msg.card_id]) problems.push(`message ${id} belongs to missing card ${msg.card_id}`);
      if (msg.reply_to && !state.messages[msg.reply_to]) {
        problems.push(`message ${id} replies to missing message ${msg.reply_to}`);
      }
    }
    return problems;
  }

  globalThis.DeckState = { parseFenceInfo, parseLink, conversation, children, undoTarget, checkDeck };
})();
