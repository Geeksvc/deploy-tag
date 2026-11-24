importScripts('labels.js');

// Looks up metadata URIs and caches them.
//   sol: Helius (getAssetBatch, then the Token-2022 metadata extension for very new mints)
//   EVM: pass 1 (the badge waits for this, one round trip): the fast getters + launchFactory().
//        pass 2 (background, only for pass-1 misses): the other getters + eth_getCode (EIP-1167 template).
//        Hits whose domain is unlabeled also get eth_getCode in the background, for template clustering.
//        Optional deep scan reads the launch transaction's input when no getter answers.
//        Results found in the background are written to storage; open pages pick them up from there.
// Metadata on these tokens is almost always immutable, so a found URI is cached forever.
// Token ids: a Solana mint as-is (cache key "u:<mint>", unchanged since v0.1),
//            EVM as "<chain>:<lowercase address>" (cache key "u:<chain>:<address>").
// Cache values: Solana a URI string; EVM { uri, source, factory, template } (v0.2.0 stored a plain string).

const MISS_RETRY_MS = 15000;   // fresh tokens can take a few seconds to show up
const BATCH_WAIT_MS = 250;
const EVM_CALLS_PER_REQUEST = 100;   // per JSON-RPC batch (Alchemy / custom RPC)
const PUBLIC_CALLS_PER_REQUEST = 10; // bsc-dataseed rate-limits batches of more than ~10 eth_calls
const EVM_PARALLEL = 4;              // batches in flight per chain
const EVM_MAX_ATTEMPTS = 2;          // getters don't change after launch: first try + one retry for brand-new tokens
const DEEP_MISS_TTL_MS = 24 * 3600 * 1000;
const DEEP_SPACING_MS = 350;         // ~3 deep scans per second

// Known metadata getters, asked in this order; the first one that returns a usable link wins.
// fast: asked in pass 1 (covers flap, Pons, genius.fun, Doppler/Long.xyz); the rest only for pass-1 misses.
// Selector = first 4 bytes of keccak256(signature).
const GETTERS = [
  { name: 'metaURI', sel: '0x67605787', fast: true },  // metaURI()      flap (BSC)
  { name: 'logo', sel: '0xfb7f21eb', fast: true },     // logo()         Pons (Robinhood), genius.fun (BSC)
  { name: 'tokenURI', sel: '0x3c130d90', fast: true }, // tokenURI()     Doppler ERC20 V1 (Long.xyz), Zora-style
  { name: 'uri', sel: '0xeac989f8' },                  // uri()
  { name: 'metadataURI', sel: '0x03ee438c' },          // metadataURI()
  { name: 'metadata', sel: '0x392f37e9' },             // metadata()     Clanker-style, may return JSON text
  { name: 'image', sel: '0xf3ccaac0' },                // image()
  { name: 'imageUrl', sel: '0xaba83150' },             // imageUrl()     Clanker-style (Base)
  { name: 'imageURI', sel: '0x135d088d' }              // imageURI()
];
const SEL_LAUNCH_FACTORY = '0x536dac9b';      // launchFactory()
const EIP1167 = /^0x363d3d373d3d3d363d73([0-9a-f]{40})5af43d82803e903d91602b57fd5bf3$/i;

const memo = new Map();        // id -> uri string (Solana) or { uri, source, factory, template }
const misses = new Map();      // id -> time of last failed lookup
const evmAttempts = new Map(); // id -> getter attempts that found nothing
const waiting = new Map();     // id -> [resolve]
let queue = new Map();         // id -> { chain, address }
let timer = null;

// ---------- ids ----------

const EVM_ADDR = /^0x[0-9a-f]{40}$/;
const SOL_ADDR = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

function tokenId(chain, address) {
  return chain === 'sol' ? address : `${chain}:${address.toLowerCase()}`;
}

function parseToken(t) {
  if (!t || typeof t.address !== 'string') return null;
  const chain = t.chain || 'sol';
  if (chain === 'sol') return SOL_ADDR.test(t.address) ? { chain, address: t.address } : null;
  if (!DEPLOY_TAG_EVM_CHAINS[chain]) return null;
  const address = t.address.toLowerCase();
  return EVM_ADDR.test(address) ? { chain, address } : null;
}

