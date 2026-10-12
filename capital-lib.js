// handoff capital: pure logic, no I/O. The royalty reach graph, the AgentShares ABI and the dividend arithmetic.
// Works in the browser and in Node 18+; tests in tests/capital-lib.test.js.

// ---------------------------------------------------------------- royalty terms (handoff src/app-licensing.ts)

export const ROYALTY = { royalty_bps: 1000, decay_bps: 5000, upstream_cap_bps: 5000, max_depth: 8 };

/** The share of a sale an upstream app takes `depth` steps down (1 = a direct include), in basis points. */
export function rateAt(depth, royaltyBps = ROYALTY.royalty_bps, decayBps = ROYALTY.decay_bps) {
  if (depth < 1 || depth > ROYALTY.max_depth) return 0;
  return Math.floor(royaltyBps * Math.pow(decayBps / 10_000, depth - 1));
}

const refOf = (a) => `${a.author}/${a.name}`;
export const COMPONENTS_FILE = 'components.json';

/** handoff's parseComponents: {"components": ["author/name" | {author, name}]} or a bare array. [] when invalid. */
export function parseComponents(text) {
  let j;
  try { j = JSON.parse(text); } catch { return []; }
  const list = Array.isArray(j) ? j : j && Array.isArray(j.components) ? j.components : null;
  if (!list) return [];
  const out = [];
  const seen = new Set();
  for (const c of list) {
    const m = typeof c === 'string' ? /^([^/\s]+)\/(.+)$/.exec(c.trim()) : null;
    const author = m ? m[1] : typeof c?.author === 'string' ? c.author.trim() : '';
    const name = m ? m[2].trim() : typeof c?.name === 'string' ? c.name.trim() : '';
    if (!author || !name) return [];
    if (!seen.has(`${author}/${name}`)) { seen.add(`${author}/${name}`); out.push(`${author}/${name}`); }
  }
  return out;
}

/**
 * The store as handoff's royalty walk sees it, from GET /apps?limit=2000 (every version). `components` maps a
 * components.json file hash to the refs it names (fetch GET /apps/file/:hash for each of componentFilesToFetch).
 * A family's current version is its newest; handoff can pin another, so the API's /terms stays the authority.
 */
export function buildStore(versions, components = new Map()) {
  const apps = new Map();
  const latest = new Map();
  for (const v of versions) {
    if (!v || !v.hash || !v.author || !v.name) continue;
    apps.set(v.hash, v);
    const k = refOf(v);
    const cur = latest.get(k);
    if (!cur || String(v.created_at) > String(cur.created_at)) latest.set(k, v);
  }
  return { apps, latest: new Map([...latest].map(([k, v]) => [k, v.hash])), components };
}

/** The components.json files a walk over the current versions can read (file hashes, deduplicated). */
export function componentFilesToFetch(store) {
  const out = new Set();
  const visit = (h, seen) => {
    if (seen.has(h)) return;
    seen.add(h);
    const a = store.apps.get(h);
    if (!a) return;
    const fh = a.file_hashes?.[COMPONENTS_FILE];
    if (fh) out.add(fh);
    for (const d of a.deps || []) visit(d, seen);
  };
  const seen = new Set();
  for (const h of store.latest.values()) visit(h, seen);
  return [...out];
}

// What an app version includes: its components (each at its current version) and its pinned deps.
function includes(store, hash) {
  const a = store.apps.get(hash);
  if (!a) return [];
  const out = [];
  for (const ref of store.components.get(a.file_hashes?.[COMPONENTS_FILE]) || []) {
    const h = store.latest.get(ref);
    if (h) out.push(h);
  }
  for (const d of a.deps || []) if (store.apps.has(d)) out.push(d);
  return out;
}

/** Every family `ref`'s current version includes, at the depth it is first reached, at most 8 steps (handoff's walk). */
export function upstreamOf(store, ref) {
  const h = store.latest.get(ref);
  const fams = new Map();
  if (!h) return fams;
  const seen = new Set();
  let frontier = includes(store, h);
  for (let d = 1; d <= ROYALTY.max_depth && frontier.length; d++) {
    const next = [];
    for (const x of frontier) {
      if (seen.has(x)) continue;
      seen.add(x);
      const a = store.apps.get(x);
      if (!a) continue;
      const k = refOf(a);
      if (k !== ref && !fams.has(k)) fams.set(k, d);
      next.push(...includes(store, x));
    }
    frontier = next;
  }
  return fams; // ref -> depth
}

/**
 * Royalty reach of an author (a company is an agent, so its id is the author): every app whose sale would pay this
 * author, through which of its apps, at what step and default rate. handoff pays no one on apps of the same owner,
 * so `ownerOf` (agent id -> owner_id) leaves those out; authors missing from it count as their own owner.
 */
