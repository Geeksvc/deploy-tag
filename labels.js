// Shared by content.js, background.js and options.js: turns a metadata URI into a badge label.
// kind: "tool"      = third-party deploy tool on an existing launchpad (colored by label)
//       "bundler"   = buys with many wallets at launch (solid orange-red)
//       "launchpad" = launchpad with its own site and rules (white outline)
//       "operator"  = one person's private script, bot or server (orange outline)
//       "warning"   = actively sketchy (solid red)
//       "quiet"     = general storage, says nothing about who launched (small grey)
//       "hide"      = show nothing
//       "new"       = domain not in any list yet (amber dashed, never stored on a rule)

const DEPLOY_TAG_KINDS = ['tool', 'bundler', 'launchpad', 'operator', 'warning', 'quiet', 'hide'];

const DEPLOY_TAG_KIND_INFO = {
  tool: { name: 'Tool', meaning: 'Third-party deploy tool launching on an existing launchpad' },
  bundler: { name: 'Bundler', meaning: 'Buys with many wallets at launch, so the dev controls the early supply' },
  launchpad: { name: 'Launchpad', meaning: 'A launchpad with its own site and rules' },
  operator: { name: 'Operator', meaning: "One person's private script, bot or server" },
  warning: { name: 'Warning', meaning: 'Actively sketchy: farm domains, impersonators, hidden devs, expiring files' },
  quiet: { name: 'Quiet', meaning: 'General storage, says nothing about who launched' },
  hide: { name: 'Hide', meaning: 'No badge' },
  new: { name: 'Unlabeled', meaning: 'Domain not in any list yet' }
};

// EVM chains. Adding a chain = one entry here (plus its RPC host in manifest.json).
//   alchemy:   Alchemy subdomain, RPC is https://<alchemy>.g.alchemy.com/v2/<KEY>
//   publicRpc: used when there's no Alchemy key and no override (BSC only)
//   sites:     the chain names GMGN / Axiom / BasedBot use in attributes and URLs
//   explorer:  where a badge click goes
const DEPLOY_TAG_EVM_CHAINS = {
  bsc: {
    name: 'BSC', tag: 'BSC', chainId: 56, alchemy: 'bnb-mainnet', publicRpc: 'https://bsc-dataseed.binance.org',
    sites: ['bsc', 'bnb'],
    explorer: { name: 'BscScan read contract', url: a => `https://bscscan.com/token/${a}#readProxyContract` }
  },
  robinhood: {
    name: 'Robinhood', tag: 'HOOD', chainId: 4663, alchemy: 'robinhood-mainnet',
    sites: ['robinhood'],
    explorer: { name: 'Blockscout read contract', url: a => `https://robinhoodchain.blockscout.com/address/${a}?tab=read_contract` }
  },
  base: {
    name: 'Base', tag: 'BASE', chainId: 8453, alchemy: 'base-mainnet',
    sites: ['base'],
    explorer: { name: 'BaseScan read contract', url: a => `https://basescan.org/token/${a}#readContract` }
  },
  eth: {
    name: 'Ethereum', tag: 'ETH', chainId: 1, alchemy: 'eth-mainnet',
    sites: ['eth', 'ethereum'],
    explorer: { name: 'Etherscan read contract', url: a => `https://etherscan.io/token/${a}#readContract` }
  },
  avalanche: {
    name: 'Avalanche', tag: 'AVAX', chainId: 43114, alchemy: 'avax-mainnet',
    sites: ['avalanche', 'avax'],
    explorer: { name: 'Snowtrace', url: a => `https://snowtrace.io/address/${a}` }
  }
};

const DEPLOY_TAG_EVM_CHAIN_IDS = Object.keys(DEPLOY_TAG_EVM_CHAINS);
const DEPLOY_TAG_CHAINS = ['sol', ...DEPLOY_TAG_EVM_CHAIN_IDS];
const DEPLOY_TAG_CHAIN_TAGS = { sol: 'SOL' };
DEPLOY_TAG_EVM_CHAIN_IDS.forEach(c => { DEPLOY_TAG_CHAIN_TAGS[c] = DEPLOY_TAG_EVM_CHAINS[c].tag; });
const DEPLOY_TAG_CHAIN_NAMES = { sol: 'Solana' };
DEPLOY_TAG_EVM_CHAIN_IDS.forEach(c => { DEPLOY_TAG_CHAIN_NAMES[c] = DEPLOY_TAG_EVM_CHAINS[c].name; });