// ---------- settings ----------

async function getSettings() {
  const rpcKeys = DEPLOY_TAG_EVM_CHAIN_IDS.map(deployTagRpcKey);
  const s = await chrome.storage.local.get(['heliusKey', 'alchemyKey', 'deepScan', 'explorerApi', 'explorerKey', 'rules', ...rpcKeys]);
  const rpc = {};
  DEPLOY_TAG_EVM_CHAIN_IDS.forEach(c => { rpc[c] = (s[deployTagRpcKey(c)] || '').trim(); });
  return {
    heliusKey: (s.heliusKey || '').trim(),
    alchemyKey: (s.alchemyKey || '').trim(),
    rpc,
    deepScan: !!s.deepScan,
    explorerApi: s.explorerApi === 'etherscan' ? 'etherscan' : 'blockscout',
    explorerKey: (s.explorerKey || '').trim(),
    rules: Array.isArray(s.rules) ? s.rules : []
  };
}

function evmRpcUrl(chain, s) {
  const c = DEPLOY_TAG_EVM_CHAINS[chain];
  if (!c) return '';
  if (s.rpc[chain]) return s.rpc[chain];
  if (s.alchemyKey) return `https://${c.alchemy}.g.alchemy.com/v2/${encodeURIComponent(s.alchemyKey)}`;
  return c.publicRpc || '';
}

const usesPublicRpc = (chain, s) => evmRpcUrl(chain, s) === DEPLOY_TAG_EVM_CHAINS[chain]?.publicRpc;

// ---------- Solana (Helius) ----------

