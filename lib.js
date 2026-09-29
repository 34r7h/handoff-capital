// Pure functions shared by the browser app, the smoke script and the tests.
// No I/O and no DOM here: everything takes plain data (or an injected fetch
// function) and returns plain data.

export const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
export const TRANSFER_SELECTOR = '0xa9059cbb';
export const UINT256_MAX = (1n << 256n) - 1n;
export const CAP_DECIMALS = 6; // the mainnet cap is kept in 6-decimal dollar units
export const STABLECOINS = ['USDC', 'USDG']; // dollar stablecoins a task may be priced in

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const TX_RE = /^0x[0-9a-fA-F]{64}$/;

export function isAddress(v) {
  return typeof v === 'string' && ADDRESS_RE.test(v);
}

export function sameAddress(a, b) {
  return isAddress(a) && isAddress(b) && a.toLowerCase() === b.toLowerCase();
}

export function isTxHash(v) {
  return typeof v === 'string' && TX_RE.test(v);
}

export function shortAddress(a) {
  return isAddress(a) ? `${a.slice(0, 6)}…${a.slice(-4)}` : String(a ?? '');
}

// ---------------------------------------------------------------- amounts

// "1.5e-7" -> "0.00000015". Works on the decimal string, never on floats.
function expandExponent(s) {
  const m = /^(\d*)(?:\.(\d*))?e([+-]?\d+)$/i.exec(s);
  if (!m) throw new RangeError(`not a decimal amount: ${s}`);
  const intPart = m[1] || '';
  const fracPart = m[2] || '';
  const digits = (intPart + fracPart).replace(/^0+(?=\d)/, '') || '0';
  const lead = (intPart + fracPart).length - digits.length; // zeros stripped from the front
  const point = intPart.length - lead + Number(m[3]);
  if (point <= 0) return `0.${'0'.repeat(-point)}${digits}`;
  if (point >= digits.length) return digits + '0'.repeat(point - digits.length);
  return `${digits.slice(0, point)}.${digits.slice(point)}`;
}

// Decimal amount (string or JS number) -> integer atomic units as a BigInt.
// Exact: "0.05" with 6 decimals is 50000n. Refuses negatives, junk and
// amounts finer than the token can represent (rather than rounding them).
export function toAtomic(amount, decimals = 6) {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) throw new RangeError('bad decimals');
  let s;
  if (typeof amount === 'number') {
    if (!Number.isFinite(amount)) throw new RangeError('amount is not a finite number');
    s = String(amount);
  } else if (typeof amount === 'string') {
    s = amount.trim();
  } else {
    throw new TypeError('amount must be a decimal string or number');
  }
  if (/e/i.test(s)) s = expandExponent(s);
  const m = /^(\d*)(?:\.(\d*))?$/.exec(s);
  if (!m || (m[1] === '' && !m[2])) throw new RangeError(`not a decimal amount: ${String(amount)}`);
  const whole = m[1] || '0';
  const frac = (m[2] || '').replace(/0+$/, '');
  if (frac.length > decimals) throw new RangeError(`${String(amount)} has more than ${decimals} decimal places`);
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt(frac.padEnd(decimals, '0') || '0');
}

// Atomic units -> "0.05". Keeps at least two decimals and trims the rest.
export function formatAtomic(atomic, decimals = 6) {
  const a = BigInt(atomic);
  const neg = a < 0n;
  const abs = neg ? -a : a;
  const base = 10n ** BigInt(decimals);
  let frac = (abs % base).toString().padStart(decimals, '0').replace(/0+$/, '');
  if (frac.length < 2) frac = frac.padEnd(Math.min(2, decimals), '0');
  return `${neg ? '-' : ''}${abs / base}${frac ? `.${frac}` : ''}`;
}

// Re-express an atomic amount with different decimals, rounding down or up.
export function scaleAtomic(amount, fromDecimals, toDecimals, roundUp = false) {
  const a = BigInt(amount);
  if (toDecimals >= fromDecimals) return a * 10n ** BigInt(toDecimals - fromDecimals);
  const div = 10n ** BigInt(fromDecimals - toDecimals);
  const q = a / div;
  return roundUp && a % div !== 0n ? q + 1n : q;
}

// A token amount in the cap's 6-decimal units, rounded up so the cap is never undercounted.
export const toCapUnits = (amount, decimals = 6) => scaleAtomic(amount, decimals, CAP_DECIMALS, true);

// ---------------------------------------------------------------- calldata and logs

export function padTopicAddress(addr) {
  if (!isAddress(addr)) throw new TypeError(`not an address: ${addr}`);
  return `0x${addr.slice(2).toLowerCase().padStart(64, '0')}`;
}

function topicToAddress(topic) {
  if (typeof topic !== 'string' || !/^0x0{24}[0-9a-fA-F]{40}$/.test(topic)) return null;
  return `0x${topic.slice(26).toLowerCase()}`;
}