// Where a badge click goes, per chain.
const DEPLOY_TAG_EXPLORERS = { sol: { name: 'Solscan metadata', url: a => `https://solscan.io/token/${a}#metadata` } };
DEPLOY_TAG_EVM_CHAIN_IDS.forEach(c => { DEPLOY_TAG_EXPLORERS[c] = DEPLOY_TAG_EVM_CHAINS[c].explorer; });

function deployTagExplorerUrl(chain, address) {
  const e = DEPLOY_TAG_EXPLORERS[chain] || DEPLOY_TAG_EXPLORERS.sol;
  return e.url(address);
}

// Site chain name ("bnb", "sol", "base", ...) -> our chain id, or null if unsupported.
function deployTagNormChain(c) {
  c = String(c || '').toLowerCase();
  if (c === 'sol' || c === 'solana') return 'sol';
  for (const id of DEPLOY_TAG_EVM_CHAIN_IDS) if (DEPLOY_TAG_EVM_CHAINS[id].sites.includes(c)) return id;
  return null;
}

// Settings key for a chain's RPC override: rpcBsc, rpcRobinhood, rpcBase, ...
const deployTagRpcKey = chain => 'rpc' + chain.charAt(0).toUpperCase() + chain.slice(1);

// Launchpads that keep no metadata on-chain: no lookup, just a tiny quiet badge.
// Match on chain + address suffix (case-insensitive).
const DEPLOY_TAG_SKIP = [
  { chain: 'bsc', suffix: '4444', label: '4m', name: 'four.meme' },
  { chain: 'bsc', suffix: 'ffff', label: '4m', name: 'four.meme' }
];

function deployTagSkipRule(chain, address) {
  const a = String(address || '').toLowerCase();
  return DEPLOY_TAG_SKIP.find(s => s.chain === chain && a.endsWith(s.suffix.toLowerCase())) || null;
}