async function rpc(key, method, params) {
  const res = await fetch(`https://mainnet.helius-rpc.com/?api-key=${encodeURIComponent(key)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 'deploy-tag', method, params })
  });
  if (!res.ok) throw new Error(`Helius ${res.status}`);
  const body = await res.json();
  if (body.error) throw new Error(body.error.message || 'Helius error');
  return body.result;
}

// Fallback for brand-new Token-2022 mints the DAS index hasn't caught yet:
// the URI sits in the mint account's tokenMetadata extension.
async function fromMintAccounts(key, mints) {
  const out = {};
  const result = await rpc(key, 'getMultipleAccounts', [mints, { encoding: 'jsonParsed' }]);
  (result?.value || []).forEach((acc, i) => {
    const exts = acc?.data?.parsed?.info?.extensions || [];
    const meta = exts.find(e => e.extension === 'tokenMetadata');
    if (meta?.state?.uri) out[mints[i]] = meta.state.uri;
  });
  return out;
}

async function lookupSol(key, mints) {
  const found = {};
  if (!key || !mints.length) return found;
  try {
    for (let i = 0; i < mints.length; i += 1000) {
      const chunk = mints.slice(i, i + 1000);
      const assets = await rpc(key, 'getAssetBatch', { ids: chunk });
      (assets || []).forEach(a => {
        const uri = a?.content?.json_uri;
        if (a?.id && uri) found[a.id] = uri;
      });
    }
    const left = mints.filter(m => !found[m]);
    for (let i = 0; i < left.length; i += 100) {
      Object.assign(found, await fromMintAccounts(key, left.slice(i, i + 100)));
    }
  } catch (e) {
    console.warn('[Deploy Tag] Solana lookup failed:', e.message);
  }
  return found;
}

// ---------- EVM decoding ----------

// ABI-encoded `string` return value -> JS string, or null for a revert / empty / malformed result.
function decodeAbiString(hex) {
  if (typeof hex !== 'string') return null;
  const h = hex.replace(/^0x/i, '');
  if (h.length < 128 || !/^[0-9a-f]*$/i.test(h)) return null;
  const offset = parseInt(h.slice(0, 64), 16);
  if (!Number.isSafeInteger(offset) || offset * 2 + 64 > h.length) return null;
  const start = offset * 2;
  const len = parseInt(h.slice(start, start + 64), 16);
  if (!Number.isSafeInteger(len) || len === 0) return null;
  const body = h.slice(start + 64, start + 64 + len * 2);
  if (body.length < len * 2) return null;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) bytes[i] = parseInt(body.substr(i * 2, 2), 16);
  const s = new TextDecoder('utf-8').decode(bytes).replace(/\0+/g, '').trim();
  return s || null;
}

// ABI-encoded `address` return value -> lowercase address, or null (zero address, revert, not an address).
function decodeAbiAddress(hex) {
  if (typeof hex !== 'string') return null;
  const h = hex.replace(/^0x/i, '').toLowerCase();
  if (h.length !== 64 || !/^0{24}[0-9a-f]{40}$/.test(h)) return null;
  const a = '0x' + h.slice(24);
  return /^0x0{40}$/.test(a) ? null : a;
}

// Runtime code of an EIP-1167 minimal proxy -> its implementation (template) address.
function decodeCloneTemplate(code) {
  const m = typeof code === 'string' && code.match(EIP1167);
  return m ? '0x' + m[1].toLowerCase() : null;
}

const LINK_START = /^(https?:\/\/\S+|ipfs:\/\/\S+|ar:\/\/\S+)$/i;
const LINK_ANYWHERE = /(https?:\/\/[^\s"'<>\\]+|ipfs:\/\/[^\s"'<>\\]+|ar:\/\/[^\s"'<>\\]+|data:[a-z]+\/[a-z0-9.+-]+[;,][^\s"'<>\\]*|\b(?:Qm[1-9A-HJ-NP-Za-km-z]{44}|baf[yk][a-z2-7]{50,})\b)/i;
const JSON_LINK_KEYS = ['image', 'uri', 'metadata', 'external_url', 'logo', 'imageUrl'];

function isUsableLink(s) {
  return typeof s === 'string' && (LINK_START.test(s) || /^data:/i.test(s) || DEPLOY_TAG_BARE_CID.test(s));
}

function linkFromJson(j, depth) {
  if (!j || typeof j !== 'object' || depth > 2) return null;
  if (Array.isArray(j)) {
    for (const v of j) { const r = linkFromJson(v, depth + 1); if (r) return r; }
    return null;
  }
  for (const k of JSON_LINK_KEYS) {
    const v = j[k];
    if (typeof v === 'string' && isUsableLink(v.trim())) return v.trim();
  }
  for (const k of JSON_LINK_KEYS) {
    if (j[k] && typeof j[k] === 'object') { const r = linkFromJson(j[k], depth + 1); if (r) return r; }
  }
  return null;
}

// A getter's string -> a usable link, or null. Handles plain links, JSON text and links buried in text.
function pickLink(text) {
  if (typeof text !== 'string') return null;
  const s = text.replace(/\0+/g, '').trim();
  if (!s) return null;
  if (isUsableLink(s)) return s;
  if (/^[{[]/.test(s)) {
    try {
      const r = linkFromJson(JSON.parse(s), 0);
      if (r) return r;
    } catch (e) { /* not JSON, fall through to scanning */ }
  }
  const m = s.match(LINK_ANYWHERE);
  return m ? m[1].replace(/[),.;\]}]+$/, '') : null;
}

// getter name -> decoded string, in GETTERS order -> { uri, source } or null
function pickResult(byGetter) {
  for (const g of GETTERS) {
    const link = pickLink(byGetter[g.name]);
    if (link) return { uri: link, source: g.name };
  }
  return null;
}

// Launch transaction input (hex) -> first link found in its printable ASCII runs, or null.
function linkFromTxInput(hex) {
  if (typeof hex !== 'string') return null;
  const h = hex.replace(/^0x/i, '');
  const runs = [];
  let cur = '';
  for (let i = 0; i + 1 < h.length; i += 2) {
    const b = parseInt(h.substr(i, 2), 16);
    if (b >= 0x20 && b <= 0x7e) cur += String.fromCharCode(b);
    else { if (cur.length >= 6) runs.push(cur); cur = ''; }
  }
  if (cur.length >= 6) runs.push(cur);
  for (const r of runs) {
    const m = r.match(LINK_ANYWHERE);
    if (m) return m[1].replace(/[),.;\]}]+$/, '');
  }
  return null;
}

// ---------- EVM lookups ----------

async function postJson(url, body) {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`RPC ${res.status}`);
  return res.json();
}

const getterCall = (address, g) => ({ method: 'eth_call', params: [{ to: address, data: g.sel }, 'latest'], what: g.name });
const codeCall = address => ({ method: 'eth_getCode', params: [address, 'latest'], what: 'code' });

// Calls per token for each pass:
//   1:    fast getters + launchFactory()  (4 calls; the badge waits for these)
//   2:    the other getters + eth_getCode (7 calls; pass-1 misses only, in the background)
//   code: eth_getCode only                (hits on unlabeled domains, for template clustering)
function passCalls(address, pass) {
  if (pass === 1) return [...GETTERS.filter(g => g.fast).map(g => getterCall(address, g)),
    { method: 'eth_call', params: [{ to: address, data: SEL_LAUNCH_FACTORY }, 'latest'], what: 'launchFactory' }];
  if (pass === 2) return [...GETTERS.filter(g => !g.fast).map(g => getterCall(address, g)), codeCall(address)];
  return [codeCall(address)];
}

async function pool(items, n, fn) {
  let next = 0;
  const worker = async () => { while (next < items.length) await fn(items[next++]); };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
}

// addresses -> { address: { getterName | "launchFactory" | "code": raw hex } }, batches sent in parallel.
async function evmPass(chain, addresses, s, pass) {
  const raw = {};
  addresses.forEach(a => { raw[a] = {}; });
  const url = evmRpcUrl(chain, s);
  if (!url || !addresses.length) return raw;
  const limit = usesPublicRpc(chain, s) ? PUBLIC_CALLS_PER_REQUEST : EVM_CALLS_PER_REQUEST;
  const perToken = passCalls('0x', pass).length;
  const tokensPerRequest = Math.max(1, Math.floor(limit / perToken));
  const groups = [];
  for (let i = 0; i < addresses.length; i += tokensPerRequest) groups.push(addresses.slice(i, i + tokensPerRequest));
  await pool(groups, EVM_PARALLEL, async group => {
    const calls = [];
    group.forEach(a => passCalls(a, pass).forEach(c => calls.push({ ...c, address: a })));
    const body = calls.map((c, id) => ({ jsonrpc: '2.0', id, method: c.method, params: c.params }));
    let json;
    try {
      json = await postJson(url, body);
      if (!Array.isArray(json)) throw new Error(json?.error?.message || 'RPC did not accept a batch');
    } catch (e) {
      console.warn(`[Deploy Tag] ${chain} lookup failed:`, e.message);
      return;
    }
    for (const r of json) {
      const c = typeof r?.id === 'number' ? calls[r.id] : null;
      if (!c || r.error || typeof r.result !== 'string') continue;
      raw[c.address][c.what] = r.result;
    }
  });
  return raw;
}

// Raw results for one token -> { uri, source, factory, template } (each may be null).
function interpret(r) {
  const strings = {};
  GETTERS.forEach(g => { strings[g.name] = decodeAbiString(r[g.name]); });
  const picked = pickResult(strings);
  return {
    uri: picked ? picked.uri : null,
    source: picked ? picked.source : null,
    factory: decodeAbiAddress(r.launchFactory),
    template: decodeCloneTemplate(r.code)
  };
}

// ---------- deep scan (launch transaction input) ----------

const deepActive = new Set();
let deepChain = Promise.resolve();

function deepScanEnqueue(fn) {
  const run = deepChain.then(fn);
  deepChain = run.catch(() => {}).then(() => new Promise(r => setTimeout(r, DEEP_SPACING_MS)));
  return run;
}

async function getJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// -> { txHash, factory } or null
async function creationTx(chain, address, s) {
  const id = DEPLOY_TAG_EVM_CHAINS[chain].chainId;
  const key = encodeURIComponent(s.explorerKey);
  const q = `module=contract&action=getcontractcreation&contractaddresses=${address}&apikey=${key}`;
  const first = r => (Array.isArray(r?.result) && r.result[0]) || null;
  if (s.explorerApi === 'etherscan') {
    const r = first(await getJson(`https://api.etherscan.io/v2/api?chainid=${id}&${q}`));
    return r?.txHash ? { txHash: r.txHash, factory: r.contractFactory || null } : null;
  }
  try {
    const r = first(await getJson(`https://api.blockscout.com/${id}/api?${q}`));
    if (r?.txHash) return { txHash: r.txHash, factory: r.contractFactory || null };
  } catch (e) { /* try the REST endpoint */ }
  const a = await getJson(`https://api.blockscout.com/${id}/api/v2/addresses/${address}?apikey=${key}`);
  const tx = a?.creation_transaction_hash || a?.creation_tx_hash;
  return tx ? { txHash: tx, factory: null } : null;
}