// ERC-20 transfer(address,uint256) calldata, hand-encoded.
export function encodeTransfer(to, atomic) {
  if (!isAddress(to)) throw new TypeError(`not an address: ${to}`);
  if (typeof atomic !== 'bigint') throw new TypeError('amount must be a BigInt in atomic units');
  if (atomic <= 0n || atomic > UINT256_MAX) throw new RangeError('amount out of range');
  return TRANSFER_SELECTOR
    + to.slice(2).toLowerCase().padStart(64, '0')
    + atomic.toString(16).padStart(64, '0');
}

// One eth_getLogs entry -> { from, to, amount, blockNumber, logIndex, txHash, timestamp }.
// Returns null for anything that isn't a plain ERC-20 Transfer log.
export function decodeTransferLog(log) {
  if (!log || log.removed) return null;
  const t = log.topics;
  if (!Array.isArray(t) || t.length !== 3 || String(t[0]).toLowerCase() !== TRANSFER_TOPIC) return null;
  const from = topicToAddress(t[1]);
  const to = topicToAddress(t[2]);
  if (!from || !to || typeof log.data !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(log.data)) return null;
  const hexNum = (v) => (v == null ? null : Number(BigInt(v)));
  return {
    from,
    to,
    amount: BigInt(log.data),
    blockNumber: hexNum(log.blockNumber),
    logIndex: hexNum(log.logIndex),
    txHash: log.transactionHash,
    // Some RPCs send blockTimestamp as "0x0" (Robinhood Chain does, for some
    // logs); zero means unknown, never the epoch.
    timestamp: log.blockTimestamp != null && hexNum(log.blockTimestamp) > 0 ? hexNum(log.blockTimestamp) : null,
  };
}

// ---------------------------------------------------------------- rails

// How to page through eth_getLogs on a rail: start at `initial` blocks per
// query, grow toward `max` after successes, shrink on range/limit errors.
const HANDOFF_SCAN = {
  8453: { initial: 2000, max: 2000, concurrency: 3 }, // Base: 2,000-block cap
  84532: { initial: 1000, max: 1000, concurrency: 3 }, // Base Sepolia: 1,000-block cap
};
const DEFAULT_SCAN = { initial: 1000, max: 5000, concurrency: 2 };

// Rails this app adds on top of handoff's /config/settlement. handoff does not
// settle on these chains; the app only reads them and pays through the wallet.
export const APP_RAILS = [
  {
    side: 'mainnet',
    name: 'robinhood',
    aliases: ['robinhood-chain'],
    label: 'Robinhood Chain',
    chainId: 4663,
    token: '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168',
    symbol: 'USDG',
    decimals: 6,
    rpcUrl: 'https://rpc.mainnet.chain.robinhood.com',
    explorer: 'https://robinhoodchain.blockscout.com/tx/',
    nativeSymbol: 'ETH',
    testnet: false,
    // Its RPC caps a query at 10,000,000 blocks and 10,000 matching logs, not
    // at a small block range, so a quiet payer's weeks fit in a few calls.
    scan: { initial: 10_000_000, max: 10_000_000, concurrency: 1 },
  },
];