export function reachOf(store, author, ownerOf = new Map()) {
  const principal = (id) => ownerOf.get(id) || id;
  const me = principal(author);
  const rows = [];
  for (const ref of store.latest.keys()) {
    const composer = ref.split('/')[0];
    if (principal(composer) === me) continue;
    let best = null;
    for (const [u, depth] of upstreamOf(store, ref)) {
      if (u.split('/')[0] !== author) continue;
      const bps = rateAt(depth);
      if (bps > 0 && (!best || bps > best.bps)) best = { app: ref, composer, via: u, depth, bps };
    }
    if (best) rows.push(best);
  }
  return rows.sort((x, y) => y.bps - x.bps || x.app.localeCompare(y.app));
}

/** Per author, the apps of other owners that would pay them. Authors with no reach are left out. */
export function reachTable(store, ownerOf = new Map()) {
  const authors = new Set([...store.latest.keys()].map((r) => r.split('/')[0]));
  const out = [];
  for (const a of authors) {
    const rows = reachOf(store, a, ownerOf);
    if (!rows.length) continue;
    out.push({ author: a, apps: rows.length, composers: [...new Set(rows.map((r) => r.composer))], maxDepth: Math.max(...rows.map((r) => r.depth)) });
  }
  return out.sort((x, y) => y.apps - x.apps || x.author.localeCompare(y.author));
}

/** How a sale of `price` (atomic) divides, as handoff's splitsFor does for live authors: upstream capped at 50%. */
export function splitSale(price, upstream /* [{author, ref, depth}] */, seller) {
  const rows = upstream.filter((u) => u.author !== seller).map((u) => ({ ...u, bps: rateAt(u.depth) })).filter((r) => r.bps > 0);
  const total = rows.reduce((n, r) => n + r.bps, 0);
  const scale = total > ROYALTY.upstream_cap_bps ? ROYALTY.upstream_cap_bps / total : 1;
  const splits = rows.map((r) => {
    const bps = Math.floor(r.bps * scale);
    return { ...r, bps, amount: Math.floor((Math.max(0, price) * bps) / 10_000) };
  });
  return { splits, seller_amount: Math.max(0, price) - splits.reduce((n, s) => n + s.amount, 0) };
}

// ---------------------------------------------------------------- ABI (AgentShares and the USDC side)

export const SEL = {
  allowance: '0xdd62ed3e', approve: '0x095ea7b3', balanceOf: '0x70a08231', buy: '0xd96a094a', cash: '0x961be391',
  claim: '0x4e71d92d', claimable: '0x402914f5', closeRaise: '0x49a4e0e2', companyId: '0x7bc3a733', decimals: '0x313ce567',
  lifetimeEarned: '0x622bed9b', name: '0x06fdde03', operator: '0x570ca735', pay: '0x154fbbc4', price: '0xa035b1fe',
  raiseOpen: '0x49f6965b', state: '0xc19d93fb', symbol: '0x95d89b41', sync: '0xfff6cae9', totalSupply: '0x18160ddd',
  transfer: '0xa9059cbb', treasury: '0x61d027b3', withdrawn: '0x6ef61092',
};

export const TOPIC = {
  Transfer: '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',
  Bought: '0xa9a40dec7a304e5915d11358b968c1e8d365992abf20f82285d1df1b30c8e24c',
  Revenue: '0x40868aece358ec08124cb8ed6b59f0d80d2e5df62f8f9187fe5619b0886a1661',
  Claimed: '0xd8138f8a3f377c5259ca548e70e4c2de94f129f5a11036a15b69513cba2b426a',
  RaiseClosed: '0xff22b36d5a5c7aab85940c6743c0680fbafadaa3cc12a046e5df86ac7c193c4d',
};

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const word = (hex) => hex.padStart(64, '0');

function encodeWord(type, v) {
  if (type === 'address') {
    if (!ADDRESS_RE.test(v)) throw new Error(`not an address: ${v}`);
    return word(v.slice(2).toLowerCase());
  }
  if (type === 'uint256') {
    const n = BigInt(v);
    if (n < 0n || n >= 1n << 256n) throw new Error(`uint256 out of range: ${v}`);
    return word(n.toString(16));
  }
  if (type === 'bool') return word(v ? '1' : '0');
  throw new Error(`unsupported static type ${type}`);
}

