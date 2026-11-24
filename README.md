# Deploy Tag

Puts a small badge next to every token on GMGN, Axiom and BasedBot (Pulse cards and token pages) showing which deploy tool, launchpad or operator made it, read from the token's metadata URI. Clicking a badge opens the token on its explorer so you can check the metadata yourself.

## Supported chains

| Chain | Where the metadata comes from | Badge click opens |
|---|---|---|
| Solana | Helius `getAssetBatch`, then the Token-2022 metadata extension for very new mints | Solscan metadata |
| BSC | universal getter lookup (see below); public Binance RPC works without a key | BscScan read contract |
| Robinhood Chain | universal getter lookup | Blockscout read contract |
| Base | universal getter lookup | BaseScan read contract |
| Ethereum | universal getter lookup | Etherscan read contract |
| Avalanche C-Chain | universal getter lookup | Snowtrace |

EVM chains live in one table (`DEPLOY_TAG_EVM_CHAINS` in `labels.js`): adding a chain is one entry there plus its RPC host in `manifest.json`. The same labels work on every chain: `j7m.io` means J7 on Solana, flap, Pons and anywhere else.

### Universal getter lookup (EVM)

There's no standard place for a metadata link on EVM, and launchpads copy each other's token templates, so tokens are asked all the known questions, in two passes so badges stay fast:

- **Pass 1** (the badge waits for this, one round trip): `metaURI()`, `logo()`, `tokenURI()` and `launchFactory()`. That covers flap, Pons, genius.fun and Doppler/Long.xyz, at 4 calls per token.
- **Pass 2** (in the background, only for tokens pass 1 found nothing on): the other getters plus the contract code. The badge shows `?` meanwhile and updates on its own if something turns up.
- Tokens that still have nothing are retried once (for brand-new tokens), then left alone: getters don't change after launch.
- Batches go out in parallel. Without an Alchemy key, BSC uses the public Binance RPC, which only accepts small batches, so they're kept to 10 calls.

The getters, in the order they're checked:

| Getter | Seen on |
|---|---|
| `metaURI()` | flap (BSC) |
| `logo()` | Pons (Robinhood), genius.fun (BSC) |
| `tokenURI()` | Doppler ERC20 V1 (Long.xyz on Robinhood), Zora-style |
| `uri()`, `metadataURI()`, `image()`, `imageURI()` | various |
| `metadata()`, `imageUrl()` | Clanker-style (`metadata()` may return JSON text) |

The first getter (in that order) that returns a usable link wins: an `http(s)://`, `ipfs://` or `ar://` URL, a bare CID, or a `data:` URI. JSON text is searched for `image`, `uri`, `metadata`, `external_url`, `logo` or `imageUrl`. The badge tooltip and exports say which getter it came from.

A `launchFactory()` answer is stored as `factory`. When a token is a minimal-proxy clone (EIP-1167, used by flap, genius.fun and Doppler), the clone's template address is stored as `template`. To save calls, the template is only read for tokens in pass 2 and for tokens whose domain is unlabeled (one extra background call each). The unlabeled export groups domains by factory and template, so a new launchpad shows up as a cluster.

The getter list is `GETTERS` in `background.js`; `fast: true` marks the pass-1 getters.

### Skip list

Launchpads that keep nothing on-chain get no lookup, just a tiny quiet badge: four.meme on BSC (addresses ending `4444` / `ffff`) shows `4m`. Add more in `DEPLOY_TAG_SKIP` in `labels.js` (chain + address suffix + label). Settings → Badges can hide these badges.

## Badge types

| Type | Meaning | Look |
|---|---|---|
| **Tool** | Third-party deploy tool launching on an existing launchpad | Colored, each label keeps its own color |
| **Bundler** | Buys with many wallets at launch, so the dev controls the early supply | Solid orange-red |
| **Launchpad** | A launchpad with its own site and rules | White outline |
| **Operator** | One person's private script, bot or server | Orange outline |
| **Warning** | Actively sketchy: farm domains, impersonators, hidden devs, expiring files | Solid red |
| **Quiet** | General storage, says nothing about who launched (`ipfs`, `arweave`, `gcs`, `inline`) | Small grey |
| **Hide** | No badge | — |
| Unlabeled | Domain not in any list yet — worth a look | Amber, dashed |