function normalizeRail(n, source) {
  const chainId = Number(n.chainId);
  const rail = {
    name: String(n.name ?? `chain-${chainId}`),
    aliases: Array.isArray(n.aliases) ? n.aliases.map(String) : [],
    label: String(n.label ?? n.name ?? `Chain ${chainId}`),
    chainId,
    token: n.token ?? n.usdc,
    symbol: String(n.symbol ?? n.assetName ?? 'USDC'),
    decimals: n.decimals == null ? 6 : Number(n.decimals),
    rpcUrl: n.rpcUrl,
    explorer: n.explorer,
    nativeSymbol: n.nativeSymbol || 'ETH',
    testnet: n.testnet === true,
    source,
    scan: { ...(n.scan || HANDOFF_SCAN[chainId] || DEFAULT_SCAN) },
  };
  if (!Number.isInteger(rail.chainId) || rail.chainId <= 0) throw new Error(`rail ${rail.name}: bad chainId`);
  if (!isAddress(rail.token)) throw new Error(`rail ${rail.name}: bad token address`);
  if (!Number.isInteger(rail.decimals)) throw new Error(`rail ${rail.name}: bad decimals`);
  if (typeof rail.rpcUrl !== 'string' || !/^https?:\/\//.test(rail.rpcUrl)) throw new Error(`rail ${rail.name}: bad rpcUrl`);
  if (typeof rail.explorer !== 'string' || !/^https?:\/\//.test(rail.explorer)) throw new Error(`rail ${rail.name}: bad explorer`);
  return rail;
}

// handoff's /config/settlement is { defaultNetwork, networks: [...] } today; a
// flat { chainId, usdc, ... } object is accepted too. Every rail it lists is
// marked source 'handoff'.
export function railsFrom(settlement) {
  if (!settlement || typeof settlement !== 'object') throw new Error('settlement config is empty');
  const list = Array.isArray(settlement.networks) ? settlement.networks : settlement.chainId != null ? [settlement] : [];
  const rails = [];
  for (const n of list) {
    try { rails.push(normalizeRail(n, 'handoff')); } catch { /* skip malformed entries */ }
  }
  if (!rails.length) throw new Error('settlement config lists no usable network');
  return rails;
}

// Every rail on one side: handoff's, then the app's for that side (unless
// handoff already lists the same chain). Throws if handoff's config is unusable,
// so a side never runs on app rails alone.
export function railsForSide(side, settlement) {
  const rails = railsFrom(settlement);
  for (const r of APP_RAILS) {
    if (r.side !== side || rails.some((x) => x.chainId === r.chainId)) continue;
    rails.push(normalizeRail(r, 'app'));
  }
  return rails;
}

// handoff's default rail (or the named one) from its own config.
export function pickRail(settlement, name) {
  const rails = railsFrom(settlement);
  return rails.find((r) => r.name === name)
    || rails.find((r) => r.name === settlement.defaultNetwork)
    || rails[0];
}

// Does a task's payment.network ("base", "eip155:8453", "8453", …) name this rail?
export function railMatchesNetwork(rail, network) {
  const n = String(network || '').trim().toLowerCase();
  if (!n) return false;
  return n === rail.name.toLowerCase()
    || rail.aliases.some((a) => a.toLowerCase() === n)
    || n === `eip155:${rail.chainId}`
    || n === String(rail.chainId);
}

export function explorerTxUrl(explorer, tx) {
  if (!isTxHash(tx) || typeof explorer !== 'string' || !explorer) return null;
  return explorer.endsWith('/') ? explorer + tx : `${explorer}/${tx}`;
}

// "paid in USDG (task priced in USDC)" when the token differs from the price.
export function tokenLabel(paySymbol, priceCurrency) {
  if (!paySymbol || !priceCurrency || paySymbol.toUpperCase() === priceCurrency.toUpperCase()) return null;
  return `paid in ${paySymbol} (task priced in ${priceCurrency})`;
}

// ---------------------------------------------------------------- tasks

// "handoff-advisor (independent) — did X" -> "handoff-advisor"
export function actorId(raw) {
  if (typeof raw !== 'string') return null;
  const m = /^[^\s(—–,;]+/.exec(raw.trim());
  return m ? m[0] : null;
}

// Who verified a task and when. "requester" means the project's requester.
export function taskVerification(task, requester) {
  const hist = Array.isArray(task?.status_history) ? task.status_history : [];
  let last = null;
  for (const h of hist) if (h && h.status === 'verified') last = h;
  const at = last ? Date.parse(last.at) : NaN;
  const raw = typeof task?.verified_by === 'string' && task.verified_by.trim() ? task.verified_by : last?.by ?? null;
  let verifier = actorId(raw);
  let viaRequester = false;
  if (verifier && verifier.toLowerCase() === 'requester') {
    viaRequester = true;
    verifier = typeof requester === 'string' && requester ? requester : null;
  }
  return { verifiedAt: Number.isFinite(at) ? at : null, verifier, verifierRaw: raw, viaRequester };
}

// The task's payment terms. Only { amount, currency } objects are trusted;
// a bare number or string has no units, so it is never guessed at.
export function readPayment(task, decimals = 6) {
  const p = task?.payment;
  if (p == null) return { ok: false, reason: 'no amount set on the task' };
  if (typeof p !== 'object' || Array.isArray(p)) {
    return { ok: false, reason: `amount "${String(p)}" has no currency or units, so it can't be paid safely` };
  }
  const currency = String(p.currency ?? p.asset ?? 'USDC').toUpperCase();
  if (!STABLECOINS.includes(currency)) return { ok: false, reason: `priced in ${currency}, not a dollar stablecoin this app pays in` };
  if (p.amount == null || p.amount === '') return { ok: false, reason: 'no amount set on the task' };
  let atomic;
  try {
    atomic = toAtomic(p.amount, decimals);
  } catch (e) {
    return { ok: false, reason: `amount "${String(p.amount)}" can't be read (${e.message})` };
  }
  return {
    ok: true,
    atomic,
    text: formatAtomic(atomic, decimals),
    currency,
    network: typeof p.network === 'string' && p.network ? p.network : null,
    payTo: typeof p.pay_to === 'string' && p.pay_to ? p.pay_to : null,
  };
}

// /activity receipts -> Map(taskId -> settled receipt with a tx).
export function receiptIndex(activity) {
  const map = new Map();
  for (const r of activity?.receipts || []) {
    if (!r || r.status !== 'settled' || !isTxHash(r.tx)) continue;
    const m = /^task:([0-9a-fA-F-]{36})/.exec(String(r.resource || ''));
    if (!m || map.has(m[1])) continue;
    map.set(m[1], { receiptId: r.id ?? null, tx: r.tx, network: r.network ?? null, amount: r.amount ?? null, payTo: r.payTo ?? null });
  }
  return map;
}

// Every tx hash handoff reports as its own settled payout. Those transfers
// paid something handoff settled, so they never count as the requester's.
export function receiptTxSet(activity) {
  const set = new Set();
  for (const r of activity?.receipts || []) {
    if (r && r.status === 'settled' && isTxHash(r.tx)) set.add(r.tx.toLowerCase());
  }
  return set;
}

// Everything the app shows for one project, as plain rows.
// agents: Map(agentId -> { ok: true, agent } | { ok: false, notFound?: true, error?: string })
// receipts: output of receiptIndex(); rails: every rail on this side; payRail: the one the wallet pays on.
//
// Each row has two kinds of blocks:
//   blocks      task-level: no rail can pay it (worker, verifier, amount, payee…)
//   railBlocks  only the selected pay rail can't pay it (named network, custodial wallet)
// `candidate` (task-level only) decides which tasks take part in matching, so
// switching the pay rail never changes which transfer paid which task.
export function buildRows({ request, tasks, agents, receipts, payRail, rails = [payRail] }) {
  const rows = [];
  const railByName = new Map(rails.map((r) => [r.name, r]));
  for (const t of tasks || []) {
    if (!t || t.status !== 'verified') continue;
    const v = taskVerification(t, request?.requester);
    const worker = typeof t.assignee === 'string' && t.assignee.trim() ? t.assignee.trim() : null;
    const pay = readPayment(t, payRail.decimals);
    const a = worker ? agents?.get(worker) : undefined;
    const rawWallet = a?.ok ? a.agent?.wallet_address ?? null : null;
    const wallet = isAddress(rawWallet) ? rawWallet : null;
    const custodial = a?.ok ? a.agent?.wallet_custodial === true : false;
    const blocks = [];
    const railBlocks = [];
    let onlyRail = null;

    if (!worker) blocks.push('no worker assigned to the task');
    else if (!a) blocks.push("worker's profile wasn't loaded");
    else if (!a.ok) blocks.push(a.notFound ? `${worker} is not a registered agent` : `couldn't load ${worker}: ${a.error}`);
    else if (!wallet) blocks.push(rawWallet ? "worker's wallet isn't a valid address" : 'worker has no wallet');

    if (!v.verifier) blocks.push(v.viaRequester ? 'verified by "requester", but the project has no requester' : 'no verifier on record');
    else if (worker && v.verifier.toLowerCase() === worker.toLowerCase()) blocks.push('verified by the worker itself');
    else if (worker && typeof t.self_signed_by === 'string' && t.self_signed_by.toLowerCase() === worker.toLowerCase() && !t.co_signed_by) {
      blocks.push('self-signed by the worker with no co-signer');
    }
    if (v.verifiedAt == null) blocks.push('verification time unknown');
    if (t.unpayable === true) blocks.push(t.unpayable_reason ? `handoff marks it unpayable: ${t.unpayable_reason}` : 'handoff marks it unpayable');

    if (!pay.ok) {
      blocks.push(pay.reason);
    } else {
      if (pay.network) {
        const named = rails.find((r) => railMatchesNetwork(r, pay.network));
        if (!named) blocks.push(`task asks to be paid on ${pay.network}, which isn't a rail on this side`);
        else {
          onlyRail = named.name;
          if (named.name !== payRail.name) railBlocks.push(`task asks to be paid on ${named.label}, so only that rail can pay it`);
        }
      }
      if (pay.payTo && !isAddress(pay.payTo)) blocks.push(`task names an invalid payee ${pay.payTo}`);
      else if (pay.payTo && wallet && !sameAddress(pay.payTo, wallet)) blocks.push(`task names payee ${pay.payTo}, which is not the worker's wallet`);
    }
    if (custodial && payRail.source !== 'handoff') railBlocks.push("custodial wallet; handoff doesn't watch this chain");

    const r = receipts?.get(t.id);
    let handoffPaid = null;
    if (r) {
      const net = railByName.get(r.network);
      handoffPaid = { tx: r.tx, network: r.network, url: net ? explorerTxUrl(net.explorer, r.tx) : null, receiptId: r.receiptId, amount: r.amount };
    } else if (t.paid === true) {
      handoffPaid = { tx: null, network: null, url: null, receiptId: t.receipt_id ?? null, amount: null };
    }

    const amountAtomic = pay.ok ? pay.atomic : null;
    const candidate = blocks.length === 0 && !handoffPaid && amountAtomic != null && amountAtomic > 0n;
    rows.push({
      id: t.id,
      title: typeof t.title === 'string' && t.title.trim() ? t.title : '(untitled task)',
      worker,
      wallet,
      custodial,
      amountAtomic,
      amountDecimals: payRail.decimals,
      amountText: pay.ok ? pay.text : null,
      priceCurrency: pay.ok ? pay.currency : null,
      payNote: pay.ok ? tokenLabel(payRail.symbol, pay.currency) : null,
      verifier: v.verifier,
      verifierRaw: v.verifierRaw,
      viaRequester: v.viaRequester,
      verifiedAt: v.verifiedAt,
      handoffPaid,
      blocks,
      railBlocks,
      onlyRail,
      noPaymentDue: amountAtomic === 0n,
      candidate,
      payable: candidate && railBlocks.length === 0,
    });
  }
  rows.sort((a, b) => (a.verifiedAt ?? 0) - (b.verifiedAt ?? 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return rows;
}

// ---------------------------------------------------------------- matching

// Pair tasks with transfers already on chain. Each task gets at most one
// transfer and no transfer is used twice. A transfer counts for a task only if
// it went to the task's worker wallet, was for at least the task amount (after
// scaling both by their own decimals), and was mined after the task was
// verified. Oldest task first, each taking the oldest transfer that fits.
// Transfers from several rails are ordered by time, since block numbers of
// different chains can't be compared.
// tasks: [{ id, wallet, amount: BigInt, decimals?, verifiedAt: ms }]
// transfers: [{ to, amount: BigInt, decimals?, rail?, timestamp: unix s, blockNumber, logIndex, txHash }]
export function matchPayments(tasks, transfers) {
  const seen = new Set();
  const pool = [];
  for (const x of transfers) {
    const key = `${x.rail ?? ''}:${x.txHash}:${x.logIndex}`;
    if (seen.has(key)) continue;
    seen.add(key);
    pool.push(x);
  }
  const ts = (x) => (x.timestamp == null ? Infinity : x.timestamp);
  pool.sort((a, b) => ts(a) - ts(b)
    || String(a.rail ?? '').localeCompare(String(b.rail ?? ''))
    || a.blockNumber - b.blockNumber
    || a.logIndex - b.logIndex);
  const order = [...tasks].sort((a, b) => a.verifiedAt - b.verifiedAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const used = new Set();
  const out = new Map();
  for (const t of order) {
    const need = scaleAtomic(t.amount, t.decimals ?? 6, 18);
    for (let i = 0; i < pool.length; i++) {
      if (used.has(i)) continue;
      const x = pool[i];
      if (!sameAddress(x.to, t.wallet)) continue;
      if (scaleAtomic(x.amount, x.decimals ?? 6, 18) < need) continue;
      if (x.timestamp == null || x.timestamp * 1000 <= t.verifiedAt) continue;
      used.add(i);
      out.set(t.id, x);
      break;
    }
  }
  return out;
}

// Combine per-rail scans into one answer: which tasks each transfer paid, and
// which tasks are covered. A task is covered only when EVERY rail in `rails`
// was checked back to its verification time, so a payment on any of them is
// seen before a Pay button appears.
// scans: Map(railName -> { transfers, coveredFromMs }); rails: the rails that must be checked.
export function combineChecks({ rows, scans, rails, handoffTxs = new Set() }) {
  const pool = [];
  let handoffOwned = 0;
  for (const rail of rails) {
    for (const x of scans.get(rail.name)?.transfers || []) {
      if (handoffTxs.has(String(x.txHash).toLowerCase())) { handoffOwned++; continue; }
      pool.push({ ...x, rail: rail.name, decimals: rail.decimals });
    }
  }
  const covered = new Set();
  const tasks = [];
  for (const r of rows) {
    if (!r.candidate) continue;
    const ok = rails.length > 0 && rails.every((rail) => {
      const s = scans.get(rail.name);
      return s && s.coveredFromMs != null && r.verifiedAt >= s.coveredFromMs;
    });
    if (!ok) continue;
    covered.add(r.id);
    tasks.push({ id: r.id, wallet: r.wallet, amount: r.amountAtomic, decimals: r.amountDecimals, verifiedAt: r.verifiedAt });
  }
  return { match: matchPayments(tasks, pool), covered, handoffOwned, transfers: pool.length };
}

// ---------------------------------------------------------------- spending cap

// cap and spent are in CAP_DECIMALS units; amount is in the paying token's
// decimals. cap === null means no cap.
export function checkCap({ cap, spent, amount, decimals = 6, unit = 'USDC' }) {
  if (typeof amount !== 'bigint' || amount <= 0n) return { ok: false, reason: 'nothing to pay' };
  if (cap == null) return { ok: true, remaining: null };
  const after = spent + toCapUnits(amount, decimals);
  if (after > cap) {
    return {
      ok: false,
      remaining: cap - spent,
      reason: `Paying ${formatAtomic(amount, decimals)} would bring this session to ${formatAtomic(after, CAP_DECIMALS)} ${unit}, over the ${formatAtomic(cap, CAP_DECIMALS)} ${unit} cap.`,
    };
  }
  return { ok: true, remaining: cap - after };
}

// ---------------------------------------------------------------- log scanning

export const isRateLimitError = (e) => e?.code === -32005 || e?.code === 429 || /rate limit|too many requests/i.test(e?.message || '');

// Errors that mean "ask for fewer blocks": block-range caps and result-count
// caps. Rate limits are not among them; those are retried, never shrunk.
export function isShrinkableLogError(e) {
  if (!e || isRateLimitError(e)) return false;
  if (e.code === -32000 || e.code === -32614) return true;
  const m = String(e.message || '');
  if (e.code === -32602 && /block|range|spans|allowed/i.test(m)) return true;
  return /exceeds limit|block range|limited to a|range is too|range too|narrow the|exceed.{0,30}(range|blocks)|query returned more than|too many (blocks|results|logs)|response size/i.test(m);
}

// A block-range cap stated in an error, or null. A result-count cap
// ("exceeds limit of 10000") is not a block range and returns null.
//   "eth_getLogs is limited to a 1,000 range"            -> 1000
//   "up to a 2K block range"                              -> 2000
//   "query spans 20000001 blocks …, but only 10000000 are allowed" -> 10000000
export function parseRangeLimit(message) {
  const s = String(message || '');
  const m = /only\s+([\d,]+)\s*(k)?\s*(?:blocks?\s*)?(?:are\s+)?allowed/i.exec(s)
    || /([\d,]+)\s*(k)?\s*(?:block\s*)?range/i.exec(s)
    || /range[^\d]{0,30}([\d,]+)\s*(k)?/i.exec(s);
  if (!m) return null;
  const n = Number(m[1].replace(/,/g, '')) * (m[2] ? 1000 : 1);
  return Number.isFinite(n) && n >= 1 ? n : null;
}

// Walk [fromBlock, toBlock] newest first with an injected fetchRange(lo, hi).
// - Up to strategy.concurrency ranges are fetched at once; only results that
//   are contiguous from the top are kept, so coverage never has holes.
// - A shrinkable error shrinks the range to the stated cap (remembered as the
//   new max) or to half, and retries. Any other error is thrown.
// - After two successes in a row the range doubles, up to the max.
// - At most maxCalls fetches; `low` is the lowest block fully covered.
export async function scanAdaptive({ fetchRange, fromBlock, toBlock, strategy, maxCalls = Infinity, onProgress }) {
  const items = [];
  let max = Math.max(1, strategy.max ?? strategy.initial);
  let size = Math.max(1, Math.min(strategy.initial, max));
  const concurrency = Math.max(1, strategy.concurrency || 1);
  let cursor = toBlock;
  let calls = 0;
  let streak = 0;
  let shrinks = 0;
  while (cursor >= fromBlock && calls < maxCalls) {
    const ranges = [];
    for (let hi = cursor; ranges.length < concurrency && hi >= fromBlock && calls + ranges.length < maxCalls; ) {
      const lo = Math.max(fromBlock, hi - size + 1);
      ranges.push([lo, hi]);
      hi = lo - 1;
    }
    calls += ranges.length;
    const results = await Promise.allSettled(ranges.map(([lo, hi]) => fetchRange(lo, hi)));
    let failure = null;
    for (let i = 0; i < results.length; i++) {
      if (results[i].status === 'rejected') { failure = { error: results[i].reason, range: ranges[i] }; break; }
      items.push(...(results[i].value || []));
      cursor = ranges[i][0] - 1;
    }
    if (failure) {
      const { error, range: [lo, hi] } = failure;
      const span = hi - lo + 1;
      if (!isShrinkableLogError(error) || span <= 1) throw error;
      const limit = parseRangeLimit(error.message);
      if (limit && limit < span) { size = limit; max = Math.min(max, limit); } else size = Math.max(1, Math.floor(span / 2));
      streak = 0;
      shrinks++;
    } else if (++streak >= 2 && size < max) {
      size = Math.min(max, size * 2);
      streak = 0;
    }
    onProgress?.({ low: cursor + 1, fromBlock, toBlock, calls, size });
  }
  return { items, low: cursor + 1, calls, shrinks, complete: cursor < fromBlock };
}

// ---------------------------------------------------------------- status and proof

// What to show for a row given what the chain checks know.
// check: output of combineChecks(), or null when no wallet has been checked.
export function rowStatus(row, check) {
  if (row.handoffPaid) return { kind: 'handoff', tx: row.handoffPaid.tx, url: row.handoffPaid.url };
  if (row.noPaymentDue) return { kind: 'none' };
  const m = check?.match?.get(row.id);
  if (m) return { kind: 'wallet', tx: m.txHash, transfer: m };
  if (row.blocks.length || row.railBlocks?.length) return { kind: 'blocked' };
  if (!check) return { kind: 'unpaid', checked: false };
  if (!check.covered?.has(row.id)) return { kind: 'unchecked' };
  return { kind: 'unpaid', checked: true };
}

// Plain text a requester can paste into handoff by hand. Each payment uses its
// own rail for the chain, token and explorer link.
export function proofText({ side, rails, project, payer, rows, check, generatedAt = new Date() }) {
  const railByName = new Map(rails.map((r) => [r.name, r]));
  const lines = [];
  const mine = [];
  const handoff = [];
  for (const r of rows) {
    const s = rowStatus(r, check);
    if (s.kind === 'wallet') mine.push([r, s]);
    else if (s.kind === 'handoff') handoff.push([r, s]);
  }
  lines.push(`handoff pay: payment proof (${side})`);
  if (project) lines.push(`project: ${project.id}${project.title ? ` (${project.title})` : ''}`);
  lines.push(`generated: ${generatedAt.toISOString()}`);
  if (payer) lines.push(`payer wallet: ${payer}`);
  lines.push('');
  const block = ([r, s], by) => {
    lines.push(`task ${r.id}: ${r.title}`);
    lines.push(`  worker: ${r.worker ?? 'unknown'}${r.wallet ? ` (${r.wallet})` : ''}`);
    const price = `${r.amountText ?? '?'} ${r.priceCurrency ?? 'USDC'}`;
    if (s.kind === 'wallet') {
      const rail = railByName.get(s.transfer.rail);
      const sym = rail?.symbol ?? '';
      lines.push(`  amount: ${price} (${formatAtomic(s.transfer.amount, rail?.decimals ?? 6)} ${sym} sent)`);
      const label = tokenLabel(sym, r.priceCurrency ?? 'USDC');
      if (label) lines.push(`  ${label}`);
      lines.push(`  paid by: ${by}`);
      if (rail) lines.push(`  chain: ${rail.label} (${rail.chainId})`);
      lines.push(`  tx: ${s.tx}`);
      const url = rail ? explorerTxUrl(rail.explorer, s.tx) : null;
      if (url) lines.push(`  link: ${url}`);
    } else {
      lines.push(`  amount: ${price}`);
      lines.push(`  paid by: ${by}`);
      const rail = railByName.get(r.handoffPaid?.network);
      if (rail) lines.push(`  chain: ${rail.label} (${rail.chainId})`);
      if (s.tx) {
        lines.push(`  tx: ${s.tx}`);
        if (s.url) lines.push(`  link: ${s.url}`);
      } else {
        lines.push(`  tx: not in handoff's public activity feed${r.handoffPaid?.receiptId ? ` (receipt ${r.handoffPaid.receiptId})` : ''}`);
      }
    }
    lines.push('');
  };
  if (mine.length) {
    lines.push(`Paid from your wallet (${mine.length}):`, '');
    for (const e of mine) block(e, `your wallet${payer ? ` ${payer}` : ''}`);
  }
  if (handoff.length) {
    lines.push(`Paid by handoff (${handoff.length}):`, '');
    for (const e of handoff) block(e, 'handoff');
  }
  if (!mine.length && !handoff.length) lines.push('No paid tasks yet.');
  return lines.join('\n').trimEnd() + '\n';
}

// A project id from a pasted id or a link that contains one.
export function extractProjectId(input) {
  const m = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.exec(String(input || ''));
  return m ? m[0].toLowerCase() : null;
}

// Fixed-size inclusive block ranges, newest first when descending.
export function chunkRanges(from, to, size, descending = false) {
  if (!(size >= 1) || to < from) return [];
  const out = [];
  if (descending) {
    for (let hi = to; hi >= from; hi -= size) out.push([Math.max(from, hi - size + 1), hi]);
  } else {
    for (let lo = from; lo <= to; lo += size) out.push([lo, Math.min(to, lo + size - 1)]);
  }
  return out;
}

// ---------------------------------------------------------------- XMBL sealed release (testnet only)

export const XMBL_LABEL = 'Key release sealed by the handoff broker with experimental, unaudited Cubic-LWE. Not an escrow: the broker minted the key. Testnet only.';
export const XMBL_CHAIN_ID = 84532; // Base Sepolia
export const XMBL_GAS_WEI = 20_000_000_000_000n; // 0.00002 ETH sent with the USDC so the worker can pay the sweep's gas
const XMB = /^xmb[0-9a-f]{40}$/;
const PRIVATE_FIELD = /evm[_-]?private[_-]?key|private[_-]?key|secret[_-]?key|mnemonic/i;

function findPrivateField(v, p = '') {
  if (!v || typeof v !== 'object') return null;
  for (const [k, x] of Object.entries(v)) {
    if (PRIVATE_FIELD.test(k)) return `${p}${k}`;
    const deeper = findPrivateField(x, `${p}${k}.`);
    if (deeper) return deeper;
  }
  return null;
}

// Checks the JSON a requester pastes from /xmbl/settlement/seal. Nothing here trusts the broker:
// every field the page acts on is validated, and a response carrying a private key is refused.
export function parseSealResponse(text) {
  const errors = [];
  const notes = [];
  let r;
  try { r = typeof text === 'string' ? JSON.parse(text) : text; } catch { return { ok: false, errors: ['That is not valid JSON. Paste the whole response from request-seal.'], notes }; }
  if (!r || typeof r !== 'object' || Array.isArray(r)) return { ok: false, errors: ['The response is not a JSON object.'], notes };
  const priv = findPrivateField(r);
  if (priv) errors.push(`The response contains "${priv}". A seal response must never carry a private key; don't use it.`);
  if (typeof r.claim_id !== 'string' || !r.claim_id) errors.push('claim_id is missing.');
  const f = r.fund_here && typeof r.fund_here === 'object' ? r.fund_here : {};
  if (!isAddress(f.address)) errors.push('fund_here.address is not a 0x address.');
  const chain = String(f.chain ?? 'base-sepolia').toLowerCase();
  if (!['base-sepolia', '84532', 'eip155:84532'].includes(chain)) errors.push(`fund_here.chain is ${f.chain}; this mode is Base Sepolia only.`);
  if (f.asset != null && String(f.asset).toUpperCase() !== 'USDC') errors.push(`fund_here.asset is ${f.asset}, not USDC.`);
  let amountAtomic = null;
  try {
    amountAtomic = toAtomic(String(f.amount), 6);
    if (amountAtomic <= 0n) { amountAtomic = null; errors.push('fund_here.amount is zero.'); }
  } catch { errors.push(`fund_here.amount "${f.amount}" is not a USDC amount.`); }
  const s = r.seal && typeof r.seal === 'object' ? r.seal : null;
  if (!s) errors.push('seal is missing.');
  else {
    if (s.alg !== 'xmbl-seal-v1') errors.push(`seal.alg is ${s.alg}, not xmbl-seal-v1.`);
    if (s.n !== 729) errors.push(`seal.n is ${s.n}, not 729.`);
    if (!XMB.test(String(s.receiver || ''))) errors.push('seal.receiver is not an xmb… address.');
  }
  if (r.submitted === false) notes.push('submitted: false. The broker did not anchor this on XMBL.');
  return {
    ok: errors.length === 0,
    errors,
    notes,
    claimId: r.claim_id ?? null,
    fund: { address: f.address ?? null, amountAtomic, amountText: amountAtomic != null ? formatAtomic(amountAtomic, 6) : null, chain: f.chain ?? null, asset: f.asset ?? 'USDC' },
    receiver: s?.receiver ?? null,
    submitted: r.submitted ?? null,
    type6: r.type6_xid ?? null,
  };
}

// The worker's claim-and-check line: "xmbl-check OK settlement=… claim=… fund=0x… receiver=xmb…".
// It is the worker's own report, not a proof; checking it against the pasted response catches mix-ups.
export function parseCheckLine(line, seal) {
  const m = /xmbl-check OK settlement=(\S+) claim=(\S+) fund=(0x[0-9a-fA-F]{40}) receiver=(xmb[0-9a-f]{40})/.exec(String(line || ''));
  if (!m) return { ok: false, errors: ['Paste the line claim-and-check printed, starting "xmbl-check OK".'] };
  const [, settlement, claim, fund, receiver] = m;
  const errors = [];
  if (seal?.ok) {
    if (claim !== seal.claimId) errors.push(`The worker checked claim ${claim}, not ${seal.claimId}.`);
    if (!sameAddress(fund, seal.fund.address)) errors.push(`The worker checked address ${fund}, not ${seal.fund.address}. Don't fund.`);
    if (receiver !== seal.receiver) errors.push(`The worker's xmb address ${receiver} is not the seal's receiver ${seal.receiver}.`);
  }
  return { ok: errors.length === 0, errors, settlement, claim, fund, receiver };
}

// ERC-20 balanceOf(address) calldata.
export const encodeBalanceOf = (addr) => `0x70a08231${addr.slice(2).toLowerCase().padStart(64, '0')}`;

// Which funding step the one-time address is at, read from the chain. Only a fresh address (never
// sent from, holding nothing) is funded, and it is funded with exactly the amount plus the gas top-up.
export function fundingStep({ usdc, eth, nonce, amountAtomic, gasWei = XMBL_GAS_WEI }) {
  if (nonce > 0) return { step: 'used', reason: 'The address has already sent a transaction (the worker swept, or it was reused). Fund nothing more; check the legs.' };
  if (usdc === 0n && eth === 0n) return { step: 'fund-usdc' };
  if (usdc === amountAtomic && eth === 0n) return { step: 'fund-gas' };
  if (usdc === amountAtomic && eth >= gasWei) return { step: 'funded' };
  return { step: 'unsafe', reason: `The address holds ${formatAtomic(usdc, 6)} USDC and ${eth} wei, which isn't a state this app funds from. Stop and check it; never reuse an address.` };
}

// Plain-text proof of the two Transfer legs.
export function xmblProofText({ seal, requester, worker, leg1, leg2, explorer }) {
  const line = (x) => `${formatAtomic(x.amount, 6)} USDC ${x.from} -> ${x.to}, tx ${x.txHash}${explorerTxUrl(explorer, x.txHash) ? ` (${explorerTxUrl(explorer, x.txHash)})` : ''}`;
  return [
    'handoff pay: XMBL sealed release proof (testnet, Base Sepolia)',
    XMBL_LABEL,
    `claim: ${seal.claimId}; one-time address: ${seal.fund.address}; sealed to ${seal.receiver}`,
    `leg 1, requester ${requester} -> one-time address: ${leg1 ? line(leg1) : 'not found'}`,
    `leg 2, one-time address -> worker ${worker || '(any)'}: ${leg2 ? line(leg2) : 'not found'}`,
  ].join('\n') + '\n';
}