const DEPLOY_TAG_DEFAULT_RULES = [
  // Tool
  { match: 'j7m.io', label: 'J7', kind: 'tool' },
  { match: 'j7tracker.io', label: 'J7', kind: 'tool' },
  { match: 'uxento.io', label: 'UXENTO', kind: 'tool' },
  { match: 'rapidlaunch.io', label: 'RAPIDLAUNCH', kind: 'tool' },
  { match: 'launchblitz.ai', label: 'LAUNCHBLITZ', kind: 'tool' },
  { match: 'extraction.live', label: 'TRACKTECH', kind: 'tool' },
  { match: 'notrandom.fun', label: 'NOTRANDOM', kind: 'tool' },
  { match: 'thesis-pad.quicknode-ipfs.com', label: 'THESISPAD', kind: 'tool' },
  { match: 'storage.googleapis.com/padre-user-content-store', label: 'PADRE', kind: 'tool' },
  // Bundler
  { match: 'vortexdeployer.com', label: 'VORTEX', kind: 'bundler' },
  { match: 'sumo-ipfs.quicknode-ipfs.com', label: 'SUMO', kind: 'bundler' },
  { match: 'launchops.xyz', label: 'LAUNCHOPS', kind: 'bundler' },
  { match: 'zeroday-beta-dun.vercel.app', label: 'ZERODAY', kind: 'bundler' },
  { match: 'launchlab-gated-web-production.up.railway.app', label: 'LL-BUNDLE', kind: 'bundler' },
  // Launchpad
  { match: 'labkit.trade', label: 'LABKIT', kind: 'launchpad' },
  { match: 'swarms.world', label: 'SWARMS', kind: 'launchpad' },
  { match: 'sumichan.fun', label: 'SUMICHAN', kind: 'launchpad' },
  { match: 'pumpv1.win', label: 'PUMPV1', kind: 'launchpad' },
  { match: 'stakepays.fun', label: 'STAKEPAYS', kind: 'launchpad' },
  { match: 'clusterai.fun', label: 'CLUSTER', kind: 'launchpad' },
  { match: 'riverdot.fun', label: 'RIVER', kind: 'launchpad' },
  { match: 'enigmasol.tech', label: 'ENIGMA', kind: 'launchpad' },
  { match: 'float.mypinata.cloud', label: 'FLOAT', kind: 'launchpad' },
  { match: 'rings.run', label: 'RINGS', kind: 'launchpad' },
  // Operator
  { match: 'levitatingbananatree.xyz', label: 'BANANATREE', kind: 'operator' },
  { match: 'gg.sc', label: 'GGSC', kind: 'operator' },
  { match: 'sajad.my', label: 'SAJAD-MY', kind: 'operator' },
  { match: 'pf.jake-98f.workers.dev', label: 'JAKE-WORKER', kind: 'operator' },
  { match: 'pumper.ink', label: 'PUMPER', kind: 'operator' },
  { match: 'cedarcdn.com', label: 'CEDAR', kind: 'operator' },
  { match: 'tokencdn.xyz', label: 'TOKENCDN', kind: 'operator' },
  { match: 'custom420tekk.com', label: '420TEKK', kind: 'operator' },
  { match: 'mkklk.xyz', label: 'MKKLK', kind: 'operator' },
  { match: 'drill.family', label: 'DRILL', kind: 'operator' },
  { match: 'the-island-servidor.workers.dev', label: 'ISLAND-WORKER', kind: 'operator' },
  { match: 'sslip.io', label: 'RAW-IP', kind: 'operator' },
  // Warning
  { match: 'sdfgsdfsdf.uk', label: 'FARM', kind: 'warning' },
  { match: 'lqsgqxmvlk.uk', label: 'FARM', kind: 'warning' },
  { match: 'lksdjgsgd.shop', label: 'FARM', kind: 'warning' },
  { match: 'ywecdnxwpa.uk', label: 'FARM', kind: 'warning' },
  { match: 'sdfrdsdfsdf.com', label: 'FARM', kind: 'warning' },
  { match: 'gatewaypinata.online', label: 'FAKE-PINATA', kind: 'warning' },
  { match: 'masquerade.cx', label: 'HIDDEN-DEV', kind: 'warning' },
  { match: 'uguu.se', label: 'EXPIRING', kind: 'warning' },
  // Quiet
  { match: 'pump.mypinata.cloud', label: 'pump', kind: 'quiet' },
  { match: 'ipfs.io', label: 'ipfs', kind: 'quiet' },
  { match: 'pinata.cloud', label: 'ipfs', kind: 'quiet' },
  { match: 'mypinata.cloud', label: 'ipfs', kind: 'quiet' },
  { match: 'filebase.io', label: 'ipfs', kind: 'quiet' },
  { match: 'fast-ipfs.com', label: 'ipfs', kind: 'quiet' },
  { match: 'cf-ipfs.com', label: 'ipfs', kind: 'quiet' },
  { match: 'dweb.link', label: 'ipfs', kind: 'quiet' },
  { match: 'nftstorage.link', label: 'ipfs', kind: 'quiet' },
  { match: 'w3s.link', label: 'ipfs', kind: 'quiet' },
  { match: 'quicknode-ipfs.com', label: 'ipfs', kind: 'quiet' },
  { match: 'arweave.net', label: 'arweave', kind: 'quiet' },
  { match: 'irys.xyz', label: 'arweave', kind: 'quiet' },
  { match: 'turbo-gateway.com', label: 'arweave', kind: 'quiet' },
  { match: 'storage.googleapis.com', label: 'gcs', kind: 'quiet' },
  { match: 'catbox.moe', label: 'catbox', kind: 'quiet' },
  { match: 'pollinations.ai', label: 'ai-img', kind: 'quiet' },
  { match: 'data:', label: 'inline', kind: 'quiet' }
];

const DEPLOY_TAG_BARE_CID = /^(Qm[1-9A-HJ-NP-Za-km-z]{44}|baf[yk][a-z2-7]{20,})(\/|$)/;