Grey `?` means no metadata URI was found yet (very new tokens get retried automatically). Grey `key` means the key for that chain is missing.

## Install

1. Unzip this folder somewhere you'll keep it.
2. Open `chrome://extensions`, turn on **Developer mode** (top right).
3. Click **Load unpacked** and pick the `deploy-tag` folder.
4. The settings page opens. Paste your **Helius** key (free at dashboard.helius.dev) and click **Save**.
5. For EVM chains, paste your **Alchemy** key (free at dashboard.alchemy.com; turn on each network you want for your app) and click **Save**. The test shows OK or fail per chain; a chain that fails is skipped without affecting the others. BSC works without a key through the public Binance RPC.
6. Refresh any open GMGN / Axiom / BasedBot tabs.

Under **Advanced** you can use your own RPC URL for any chain instead. Chrome asks for permission to reach that host when you save it.

### Deep scan (optional, off by default)

When no getter answers, the link is often still in the token's launch transaction. Settings → **Deep scan** looks up the creation transaction through an explorer API, fetches it through your RPC, and searches its input for the first link (recorded as source `tx-input`). It needs an explorer API key:

- **Blockscout PRO API** (`api.blockscout.com`): one free key for all its chains.
- **Etherscan API V2** (`api.etherscan.io/v2`): the free tier doesn't cover every chain (BSC, Base, Avalanche and Robinhood are paid-only).

**Save & test** shows which chains your key reaches. Deep scans only run on misses, about 3 a second, and "nothing found" is remembered for a day.

## Labels

Settings → **Labels** maps a domain to a badge. Rules match subdomains too, and can include a path:

- `uxento.io` matches `uxento.io` and `launch.uxento.io`
- `storage.googleapis.com/padre-user-content-store` matches only files under that folder

The **most specific** rule wins (a subdomain beats its parent, host+path beats host), and your own rule beats a built-in one for the same match. Bare IPFS CIDs (`Qm…`, `bafy…`, `bafk…`) count as `ipfs.io`, and inline `data:` metadata shows as `inline`.

The built-in list is under **Built-in labels**; add your own rule for the same domain to override one.

## Domains seen, export and import

Settings → **Domains seen** lists every metadata domain the extension has come across, with the chains it was seen on, how many tokens, and up to 5 example tokens. Filter it by unlabeled, type or chain. Click **Label** to start a rule for a domain.

- **Export unlabeled** — every domain whose badge is currently unlabeled, as JSON or CSV. The JSON starts with an `instructions` field so you can hand the file straight to a research agent.
- **Export all domains** — the whole list, as JSON or CSV.
- **Export labels** — your own rules, as a JSON array of `{match, label, kind}`.
- **Import labels** — paste or upload a JSON array of `{match, label, kind}`. You get a preview of what will be added or changed before anything is saved; invalid rows are skipped and listed.

Each domain entry has `domain`, `current_badge`, `count`, `chains`, `first_seen`, `last_seen` and `examples` (chain, address, uri, source, factory, template and an explorer link). The unlabeled JSON also has `clusters`, grouping domains by `launchFactory()` address and by clone template.

## How it works

- `content.js` finds token cards on each site (one small adapter per site), reads the chain and full contract address, and asks the background worker for metadata URIs.
- `background.js` looks Solana tokens up through Helius and EVM tokens through the batched getter lookup (plus the optional deep scan), and caches every URI it finds permanently. Misses aren't cached, so they're retried.
- `labels.js` turns a URI into a badge using your labels plus the built-in ones.

## If a site changes its layout

Only that site's adapter in `content.js` needs updating (`axiom`, `gmgn` or `basedbot`). Save the page again with SingleFile and send it over.

## Limitations

- A tool that uploads its metadata to the launchpad's own storage looks the same as a normal launch, so it'll show as the quiet grey badge.
- four.meme keeps no metadata on-chain, so four.meme tokens can't be labeled.
- An EVM token whose link isn't behind any known getter (and isn't in its launch transaction) shows `?`. Add the getter to `GETTERS` once you find it.
