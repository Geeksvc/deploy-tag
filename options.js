const $ = id => document.getElementById(id);
let rules = [];
let seenFilter = 'all';

const KIND_ORDER = ['tool', 'bundler', 'launchpad', 'operator', 'warning', 'quiet', 'hide'];
const EVM = DEPLOY_TAG_EVM_CHAINS;
const CHAIN_NAMES = DEPLOY_TAG_CHAIN_NAMES;
const alchemyUrl = (chain, key) => `https://${EVM[chain].alchemy}.g.alchemy.com/v2/${encodeURIComponent(key)}`;
const UNLABELED_INSTRUCTIONS = 'Each entry is a token metadata domain seen by Deploy Tag. For each one, find out what it is and who runs it, and classify it as one of: tool, bundler, launchpad, operator, warning, quiet. Check the example tokens on the linked explorer, look for tool names stamped in the token description, check whether the creation transaction pays a fee to a non-launchpad wallet, and check whether one creator wallet launches everything. Cite sources and give a confidence level. Return a JSON array of {match, label, kind}.';

// ---------- small helpers ----------

function el(tag, props, ...kids) {
  const e = document.createElement(tag);
  Object.assign(e, props || {});
  kids.forEach(k => e.append(k));
  return e;
}

function preview(match, label, kind) {
  if (kind === 'hide') return el('span', { className: 'dtag-hide', textContent: 'hidden' });
  const e = el('span', { className: `dtag dtag-${kind}` });
  e.textContent = label || deployTagShortName(deployTagSplitMatch(match)?.host || 'domain.io');
  if (kind === 'tool') e.style.setProperty('--dtag-h', deployTagHue(e.textContent));
  return e;
}

function chainTags(chains) {
  const wrap = el('span', { className: 'chains' });
  DEPLOY_TAG_CHAINS.filter(c => (chains || []).includes(c)).forEach(c =>
    wrap.append(el('span', { className: `chain chain-${c}`, textContent: DEPLOY_TAG_CHAIN_TAGS[c] })));
  return wrap;
}

function kindSelect(value, onChange) {
  const s = document.createElement('select');
  KIND_ORDER.forEach(v => s.append(el('option', { value: v, textContent: DEPLOY_TAG_KIND_INFO[v].name })));
  s.value = KIND_ORDER.includes(value) ? value : 'tool';
  if (onChange) s.addEventListener('change', () => onChange(s.value));
  return s;
}

function td(child, className) {
  const c = el('td', className ? { className } : {});
  if (child !== undefined && child !== null) c.append(child);
  return c;
}

