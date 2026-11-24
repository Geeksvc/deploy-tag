// Finds tokens on GMGN, Axiom and BasedBot and puts a deploy-tool badge next to the name.
// Each site has its own small adapter; if a site changes its layout, only its adapter needs fixing.
// Chains: "sol" plus every EVM chain in DEPLOY_TAG_EVM_CHAINS (labels.js); site names like Axiom's "bnb" map to ours.

(() => {
  const SOL = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
  const EVM = /^0x[0-9a-fA-F]{40}$/;
  const ADDR = '([1-9A-HJ-NP-Za-km-z]{32,44}|0x[0-9a-fA-F]{40})';
  const RETRY_MS = 16000;
  const MAX_TRIES = 4;
  const SKIP = 'skip';

  const uris = new Map();     // id -> uri | null | "skip"
  const sources = new Map();  // id -> getter name / "tx-input" (EVM only)
  const tries = new Map();    // id -> { n, at }
  const inflight = new Set();
  let rules = [];
  let keys = { sol: false };  // chain -> can we look it up at all
  let hideFourMeme = false;   // hides every skip-list badge (the setting predates the skip list)
  let version = 0;

  const insertAfter = (ref, node) => ref.parentNode && ref.parentNode.insertBefore(node, ref.nextSibling);

  const normChain = deployTagNormChain;
  // { chain, mint } if the address is valid for the chain, else null. EVM addresses are lowercased.
  const token = (chain, addr) => {
    chain = normChain(chain);
    if (!chain || !addr) return null;
    if (chain === 'sol') return SOL.test(addr) ? { chain, mint: addr } : null;
    return EVM.test(addr) ? { chain, mint: addr.toLowerCase() } : null;
  };
  const idOf = t => (t.chain === 'sol' ? t.mint : `${t.chain}:${t.mint}`);

  // ---------- site adapters ----------
  // collect() returns [{ chain, mint, container, place(badge), page }]
  // cardSel / cardToken(card) / pageToken() are also used by cleanup() to spot stale badges on reused cards.
  // cardToken returns the card's current { chain, mint }, or null if the adapter would skip that card.

  const urlChain = name => normChain(new URLSearchParams(location.search).get(name));

  const axiom = {
    cardSel: '[data-pulse-token-address]',
    cardToken(card) {
      const addr = card.getAttribute('data-pulse-token-address');
      const own = card.getAttribute('data-pulse-chain') ||
        (card.closest('[data-pulse-chain]') || card.querySelector('[data-pulse-chain]') || { getAttribute: () => null })
          .getAttribute('data-pulse-chain');
      const chain = own || urlChain('pulseChains') || (SOL.test(addr || '') ? 'sol' : null);
      return token(chain, addr);
    },
    pageToken() {
      const m = location.pathname.match(new RegExp(`^/token/${ADDR}`));
      if (!m) return null;
      return token(urlChain('chain') || (m[1].startsWith('0x') ? null : 'sol'), m[1]);
    },
    collect() {
      const out = [];
      document.querySelectorAll(this.cardSel).forEach(card => {
        const t = this.cardToken(card);
        if (!t) return;
        const top = card.querySelector('[data-pulse-island-clearance="top"]');
        const row = top && top.querySelector('.flex.min-w-0.flex-row.items-center');
        if (row) out.push({ ...t, container: card, place: b => row.appendChild(b) });
      });
      const t = this.pageToken();
      const anchor = t && document.querySelector('[data-pair-summary-budget-row]');
      if (anchor) out.push({ ...t, container: anchor.parentNode, page: true, place: b => insertAfter(anchor, b) });
      return out;
    }
  };

  const gmgn = {
    cardSel: '[data-trenches-token-address]',
    cardToken(card) {
      return token(card.getAttribute('data-trenches-token-chain') || 'sol', card.getAttribute('data-trenches-token-address'));
    },
    pageToken() {
      const m = location.pathname.match(new RegExp(`^/([a-z]+)/token/${ADDR}`));
      return m ? token(m[1], m[2]) : null;
    },
    collect() {
      const out = [];
      document.querySelectorAll(this.cardSel).forEach(card => {
        const t = this.cardToken(card);
        if (!t) return;
        const row = card.querySelector('[class*="group/token-translation"]');
        if (!row) return;
        out.push({
          ...t, container: card,
          place: b => (row.children[1] ? insertAfter(row.children[1], b) : row.appendChild(b))
        });
      });
      const t = this.pageToken();
      const sym = t && document.getElementById('token-base-symbol');
      const anchor = sym && sym.parentElement && sym.parentElement.parentElement;
      if (anchor) out.push({ ...t, container: anchor.parentNode, page: true, place: b => insertAfter(anchor, b) });
      return out;
    }
  };

  // BasedBot: ticker row = flex row whose first child is the bold ticker; badge goes after the name.
  const BB_LINK = new RegExp(`/token/([a-z]+)/${ADDR}`);
  const bbNameRow = root => {
    for (const row of root.querySelectorAll('div.flex.items-center.min-w-0.overflow-hidden')) {
      const first = row.firstElementChild;
      if (first && /font-semibold/.test(first.className) && row.children.length >= 2) return row;
    }
    return null;
  };
  const basedbot = {
    cardSel: 'a[href*="/token/"]',
    cardToken(card) {
      const m = (card.getAttribute('href') || '').match(BB_LINK);
      return m ? token(m[1], m[2]) : null;
    },
    pageToken() {
      const m = location.pathname.match(new RegExp(`^/token/([a-z]+)/${ADDR}`));
      return m ? token(m[1], m[2]) : null;
    },
    collect() {
      const out = [];
      document.querySelectorAll(this.cardSel).forEach(card => {
        const t = this.cardToken(card);
        if (!t) return;
        const row = bbNameRow(card);
        if (row) out.push({ ...t, container: card, place: b => insertAfter(row.children[1], b) });
      });
      const t = this.pageToken();
      if (t) {
        const main = document.querySelector('main') || document.body;
        for (const row of main.querySelectorAll('div.flex.items-center.min-w-0.overflow-hidden')) {
          const first = row.firstElementChild;
          if (first && first.tagName === 'BUTTON' && /font-semibold/.test(first.className) &&
              row.children.length >= 2 && !row.closest(this.cardSel)) {
            out.push({ ...t, container: row, page: true, place: b => insertAfter(row.children[1], b) });
            break;
          }
        }
      }
      return out;
    }
  };

  const host = location.hostname;
  const site = host.endsWith('axiom.trade') ? axiom : host.endsWith('gmgn.ai') ? gmgn : host.endsWith('basedbot.app') ? basedbot : null;
  if (!site) return;

  // ---------- badge ----------

  const stop = e => { e.stopPropagation(); e.stopImmediatePropagation(); };
  const keyHint = chain => (chain === 'sol' ? 'Add your Helius key in Deploy Tag settings'
    : 'Add your Alchemy key (or an RPC URL) in Deploy Tag settings');

  function badgeInfo(it, uri) {
    if (uri === undefined) return null;
    if (uri === SKIP) {
      const rule = deployTagSkipRule(it.chain, it.mint);
      return hideFourMeme || !rule ? null : { kind: 'quiet', label: rule.label, skip: rule };
    }
    if (uri === null) return { kind: 'none', label: keys[it.chain] ? '?' : 'key' };
    return deployTagResolve(uri, rules);
  }

  function makeBadge(it, uri) {
    const info = badgeInfo(it, uri);
    if (!info || info.kind === 'hide') return null;
    const { chain, mint } = it;
    const explorer = DEPLOY_TAG_EXPLORERS[chain];

    const b = document.createElement('span');
    b.className = `dtag dtag-${info.kind}${it.page ? ' dtag-page' : ''}`;
    b.dataset.mint = mint;
    b.dataset.chain = chain;
    b.dataset.v = String(version);
    b.setAttribute('role', 'link');
    b.tabIndex = 0;
    b.textContent = info.label;
    if (info.kind === 'tool') b.style.setProperty('--dtag-h', deployTagHue(info.label));
    const source = sources.get(idOf(it));
    const from = source ? `\nSource: ${source === 'tx-input' ? 'launch transaction (tx-input)' : `getter ${source}()`}` : '';
    b.title = info.skip ? `${info.skip.name}: no metadata on-chain`
      : uri ? `${info.label} — ${uri}${from}\nClick to open ${explorer.name}`
      : keys[chain] ? `No metadata URI found yet. Click to open ${explorer.name}`
      : keyHint(chain);

    const open = e => {
      stop(e); e.preventDefault();
      window.open(deployTagExplorerUrl(chain, mint), '_blank', 'noopener');
    };
    ['pointerdown', 'mousedown', 'mouseup', 'pointerup', 'touchstart'].forEach(t => b.addEventListener(t, stop, true));
    b.addEventListener('click', open, true);
    b.addEventListener('auxclick', open, true);
    b.addEventListener('keydown', e => { if (e.key === 'Enter') open(e); });
    return b;
  }

  // ---------- lookups ----------

  async function request(list) {
    list.forEach(t => inflight.add(idOf(t)));
    let res = {};
    try {
      res = (await chrome.runtime.sendMessage({ type: 'lookup', tokens: list.map(t => ({ chain: t.chain, address: t.mint })) })) || {};
    } catch (e) {
      // extension was reloaded; this page needs a refresh
    }
    for (const t of list) {
      const id = idOf(t);
      inflight.delete(id);
      // Solana: a URI string. EVM: { uri, source }, or { skip } for the skip list.
      const v = res[id] || null;
      const uri = v && typeof v === 'object' ? (v.skip ? SKIP : v.uri || null) : v;
      if (v && typeof v === 'object' && v.source) sources.set(id, v.source);
      uris.set(id, uri);
      if (!uri) {
        const tr = tries.get(id) || { n: 0 };
        tries.set(id, { n: tr.n + 1, at: Date.now() });
      }
    }
    schedule();
  }

  function needsLookup(t) {
    const id = idOf(t);
    if (inflight.has(id)) return false;
    if (!uris.has(id)) return true;
    if (uris.get(id) || !keys[t.chain]) return false;
    const tr = tries.get(id);
    return tr && tr.n < MAX_TRIES && Date.now() - tr.at > RETRY_MS;
  }

  // ---------- scan ----------

  // Reused cards keep their old badge when they switch to a skipped or different token; drop those.
  function cleanup() {
    document.querySelectorAll('.dtag:not([data-page])').forEach(b => {
      const card = b.closest(site.cardSel);
      const t = card && site.cardToken(card);
      if (!t || t.mint !== b.dataset.mint || t.chain !== b.dataset.chain) b.remove();
    });
    const t = site.pageToken();
    document.querySelectorAll('.dtag[data-page]').forEach(b => {
      if (!t || t.mint !== b.dataset.mint || t.chain !== b.dataset.chain) b.remove();
    });
  }

  function scan() {
    cleanup();
    const items = site.collect();
    const want = new Map();
    for (const it of items) {
      const id = idOf(it);
      if (it.chain !== 'sol' && !uris.has(id) && deployTagSkipRule(it.chain, it.mint)) uris.set(id, SKIP);
      if (needsLookup(it)) want.set(id, it);
      const uri = uris.get(id);
      const existing = it.page
        ? document.querySelector('.dtag[data-page]')
        : it.container.querySelector('.dtag:not([data-page])');
      if (existing && existing.dataset.mint === it.mint && existing.dataset.chain === it.chain &&
          existing.dataset.v === String(version) && existing.dataset.state === String(uri)) continue;
      if (existing) existing.remove();
      const b = makeBadge(it, uri);
      if (!b) continue;
      b.dataset.state = String(uri);
      if (it.page) b.dataset.page = '1';
      it.place(b);
    }
    const ask = [], none = [];
    want.forEach(t => (keys[t.chain] ? ask : none).push(t));
    none.forEach(t => uris.set(idOf(t), null));
    if (none.length) schedule(); // draw the "key" badge now instead of waiting for the next page change
    if (ask.length) request(ask);
  }

  let scheduled = false;
  function schedule() {
    if (scheduled) return;
    scheduled = true;
    setTimeout(() => { scheduled = false; scan(); }, 250);
  }

  async function loadSettings() {
    const rpcKeys = DEPLOY_TAG_EVM_CHAIN_IDS.map(deployTagRpcKey);
    const s = await chrome.storage.local.get(['rules', 'heliusKey', 'alchemyKey', 'hideFourMeme', ...rpcKeys]);
    rules = Array.isArray(s.rules) ? s.rules : [];
    hideFourMeme = !!s.hideFourMeme;
    const had = keys;
    const filled = v => !!(v && String(v).trim());
    keys = { sol: filled(s.heliusKey) };
    // An EVM chain works with the Alchemy key, its own RPC override, or a public RPC (BSC).
    DEPLOY_TAG_EVM_CHAIN_IDS.forEach(c => {
      keys[c] = filled(s.alchemyKey) || filled(s[deployTagRpcKey(c)]) || !!DEPLOY_TAG_EVM_CHAINS[c].publicRpc;
    });
    // A key just got added: forget the "no key" misses for that chain so they're looked up now.
    const gained = Object.keys(keys).filter(c => keys[c] && !had[c]);
    if (gained.length) {
      uris.forEach((v, id) => {
        const chain = id.includes(':') ? id.split(':')[0] : 'sol';
        if (v === null && gained.includes(chain)) { uris.delete(id); tries.delete(id); }
      });
    }
    version++;
    schedule();
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (Object.keys(changes).some(k => k === 'rules' || k === 'heliusKey' || k === 'alchemyKey' || k === 'hideFourMeme' ||
        /^rpc[A-Z]/.test(k))) loadSettings();
    // A URI found in the background (second getter pass, deep scan) for a token showing "?": update it now.
    let late = false;
    for (const [k, { newValue: v }] of Object.entries(changes)) {
      if (!k.startsWith('u:') || !v) continue;
      const id = k.slice(2);
      if (!uris.has(id) || uris.get(id) !== null) continue;
      const uri = typeof v === 'string' ? v : v.uri;
      if (!uri) continue;
      uris.set(id, uri);
      if (typeof v === 'object' && v.source) sources.set(id, v.source);
      late = true;
    }
    if (late) schedule();
  });
  // Attribute changes catch reused cards that switch token in place (React often only updates attributes/text).
  new MutationObserver(schedule).observe(document.body, {
    childList: true, subtree: true, attributes: true,
    attributeFilter: ['data-trenches-token-address', 'data-trenches-token-chain', 'data-pulse-token-address', 'data-pulse-chain', 'href']
  });
  setInterval(schedule, 5000); // picks up retries for brand-new tokens
  loadSettings();
})();