async function deepScan(chain, address, s) {
  const id = tokenId(chain, address);
  const url = evmRpcUrl(chain, s);
  if (!url) return null;
  const c = await creationTx(chain, address, s);
  if (!c) return null;
  const json = await postJson(url, { jsonrpc: '2.0', id: 1, method: 'eth_getTransactionByHash', params: [c.txHash] });
  const link = linkFromTxInput(json?.result?.input);
  const factory = c.factory && /^0x[0-9a-fA-F]{40}$/.test(c.factory) ? c.factory.toLowerCase() : null;
  return link ? { uri: link, source: 'tx-input', factory } : null;
}

// Runs in the background after a getter miss; the content script picks the result up on its next retry.
async function startDeepScans(items, s, extra) {
  if (!s.deepScan || !s.explorerKey || !items.length) return;
  const ids = items.map(([id]) => id).filter(id => !deepActive.has(id));
  if (!ids.length) return;
  const marks = await chrome.storage.local.get(ids.map(id => 'd:' + id));
  for (const [id, t] of items) {
    if (deepActive.has(id)) continue;
    const at = marks['d:' + id];
    if (at && Date.now() - at < DEEP_MISS_TTL_MS) continue;
    deepActive.add(id);
    deepScanEnqueue(async () => {
      try {
        const r = await deepScan(t.chain, t.address, s);
        if (r) {
          const e = extra[id] || {};
          const v = { uri: r.uri, source: r.source, factory: e.factory || r.factory || null, template: e.template || null };
          memo.set(id, v);
          misses.delete(id);
          await chrome.storage.local.set({ ['u:' + id]: v });
          await chrome.storage.local.remove('d:' + id);
          await recordDomains([{ chain: t.chain, address: t.address, ...v }]);
        } else {
          await chrome.storage.local.set({ ['d:' + id]: Date.now() });
        }
      } catch (e) {
        console.warn('[Deploy Tag] deep scan failed:', e.message);
      } finally {
        deepActive.delete(id);
      }
    });
  }
}