function ago(t) {
  if (!t) return '';
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function download(name, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = el('a', { href: url, download: name });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function setStatus(id, cls, text) { const s = $(id); s.className = 'status' + (cls ? ' ' + cls : ''); s.textContent = text; }

// ---------- legend, rules, built-ins ----------

function renderLegend() {
  const box = $('legend');
  box.textContent = '';
  [...KIND_ORDER, 'new'].forEach(k => {
    const info = DEPLOY_TAG_KIND_INFO[k];
    const sample = { tool: 'J7', bundler: 'VORTEX', launchpad: 'LABKIT', operator: 'PUMPER', warning: 'FARM', quiet: 'ipfs', new: 'newtool' }[k];
    box.append(el('div', { className: 'legend-row' },
      el('span', { className: 'legend-badge' }, preview('', sample, k)),
      el('b', { textContent: info.name }),
      el('span', { className: 'hint inline', textContent: info.meaning })));
  });
}

async function saveRules() {
  await chrome.storage.local.set({ rules });
  renderRules();
  renderSeen();
}

function renderRules() {
  const tb = $('rules').querySelector('tbody');
  tb.textContent = '';
  rules.forEach((r, i) => {
    const m = el('input', { value: r.match, className: 'mono' });
    m.addEventListener('change', () => { rules[i].match = deployTagNormalizeMatch(m.value) || rules[i].match; saveRules(); });
    const l = el('input', { value: r.label || '' });
    l.addEventListener('change', () => { rules[i].label = l.value.trim(); saveRules(); });
    const k = kindSelect(r.kind, v => { rules[i].kind = v; saveRules(); });
    const del = el('button', { className: 'ghost small', textContent: 'Remove' });
    del.addEventListener('click', () => { rules.splice(i, 1); saveRules(); });
    tb.append(el('tr', {}, td(m), td(l), td(k), td(preview(r.match, r.label, r.kind)), td(del)));
  });
  if (!rules.length) tb.append(el('tr', {}, el('td', { colSpan: 5, className: 'num', textContent: 'No labels of your own yet.' })));
}

function renderDefaults() {
  const tb = $('defaults').querySelector('tbody');
  tb.textContent = '';
  KIND_ORDER.forEach(kind => DEPLOY_TAG_DEFAULT_RULES.filter(r => r.kind === kind).forEach(r => {
    tb.append(el('tr', {}, td(r.match, 'mono'), td(DEPLOY_TAG_KIND_INFO[kind].name), td(preview(r.match, r.label, r.kind))));
  }));
}

// ---------- domains seen ----------

async function loadSeen() {
  const { seenDomains = {} } = await chrome.storage.local.get('seenDomains');
  return Object.entries(seenDomains).map(([host, d]) => {
    const e = deployTagNormalizeSeen(d);
    const uri = e.examples[0]?.uri || (host === 'data:' ? 'data:,' : 'https://' + host);
    return { host, d: e, info: deployTagResolve(uri, rules) };
  }).sort((a, b) => (b.d.lastSeen || 0) - (a.d.lastSeen || 0));
}

function passesFilter(row, f) {
  if (f === 'all') return true;
  if (f === 'unlabeled') return row.info.kind === 'new';
  if (f.startsWith('kind:')) return row.info.kind === f.slice(5);
  if (f.startsWith('chain:')) return row.d.chains.includes(f.slice(6));
  return true;
}

function renderFilter() {
  const s = $('seenFilter');
  s.textContent = '';
  s.append(el('option', { value: 'all', textContent: 'All domains' }), el('option', { value: 'unlabeled', textContent: 'Unlabeled only' }));
  const kinds = el('optgroup', { label: 'By type' });
  KIND_ORDER.forEach(k => kinds.append(el('option', { value: 'kind:' + k, textContent: DEPLOY_TAG_KIND_INFO[k].name })));
  const chains = el('optgroup', { label: 'By chain' });
  DEPLOY_TAG_CHAINS.forEach(c => chains.append(el('option', { value: 'chain:' + c, textContent: CHAIN_NAMES[c] })));
  s.append(kinds, chains);
  s.value = seenFilter;
}

async function renderSeen() {
  const all = await loadSeen();
  const list = all.filter(r => passesFilter(r, seenFilter));
  const tb = $('seen').querySelector('tbody');
  tb.textContent = '';
  $('seenEmpty').style.display = all.length ? 'none' : '';
  $('seen').style.display = all.length ? '' : 'none';
  $('seenCount').textContent = all.length ? `${list.length} of ${all.length}` : '';
  list.forEach(({ host, d, info }) => {
    const ex = d.examples[0];
    const link = el('a', { textContent: host, target: '_blank', title: ex?.uri || '' });
    if (ex?.address) link.href = deployTagExplorerUrl(ex.chain, ex.address);
    link.style.color = 'inherit';
    const btn = el('button', { className: 'ghost small', textContent: 'Label' });
    btn.addEventListener('click', () => {
      $('newMatch').value = host;
      $('newLabel').value = deployTagShortName(host).toUpperCase();
      $('newLabel').focus();
      $('newLabel').scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
    tb.append(el('tr', {}, td(link, 'mono'), td(chainTags(d.chains)), td(String(d.count), 'num'), td(ago(d.lastSeen), 'num'),
      td(preview(host, info.label, info.kind)), td(btn)));
  });
  if (all.length && !list.length) tb.append(el('tr', {}, el('td', { colSpan: 6, className: 'num', textContent: 'Nothing matches this filter.' })));
}

// ---------- export ----------

function exportEntry({ host, d, info }) {
  return {
    domain: host,
    current_badge: { label: info.kind === 'hide' ? '' : info.label, type: info.kind === 'new' ? 'unlabeled' : info.kind },
    count: d.count,
    chains: DEPLOY_TAG_CHAINS.filter(c => d.chains.includes(c)),
    first_seen: d.firstSeen ? new Date(d.firstSeen).toISOString() : null,
    last_seen: d.lastSeen ? new Date(d.lastSeen).toISOString() : null,
    examples: d.examples.map(x => ({
      chain: x.chain, address: x.address, uri: x.uri,
      source: x.source ? (x.source === 'tx-input' ? 'tx-input' : `getter: ${x.source}`) : (x.chain === 'sol' ? 'solana-metadata' : null),
      factory: x.factory || null,
      template: x.template || null,
      explorer: x.address ? deployTagExplorerUrl(x.chain, x.address) : null
    }))
  };
}

// Unlabeled export: group domains by launchFactory() address and by EIP-1167 template, so a new launchpad shows up as a cluster.
function clusters(entries) {
  const by = field => {
    const m = {};
    entries.forEach(e => e.examples.forEach(x => {
      if (!x[field]) return;
      const k = `${x.chain}:${x[field]}`;
      m[k] = m[k] || { chain: x.chain, [field]: x[field], domains: [], tokens: 0 };
      if (!m[k].domains.includes(e.domain)) m[k].domains.push(e.domain);
      m[k].tokens++;
    }));
    return Object.values(m).sort((a, b) => b.domains.length - a.domains.length || b.tokens - a.tokens);
  };
  return { by_factory: by('factory'), by_template: by('template') };
}

function csvCell(v) {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCsv(entries) {
  const head = ['domain', 'badge_label', 'badge_type', 'count', 'chains', 'first_seen', 'last_seen', 'example_chains',
    'example_addresses', 'example_uris', 'example_sources', 'example_factories', 'example_templates', 'example_explorers'];
  const col = (e, f) => e.examples.map(x => x[f] || '').join(' | ');
  const rows = entries.map(e => [
    e.domain, e.current_badge.label, e.current_badge.type, e.count, e.chains.join(' '), e.first_seen, e.last_seen,
    col(e, 'chain'), col(e, 'address'), col(e, 'uri'), col(e, 'source'), col(e, 'factory'), col(e, 'template'), col(e, 'explorer')
  ]);
  return [head, ...rows].map(r => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

async function exportDomains(unlabeledOnly) {
  const all = await loadSeen();
  const entries = all.filter(r => !unlabeledOnly || r.info.kind === 'new').map(exportEntry);
  const base = `deploy-tag-${unlabeledOnly ? 'unlabeled' : 'domains'}-${today()}`;
  if ($('exportFormat').value === 'csv') {
    download(base + '.csv', toCsv(entries), 'text/csv');
  } else {
    const doc = unlabeledOnly
      ? { instructions: UNLABELED_INSTRUCTIONS, exported_at: new Date().toISOString(), clusters: clusters(entries), domains: entries }
      : { exported_at: new Date().toISOString(), domains: entries };
    download(base + '.json', JSON.stringify(doc, null, 2), 'application/json');
  }
}

// ---------- import ----------

let pendingImport = null;

function parseImport(text) {
  let data;
  try { data = JSON.parse(text); } catch (e) { return { error: `That isn't valid JSON (${e.message}).` }; }
  if (data && !Array.isArray(data) && Array.isArray(data.labels)) data = data.labels;
  if (data && !Array.isArray(data) && Array.isArray(data.rules)) data = data.rules;
  if (!Array.isArray(data)) return { error: 'Expected a JSON array of {match, label, kind}.' };
  const valid = new Map(), skipped = [];
  data.forEach((row, i) => {
    const n = i + 1;
    if (!row || typeof row !== 'object' || Array.isArray(row)) { skipped.push(`Row ${n}: not an object`); return; }
    const match = deployTagNormalizeMatch(row.match);
    if (!match) { skipped.push(`Row ${n}: missing or invalid "match"`); return; }
    const kind = String(row.kind || '').trim().toLowerCase();
    if (!KIND_ORDER.includes(kind)) { skipped.push(`Row ${n} (${match}): invalid kind "${row.kind ?? ''}"`); return; }
    if (row.label !== undefined && row.label !== null && typeof row.label !== 'string' && typeof row.label !== 'number') {
      skipped.push(`Row ${n} (${match}): "label" must be text`); return;
    }
    valid.set(match, { match, label: row.label === undefined || row.label === null ? '' : String(row.label).trim(), kind });
  });
  const added = [], changed = [], same = [];
  valid.forEach(r => {
    const old = rules.find(x => deployTagNormalizeMatch(x.match) === r.match);
    if (!old) added.push(r);
    else if ((old.label || '') === r.label && old.kind === r.kind) same.push(r);
    else changed.push({ old, r });
  });
  return { added, changed, same, skipped };
}

function renderImport(res) {
  const box = $('importResult');
  box.textContent = '';
  pendingImport = null;
  if (res.error) { box.append(el('p', { className: 'status err', textContent: res.error })); return; }
  const { added, changed, same, skipped } = res;
  box.append(el('p', { className: 'hint', textContent:
    `${added.length} to add, ${changed.length} to change, ${same.length} unchanged, ${skipped.length} skipped.` }));
  if (added.length || changed.length) {
    const t = el('table', { className: 'preview-table' });
    t.append(el('thead', {}, el('tr', {}, el('th', { textContent: '' }), el('th', { textContent: 'Domain' }),
      el('th', { textContent: 'Now' }), el('th', { textContent: 'After import' }))));
    const tb = el('tbody');
    added.forEach(r => tb.append(el('tr', {}, td('Add', 'num'), td(r.match, 'mono'), td('—', 'num'), td(preview(r.match, r.label, r.kind)))));
    changed.forEach(({ old, r }) => tb.append(el('tr', {}, td('Change', 'num'), td(r.match, 'mono'),
      td(preview(old.match, old.label, old.kind)), td(preview(r.match, r.label, r.kind)))));
    t.append(tb);
    box.append(t);
  }
  if (skipped.length) {
    box.append(el('p', { className: 'status err', textContent: 'Skipped:' }));
    const ul = el('ul', { className: 'skipped' });
    skipped.forEach(s => ul.append(el('li', { textContent: s })));
    box.append(ul);
  }
  if (added.length || changed.length) {
    pendingImport = res;
    const apply = el('button', { textContent: `Import ${added.length + changed.length} label${added.length + changed.length === 1 ? '' : 's'}` });
    const cancel = el('button', { className: 'ghost', textContent: 'Cancel' });
    apply.addEventListener('click', async () => {
      if (!pendingImport) return;
      pendingImport.changed.forEach(({ old, r }) => Object.assign(old, { match: r.match, label: r.label, kind: r.kind }));
      pendingImport.added.forEach(r => rules.push(r));
      const n = pendingImport.added.length + pendingImport.changed.length;
      pendingImport = null;
      await saveRules();
      $('importText').value = '';
      $('importResult').textContent = '';
      $('importResult').append(el('p', { className: 'status ok', textContent: `Imported ${n} label${n === 1 ? '' : 's'}.` }));
    });
    cancel.addEventListener('click', () => { pendingImport = null; $('importResult').textContent = ''; });
    box.append(el('div', { className: 'row' }, apply, cancel));
  }
}

// ---------- keys and RPC ----------

async function rpcCall(url, method, params) {
  const res = await fetch(url, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: params || [] })
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.error) throw new Error(body.error?.message || `HTTP ${res.status}`);
  return body.result;
}

async function checkChain(chain, url) {
  try {
    const id = await rpcCall(url, 'eth_chainId');
    if (parseInt(id, 16) !== EVM[chain].chainId) return { chain, ok: false, msg: `wrong chain (${id})` };
    return { chain, ok: true, msg: 'OK' };
  } catch (e) {
    return { chain, ok: false, msg: e.message };
  }
}

function renderChainStatus(listId, results) {
  const ul = $(listId);
  ul.textContent = '';
  results.forEach(r => ul.append(el('li', { className: r.ok ? 'ok' : 'err' },
    el('span', { className: `chain chain-${r.chain}`, textContent: DEPLOY_TAG_CHAIN_TAGS[r.chain] }),
    ` ${CHAIN_NAMES[r.chain]}: ${r.msg}`)));
}

// Explorer API reachability per chain (free tiers differ per chain).
async function checkExplorer(api, key, chain) {
  const id = EVM[chain].chainId;
  const k = encodeURIComponent(key);
  const url = api === 'etherscan'
    ? `https://api.etherscan.io/v2/api?chainid=${id}&module=proxy&action=eth_blockNumber&apikey=${k}`
    : `https://api.blockscout.com/${id}/api?module=block&action=eth_block_number&apikey=${k}`;
  try {
    const res = await fetch(url);
    const body = await res.json().catch(() => ({}));
    if (!res.ok) return { chain, ok: false, msg: `HTTP ${res.status}` };
    if (typeof body.result === 'string' && /^0x[0-9a-f]+$/i.test(body.result)) return { chain, ok: true, msg: 'OK' };
    return { chain, ok: false, msg: String(body.result || body.message || body.error?.message || 'not available').slice(0, 120) };
  } catch (e) {
    return { chain, ok: false, msg: e.message };
  }
}

function toggleShow(inputId, btnId) {
  const k = $(inputId); const show = k.type === 'password';
  k.type = show ? 'text' : 'password'; $(btnId).textContent = show ? 'Hide' : 'Show';
}

// ---------- init and events ----------

async function init() {
  const rpcKeys = DEPLOY_TAG_EVM_CHAIN_IDS.map(deployTagRpcKey);
  const s = await chrome.storage.local.get(['heliusKey', 'alchemyKey', 'hideFourMeme', 'rules', 'deepScan', 'explorerApi', 'explorerKey', ...rpcKeys]);
  $('key').value = s.heliusKey || '';
  $('alchemyKey').value = s.alchemyKey || '';
  DEPLOY_TAG_EVM_CHAIN_IDS.forEach(c => {
    $('evmTags').append(el('span', { className: `chain chain-${c}`, textContent: EVM[c].tag }), ' ');
    const input = el('input', { id: 'rpc-' + c, className: 'grow mono', spellcheck: false, value: s[deployTagRpcKey(c)] || '',
      placeholder: EVM[c].publicRpc || `https://${EVM[c].alchemy}.g.alchemy.com/v2/…` });
    $('rpcRows').append(el('div', { className: 'row' }, el('label', { className: 'lbl', htmlFor: 'rpc-' + c, textContent: EVM[c].name }), input));
  });
  if (rpcKeys.some(k => s[k])) $('advanced').open = true;
  $('hideFourMeme').checked = !!s.hideFourMeme;
  $('skipList').textContent = DEPLOY_TAG_SKIP.map(x => `${x.name} (${DEPLOY_TAG_CHAIN_TAGS[x.chain]}, …${x.suffix} → ${x.label})`).join(', ');
  $('deepScan').checked = !!s.deepScan;
  $('explorerApi').value = s.explorerApi === 'etherscan' ? 'etherscan' : 'blockscout';
  $('explorerKey').value = s.explorerKey || '';
  rules = Array.isArray(s.rules) ? s.rules : [];
  KIND_ORDER.forEach(v => $('newKind').append(el('option', { value: v, textContent: DEPLOY_TAG_KIND_INFO[v].name })));
  renderLegend(); renderFilter(); renderRules(); renderDefaults(); renderSeen();
}

$('saveKey').addEventListener('click', async () => {
  const key = $('key').value.trim();
  setStatus('keyStatus', '', 'Checking…');
  try {
    await rpcCall(`https://mainnet.helius-rpc.com/?api-key=${encodeURIComponent(key)}`, 'getHealth');
    await chrome.storage.local.set({ heliusKey: key });
    setStatus('keyStatus', 'ok', 'Saved. Refresh any open terminal tabs.');
  } catch (e) {
    setStatus('keyStatus', 'err', `That key didn't work (${e.message}).`);
  }
});
$('showKey').addEventListener('click', () => toggleShow('key', 'showKey'));

$('saveAlchemy').addEventListener('click', async () => {
  const key = $('alchemyKey').value.trim();
  $('alchemyChains').textContent = '';
  if (!key) {
    await chrome.storage.local.remove('alchemyKey');
    setStatus('alchemyStatus', 'ok', 'Key removed. BSC uses the public RPC; other chains need a key or your own RPC URL.');
    return;
  }
  setStatus('alchemyStatus', '', 'Checking every chain…');
  const results = await Promise.all(DEPLOY_TAG_EVM_CHAIN_IDS.map(c => checkChain(c, alchemyUrl(c, key))));
  renderChainStatus('alchemyChains', results);
  const okCount = results.filter(r => r.ok).length;
  if (!okCount) { setStatus('alchemyStatus', 'err', "That key didn't work on any chain."); return; }
  await chrome.storage.local.set({ alchemyKey: key });
  setStatus('alchemyStatus', okCount === results.length ? 'ok' : 'err',
    `Saved. ${okCount} of ${results.length} chains OK.${okCount === results.length ? ' Refresh any open terminal tabs.'
      : ' Chains that failed are skipped until you turn them on for your Alchemy app (or set an RPC URL).'}`);
});
$('showAlchemy').addEventListener('click', () => toggleShow('alchemyKey', 'showAlchemy'));

$('saveRpc').addEventListener('click', () => {
  const vals = {};
  DEPLOY_TAG_EVM_CHAIN_IDS.forEach(c => { vals[c] = $('rpc-' + c).value.trim(); });
  const origins = [];
  for (const [chain, v] of Object.entries(vals)) {
    if (!v) continue;
    let u;
    try { u = new URL(v); } catch (e) { setStatus('rpcStatus', 'err', `${CHAIN_NAMES[chain]}: not a valid URL.`); return; }
    if (!/^https?:$/.test(u.protocol)) { setStatus('rpcStatus', 'err', `${CHAIN_NAMES[chain]}: use an http(s) URL.`); return; }
    origins.push(`${u.protocol}//${u.hostname}/*`);
  }
  // Must be called straight from the click so Chrome shows its prompt.
  const ask = origins.length ? chrome.permissions.request({ origins }) : Promise.resolve(true);
  ask.then(async granted => {
    if (!granted) { setStatus('rpcStatus', 'err', 'Chrome permission was declined, so the RPC URLs were not saved.'); return; }
    setStatus('rpcStatus', '', 'Checking…');
    const checks = await Promise.all(Object.entries(vals).filter(([, v]) => v).map(([c, v]) => checkChain(c, v)));
    const save = {};
    DEPLOY_TAG_EVM_CHAIN_IDS.forEach(c => { save[deployTagRpcKey(c)] = vals[c]; });
    await chrome.storage.local.set(save);
    const bad = checks.filter(c => !c.ok);
    setStatus('rpcStatus', bad.length ? 'err' : 'ok',
      checks.length ? `Saved. ${checks.map(c => `${CHAIN_NAMES[c.chain]}: ${c.msg}`).join('. ')}.` : 'Saved. Using the default RPCs.');
  }).catch(e => setStatus('rpcStatus', 'err', e.message));
});

$('hideFourMeme').addEventListener('change', e => chrome.storage.local.set({ hideFourMeme: e.target.checked }));

$('deepScan').addEventListener('change', e => chrome.storage.local.set({ deepScan: e.target.checked }));
$('showExplorer').addEventListener('click', () => toggleShow('explorerKey', 'showExplorer'));
$('saveExplorer').addEventListener('click', async () => {
  const api = $('explorerApi').value;
  const key = $('explorerKey').value.trim();
  await chrome.storage.local.set({ explorerApi: api, explorerKey: key });
  $('explorerChains').textContent = '';
  if (!key) { setStatus('explorerStatus', 'ok', 'Saved without a key, so deep scan stays idle.'); return; }
  setStatus('explorerStatus', '', 'Saved. Testing each chain…');
  const results = await Promise.all(DEPLOY_TAG_EVM_CHAIN_IDS.map(c => checkExplorer(api, key, c)));
  renderChainStatus('explorerChains', results);
  const okCount = results.filter(r => r.ok).length;
  setStatus('explorerStatus', okCount ? 'ok' : 'err',
    `Saved. ${okCount} of ${results.length} chains reachable with this key${$('deepScan').checked ? '.' : ' (deep scan is still off).'}`);
});

$('addRule').addEventListener('click', () => {
  const match = deployTagNormalizeMatch($('newMatch').value);
  if (!match) { $('newMatch').focus(); return; }
  const label = $('newLabel').value.trim();
  const kind = $('newKind').value;
  const existing = rules.findIndex(r => deployTagNormalizeMatch(r.match) === match);
  if (existing >= 0) rules[existing] = { match, label, kind };
  else rules.push({ match, label, kind });
  $('newMatch').value = ''; $('newLabel').value = '';
  saveRules();
});

$('exportLabels').addEventListener('click', () => {
  const out = rules.map(r => ({ match: r.match, label: r.label || '', kind: r.kind }));
  download(`deploy-tag-labels-${today()}.json`, JSON.stringify(out, null, 2), 'application/json');
});
$('exportUnlabeled').addEventListener('click', () => exportDomains(true));
$('exportAll').addEventListener('click', () => exportDomains(false));

$('toggleImport').addEventListener('click', () => { $('importBox').hidden = !$('importBox').hidden; });
$('importFile').addEventListener('change', async e => {
  const f = e.target.files[0];
  if (f) $('importText').value = await f.text();
  e.target.value = '';
});
$('importPreview').addEventListener('click', () => renderImport(parseImport($('importText').value)));

$('seenFilter').addEventListener('change', e => { seenFilter = e.target.value; renderSeen(); });
$('clearSeen').addEventListener('click', async () => {
  await chrome.storage.local.remove('seenDomains'); renderSeen();
});
$('clearCache').addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'clearCache' });
  $('clearCache').textContent = 'Cache cleared';
  setTimeout(() => { $('clearCache').textContent = 'Clear lookup cache'; }, 1500);
});

chrome.storage.onChanged.addListener((c, area) => { if (area === 'local' && c.seenDomains) renderSeen(); });
init();