// URI -> { host, path }. path is lowercase, without query or hash, "" for the root.
function deployTagParse(uri) {
  if (!uri) return null;
  const u = String(uri).trim();
  if (!u) return null;
  if (/^data:/i.test(u)) return { host: 'data:', path: '' };
  if (/^ipfs:\/\//i.test(u)) return { host: 'ipfs.io', path: '' };
  if (/^ar:\/\//i.test(u)) return { host: 'arweave.net', path: '' };
  if (DEPLOY_TAG_BARE_CID.test(u)) return { host: 'ipfs.io', path: '' };
  try {
    const p = new URL(u);
    const host = p.hostname.toLowerCase().replace(/^www\./, '');
    if (!host) return null;
    return { host, path: p.pathname.toLowerCase().replace(/\/+$/, '') };
  } catch (e) {
    return null;
  }
}

function deployTagHost(uri) {
  const p = deployTagParse(uri);
  return p ? p.host : null;
}

// What a user types for a rule -> stored form: "host" or "host/path", lowercase, no scheme or www.
function deployTagNormalizeMatch(input) {
  let s = String(input || '').trim().toLowerCase();
  if (!s) return '';
  if (s === 'data:' || s === 'data') return 'data:';
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, '').replace(/[?#].*$/, '').replace(/^www\./, '');
  s = s.replace(/\/+$/, '');
  const slash = s.indexOf('/');
  const host = (slash < 0 ? s : s.slice(0, slash)).replace(/:\d+$/, '');
  const path = slash < 0 ? '' : s.slice(slash).replace(/\/{2,}/g, '/');
  return host ? host + path : '';
}

function deployTagSplitMatch(match) {
  const m = deployTagNormalizeMatch(match);
  if (!m) return null;
  if (m === 'data:') return { host: 'data:', path: '' };
  const slash = m.indexOf('/');
  return slash < 0 ? { host: m, path: '' } : { host: m.slice(0, slash), path: m.slice(slash) };
}

// Specificity of a rule that matched: more host labels first, then more path segments.
function deployTagRuleScore(rm) {
  const hostParts = rm.host === 'data:' ? 1 : rm.host.split('.').length;
  const pathParts = rm.path ? rm.path.split('/').filter(Boolean).length : 0;
  return hostParts * 100 + pathParts;
}

function deployTagRuleMatches(rm, parsed) {
  const { host, path } = parsed;
  if (!(host === rm.host || (rm.host !== 'data:' && host.endsWith('.' + rm.host)))) return false;
  if (!rm.path) return true;
  return path === rm.path || path.startsWith(rm.path + '/');
}

function deployTagShortName(host) {
  // "launch.uxento.io" -> "uxento", "j7m.io" -> "j7m"
  if (!host) return '?';
  if (host === 'data:') return 'inline';
  const parts = host.split('.');
  if (parts.length <= 1) return host;
  const twoPartTld = /^(co|com|net|org)\.[a-z]{2}$/.test(parts.slice(-2).join('.'));
  const idx = parts.length - (twoPartTld ? 3 : 2);
  return parts[Math.max(0, idx)];
}

// Most specific matching rule wins; on a tie the user's rule beats the built-in one.
function deployTagResolve(uri, userRules) {
  const parsed = deployTagParse(uri);
  if (!parsed) return { kind: 'none', label: '?', host: null };
  const host = parsed.host;
  const rules = [...(userRules || []).map(r => [r, true]), ...DEPLOY_TAG_DEFAULT_RULES.map(r => [r, false])];
  let best = null, bestScore = -1;
  for (const [r] of rules) {
    const rm = deployTagSplitMatch(r && r.match);
    if (!rm || !deployTagRuleMatches(rm, parsed)) continue;
    const score = deployTagRuleScore(rm);
    if (score > bestScore) { best = r; bestScore = score; }
  }
  if (best) {
    const kind = DEPLOY_TAG_KINDS.includes(best.kind) ? best.kind : 'tool';
    return { kind, label: best.label || deployTagShortName(host), host, match: best.match };
  }
  return { kind: 'new', label: deployTagShortName(host), host };
}

function deployTagHue(label) {
  let h = 0;
  for (const c of String(label)) h = (h * 31 + c.charCodeAt(0)) % 360;
  return h;
}

// "Domains seen" entry, upgraded from the v0.1 shape ({count, lastSeen, lastMint, exampleUri}).
function deployTagNormalizeSeen(d) {
  const e = Object.assign({}, d || {});
  e.count = e.count || 0;
  e.chains = Array.isArray(e.chains) ? e.chains : [];
  e.examples = Array.isArray(e.examples) ? e.examples : [];
  if (e.lastMint || e.exampleUri) {
    if (!e.examples.some(x => x.address === e.lastMint)) {
      e.examples.push({ chain: 'sol', address: e.lastMint || '', uri: e.exampleUri || '' });
    }
    if (!e.chains.includes('sol')) e.chains.push('sol');
    delete e.lastMint; delete e.exampleUri;
  }
  e.firstSeen = e.firstSeen || e.lastSeen || null;
  e.lastSeen = e.lastSeen || e.firstSeen || null;
  return e;
}