// ---------- domains seen ----------

async function recordDomains(entries) {
  const { seenDomains = {} } = await chrome.storage.local.get('seenDomains');
  const now = Date.now();
  for (const { chain, address, uri, source, factory, template } of entries) {
    const host = deployTagHost(uri) || String(uri).slice(0, 40);
    const d = deployTagNormalizeSeen(seenDomains[host]);
    d.count += 1;
    d.firstSeen = d.firstSeen || now;
    d.lastSeen = now;
    if (!d.chains.includes(chain)) d.chains.push(chain);
    const ex = { chain, address, uri };
    if (source) ex.source = source;
    if (factory) ex.factory = factory;
    if (template) ex.template = template;
    d.examples = [ex, ...d.examples.filter(x => x.address !== address)].slice(0, 5);
    seenDomains[host] = d;
  }
  await chrome.storage.local.set({ seenDomains });
}

// ---------- queue ----------

const asEntry = v => (v && typeof v === 'object' ? v : v ? { uri: v } : null);
// What the content script gets back: a Solana URI string, or { uri, source } for EVM.
const forContent = (chain, v) => {
  if (!v) return null;
  if (chain === 'sol') return typeof v === 'string' ? v : v.uri;
  const e = asEntry(v);
  return e && e.uri ? { uri: e.uri, source: e.source || null } : null;
};