function utf8Hex(s) {
  return [...new TextEncoder().encode(s)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function encodeTail(type, v) {
  if (type === 'string') {
    const h = utf8Hex(String(v));
    const len = h.length / 2;
    return word(len.toString(16)) + (h ? h.padEnd(Math.ceil(h.length / 64) * 64, '0') : '');
  }
  if (type.endsWith('[]')) {
    const inner = type.slice(0, -2);
    return word(v.length.toString(16)) + v.map((x) => encodeWord(inner, x)).join('');
  }
  throw new Error(`unsupported dynamic type ${type}`);
}

const isDynamic = (t) => t === 'string' || t.endsWith('[]');

/** ABI-encode a parameter list (static types, strings and one-level arrays of static types). Hex, no 0x. */
export function encodeParams(types, values) {
  if (types.length !== values.length) throw new Error('types and values differ in length');
  let head = '';
  let tail = '';
  const headSize = types.length * 32;
  for (let i = 0; i < types.length; i++) {
    if (isDynamic(types[i])) {
      head += word((headSize + tail.length / 2).toString(16));
      tail += encodeTail(types[i], values[i]);
    } else {
      head += encodeWord(types[i], values[i]);
    }
  }
  return head + tail;
}

export const encodeCall = (selector, types = [], values = []) => selector + encodeParams(types, values);

/** AgentShares constructor argument types, in order. */
export const CTOR_TYPES = ['string', 'string', 'string', 'address', 'address', 'address', 'uint256', 'uint256', 'address[]', 'uint256[]'];

export function encodeConstructor(t) {
  return encodeParams(CTOR_TYPES, [t.companyId, t.name, t.symbol, t.cash, t.operator, t.treasury, t.price, t.sharesForSale, t.founders, t.founderShares]);
}

const strip = (hex) => (hex || '').replace(/^0x/, '');
export const wordAt = (hex, i) => strip(hex).slice(i * 64, i * 64 + 64);
export const decodeUint = (hex, i = 0) => BigInt(`0x${wordAt(hex, i) || '0'}`);
export const decodeBool = (hex, i = 0) => decodeUint(hex, i) !== 0n;
export const decodeAddress = (hex, i = 0) => `0x${wordAt(hex, i).slice(24)}`;

export function decodeString(hex, i = 0) {
  const h = strip(hex);
  if (!h) return '';
  const off = Number(decodeUint(h, i)) * 2;
  const len = Number(BigInt(`0x${h.slice(off, off + 64)}`));
  const bytes = h.slice(off + 64, off + 64 + len * 2).match(/../g) || [];
  return new TextDecoder().decode(new Uint8Array(bytes.map((b) => parseInt(b, 16))));
}

/** state() → the raise and the revenue in one read. */
export function decodeState(hex) {
  return {
    supply: decodeUint(hex, 0), sold: decodeUint(hex, 1), forSale: decodeUint(hex, 2), price: decodeUint(hex, 3),
    open: decodeBool(hex, 4), revenue: decodeUint(hex, 5), claimed: decodeUint(hex, 6), unbooked: decodeUint(hex, 7),
  };
}

/** A contract log → {kind, ...fields}, or null for a log this page does not show. */
export function decodeShareLog(log) {
  const t0 = log.topics?.[0];
  const who = (i) => `0x${(log.topics[i] || '').slice(26)}`;
  const base = { tx: log.transactionHash, block: Number(BigInt(log.blockNumber || 0)) };
  if (t0 === TOPIC.Bought) return { ...base, kind: 'bought', buyer: who(1), shares: decodeUint(log.data, 0), cost: decodeUint(log.data, 1) };
  if (t0 === TOPIC.Revenue) return { ...base, kind: 'revenue', amount: decodeUint(log.data, 0), ref: decodeString(log.data, 1) };
  if (t0 === TOPIC.Claimed) return { ...base, kind: 'claimed', holder: who(1), amount: decodeUint(log.data, 0) };
  if (t0 === TOPIC.RaiseClosed) return { ...base, kind: 'closed', sold: decodeUint(log.data, 0) };
  if (t0 === TOPIC.Transfer && log.topics.length === 3) return { ...base, kind: 'transfer', from: who(1), to: who(2), value: decodeUint(log.data, 0) };
  return null;
}

// ---------------------------------------------------------------- dividends

/** What a holder of `shares` out of `supply` is owed from `amount` of new revenue (floor, as the contract books). */
export function proRata(amount, shares, supply) {
  if (supply === 0n) return 0n;
  const MAG = 1n << 128n;
  return ((amount * MAG) / supply) * shares / MAG;
}

/** Founders from a company's members: equal shares each, with the remainder to the first. */
export function equalFounders(wallets, total) {
  const n = BigInt(wallets.length);
  if (!n) return { founders: [], founderShares: [] };
  const each = BigInt(total) / n;
  const rest = BigInt(total) - each * n;
  return { founders: wallets, founderShares: wallets.map((_, i) => (i === 0 ? each + rest : each)) };
}

/** A company's share contract, from its handoff policies: an onchain policy whose scope is capital. */
export function shareContractOf(company) {
  const p = (company?.policies || []).find((x) => x.kind === 'onchain' && x.scope === 'capital' && ADDRESS_RE.test(x.ref || ''));
  return p ? { address: p.ref, chain: p.chain || 'base-sepolia' } : null;
}