async function flush() {
  timer = null;
  const items = [...queue.entries()];
  queue = new Map();
  if (!items.length) return;

  const s = await getSettings();
  const byChain = {};
  items.forEach(([, t]) => (byChain[t.chain] = byChain[t.chain] || []).push(t.address));

  // Pass 1: Solana + fast EVM getters, all chains in parallel. This is the only part the badge waits for.
  const chains = Object.keys(byChain);
  const results = await Promise.all(chains.map(c =>
    c === 'sol' ? lookupSol(s.heliusKey, byChain.sol) : evmPass(c, byChain[c], s, 1)));
  const raw = {};
  chains.forEach((c, i) => { raw[c] = results[i]; });

  const found = {};
  const toStore = {};
  const seen = [];
  const missed = [];   // [id, token, pass-1 result] -> pass 2
  const unlabeled = []; // [id, token] hits on unlabeled domains -> template lookup
  for (const [id, t] of items) {
    if (t.chain === 'sol') {
      const r = raw.sol[t.address];
      if (r) { found[id] = r; seen.push({ chain: 'sol', address: t.address, uri: r }); }
    } else {
      const r = interpret(raw[t.chain][t.address] || {});
      if (r.uri) {
        const v = { uri: r.uri, source: r.source };
        if (r.factory) v.factory = r.factory;
        found[id] = v;
        seen.push({ chain: t.chain, address: t.address, ...v });
        if (deployTagResolve(r.uri, s.rules).kind === 'new') unlabeled.push([id, t]);
      } else {
        evmAttempts.set(id, (evmAttempts.get(id) || 0) + 1);
        missed.push([id, t, r]);
      }
    }
    if (found[id]) {
      memo.set(id, found[id]);
      misses.delete(id);
      toStore['u:' + id] = found[id];
    } else {
      misses.set(id, Date.now());
    }
  }
  if (seen.length) {
    await chrome.storage.local.set(toStore);
    await recordDomains(seen);
  }
  for (const [id, t] of items) {
    (waiting.get(id) || []).forEach(res => res(forContent(t.chain, found[id])));
    waiting.delete(id);
  }
  followUp(missed, unlabeled, s).catch(e => console.warn('[Deploy Tag] follow-up failed:', e.message));
}

// Background work after the badge is shown: pass 2 for misses, templates for unlabeled hits, then deep scan.
// Anything found is stored under "u:<id>"; open pages listen for that and update the badge.
async function followUp(missed, unlabeled, s) {
  const chainsOf = list => [...new Set(list.map(([, t]) => t.chain))];
  const jobs = [];

  for (const chain of chainsOf(missed)) {
    const list = missed.filter(([, t]) => t.chain === chain);
    jobs.push(evmPass(chain, list.map(([, t]) => t.address), s, 2).then(async raw2 => {
      const toStore = {}, seen = [], deepItems = [], extra = {};
      for (const [id, t, r1] of list) {
        const r = interpret(raw2[t.address] || {});
        const factory = r1.factory || null, template = r.template || null;
        if (r.uri) {
          const v = { uri: r.uri, source: r.source };
          if (factory) v.factory = factory;
          if (template) v.template = template;
          memo.set(id, v);
          misses.delete(id);
          evmAttempts.delete(id);
          toStore['u:' + id] = v;
          seen.push({ chain, address: t.address, ...v });
        } else {
          extra[id] = { factory, template };
          deepItems.push([id, t]);
        }
      }
      if (seen.length) {
        await chrome.storage.local.set(toStore);
        await recordDomains(seen);
      }
      await startDeepScans(deepItems, s, extra);
    }));
  }

  for (const chain of chainsOf(unlabeled)) {
    const list = unlabeled.filter(([, t]) => t.chain === chain);
    jobs.push(evmPass(chain, list.map(([, t]) => t.address), s, 'code').then(async raw => {
      for (const [id, t] of list) {
        const template = decodeCloneTemplate(raw[t.address]?.code);
        if (template) await patchTemplate(id, chain, t.address, template);
      }
    }));
  }
  await Promise.all(jobs);
}

// Add a template to an already-stored hit and to its "Domains seen" example.
async function patchTemplate(id, chain, address, template) {
  const v = asEntry(memo.get(id));
  if (!v || !v.uri) return;
  const nv = { ...v, template };
  memo.set(id, nv);
  const { seenDomains = {} } = await chrome.storage.local.get('seenDomains');
  const host = deployTagHost(nv.uri) || String(nv.uri).slice(0, 40);
  const d = seenDomains[host];
  if (d && Array.isArray(d.examples)) {
    d.examples = d.examples.map(x => (x.address === address && x.chain === chain ? { ...x, template } : x));
  }
  await chrome.storage.local.set({ ['u:' + id]: nv, ...(d ? { seenDomains } : {}) });
}

// tokens: [{ chain, address }] -> { id: uri (Solana) | { uri, source } (EVM) | { skip, label, name } | null }
async function lookup(tokens) {
  const result = {};
  const need = [];
  for (const raw of tokens) {
    const t = parseToken(raw);
    if (!t) continue;
    const id = tokenId(t.chain, t.address);
    const skip = t.chain !== 'sol' && deployTagSkipRule(t.chain, t.address);
    if (skip) { result[id] = { skip: true, label: skip.label, name: skip.name }; continue; }
    if (memo.has(id)) result[id] = forContent(t.chain, memo.get(id));
    else need.push([id, t]);
  }
  if (need.length) {
    const stored = await chrome.storage.local.get(need.map(([id]) => 'u:' + id));
    for (const [id, t] of need) {
      const v = stored['u:' + id];
      if (v) { memo.set(id, v); result[id] = forContent(t.chain, v); }
    }
  }
  const pending = [];
  for (const [id, t] of need) {
    if (result[id]) continue;
    const last = misses.get(id);
    if (last && Date.now() - last < MISS_RETRY_MS) { result[id] = null; continue; }
    // EVM getters don't change after launch: after one retry, stop asking (deep scan may still find it).
    if (t.chain !== 'sol' && (evmAttempts.get(id) || 0) >= EVM_MAX_ATTEMPTS) { result[id] = null; continue; }
    pending.push(new Promise(resolve => {
      if (!waiting.has(id)) waiting.set(id, []);
      waiting.get(id).push(v => { result[id] = v; resolve(); });
      queue.set(id, t);
    }));
  }
  if (pending.length && !timer) timer = setTimeout(flush, BATCH_WAIT_MS);
  await Promise.all(pending);
  return result;
}

// ---------- migration ----------
// v0.1 -> v0.2: rule kinds and the "Domains seen" shape.
// v0.2.0 -> v0.2.1: EVM "not found" results were never stored, so they're retried automatically;
//                   only stale deep-scan marks (none existed before) would need clearing.

async function migrate() {
  const s = await chrome.storage.local.get(['schema', 'rules', 'seenDomains']);
  if (s.schema >= 3) return;
  const out = { schema: 3 };
  if (!(s.schema >= 2)) {
    if (Array.isArray(s.rules)) {
      // tool / launchpad / quiet / hide stay as they are; anything unknown becomes a tool.
      out.rules = s.rules.map(r => ({ ...r, kind: DEPLOY_TAG_KINDS.includes(r.kind) ? r.kind : 'tool' }));
    }
    if (s.seenDomains && typeof s.seenDomains === 'object') {
      out.seenDomains = {};
      for (const [host, d] of Object.entries(s.seenDomains)) out.seenDomains[host] = deployTagNormalizeSeen(d);
    }
  }
  await chrome.storage.local.set(out);
}
const migrated = migrate().catch(e => console.warn('[Deploy Tag] migration failed:', e.message));

// ---------- messages ----------

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'lookup' && (Array.isArray(msg.tokens) || Array.isArray(msg.mints))) {
    const tokens = msg.tokens || msg.mints.map(address => ({ chain: 'sol', address }));
    migrated.then(() => lookup(tokens.slice(0, 2000))).then(sendResponse);
    return true;
  }
  if (msg?.type === 'clearCache') {
    memo.clear(); misses.clear(); evmAttempts.clear();
    chrome.storage.local.get(null).then(all => {
      const keys = Object.keys(all).filter(k => k.startsWith('u:') || k.startsWith('d:'));
      return chrome.storage.local.remove(keys);
    }).then(() => sendResponse({ ok: true }));
    return true;
  }
});

chrome.action.onClicked.addListener(() => chrome.runtime.openOptionsPage());
chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  await migrated;
  if (reason === 'install' && !(await getSettings()).heliusKey) chrome.runtime.openOptionsPage();
});
