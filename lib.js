// Pure functions shared by the browser app, the smoke script and the tests.
// No I/O and no DOM here: everything takes plain data and returns plain data.

export const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
export const TRANSFER_SELECTOR = '0xa9059cbb';
export const UINT256_MAX = (1n << 256n) - 1n;

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
    timestamp: log.blockTimestamp != null ? hexNum(log.blockTimestamp) : null,
  };
}

// ---------------------------------------------------------------- settlement rail

function normalizeRail(n) {
  const rail = {
    name: String(n.name ?? `chain-${n.chainId}`),
    label: String(n.label ?? n.name ?? `Chain ${n.chainId}`),
    chainId: Number(n.chainId),
    usdc: n.usdc,
    decimals: n.decimals == null ? 6 : Number(n.decimals),
    rpcUrl: n.rpcUrl,
    explorer: n.explorer,
    nativeSymbol: n.nativeSymbol || 'ETH',
    testnet: n.testnet === true,
  };
  if (!Number.isInteger(rail.chainId) || rail.chainId <= 0) throw new Error(`rail ${rail.name}: bad chainId`);
  if (!isAddress(rail.usdc)) throw new Error(`rail ${rail.name}: bad USDC address`);
  if (!Number.isInteger(rail.decimals)) throw new Error(`rail ${rail.name}: bad decimals`);
  if (typeof rail.rpcUrl !== 'string' || !/^https?:\/\//.test(rail.rpcUrl)) throw new Error(`rail ${rail.name}: bad rpcUrl`);
  if (typeof rail.explorer !== 'string' || !/^https?:\/\//.test(rail.explorer)) throw new Error(`rail ${rail.name}: bad explorer`);
  return rail;
}

// /config/settlement is { defaultNetwork, networks: [...] } today; a flat
// { chainId, usdc, ... } object is accepted too.
export function railsFrom(settlement) {
  if (!settlement || typeof settlement !== 'object') throw new Error('settlement config is empty');
  const list = Array.isArray(settlement.networks) ? settlement.networks : settlement.chainId != null ? [settlement] : [];
  const rails = [];
  for (const n of list) {
    try { rails.push(normalizeRail(n)); } catch { /* skip malformed entries */ }
  }
  if (!rails.length) throw new Error('settlement config lists no usable network');
  return rails;
}

export function pickRail(settlement, name) {
  const rails = railsFrom(settlement);
  return rails.find((r) => r.name === name)
    || rails.find((r) => r.name === settlement.defaultNetwork)
    || rails[0];
}

export function explorerTxUrl(explorer, tx) {
  if (!isTxHash(tx) || typeof explorer !== 'string' || !explorer) return null;
  return explorer.endsWith('/') ? explorer + tx : `${explorer}/${tx}`;
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
  const currency = p.currency ?? p.asset ?? null;
  if (currency != null && String(currency).toUpperCase() !== 'USDC') return { ok: false, reason: `priced in ${currency}, not USDC` };
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

// Everything the app shows for one project, as plain rows.
// agents: Map(agentId -> { ok: true, agent } | { ok: false, notFound?: true, error?: string })
// receipts: output of receiptIndex(); rails: every rail on this side (for receipt links).
export function buildRows({ request, tasks, agents, receipts, rail, rails = [rail] }) {
  const rows = [];
  const railByName = new Map(rails.map((r) => [r.name, r]));
  for (const t of tasks || []) {
    if (!t || t.status !== 'verified') continue;
    const v = taskVerification(t, request?.requester);
    const worker = typeof t.assignee === 'string' && t.assignee.trim() ? t.assignee.trim() : null;
    const pay = readPayment(t, rail.decimals);
    const a = worker ? agents?.get(worker) : undefined;
    const rawWallet = a?.ok ? a.agent?.wallet_address ?? null : null;
    const wallet = isAddress(rawWallet) ? rawWallet : null;
    const blocks = [];

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
      if (pay.network && pay.network !== rail.name) blocks.push(`task asks to be paid on ${pay.network}, not ${rail.name}`);
      if (pay.payTo && !isAddress(pay.payTo)) blocks.push(`task names an invalid payee ${pay.payTo}`);
      else if (pay.payTo && wallet && !sameAddress(pay.payTo, wallet)) blocks.push(`task names payee ${pay.payTo}, which is not the worker's wallet`);
    }

    const r = receipts?.get(t.id);
    let handoffPaid = null;
    if (r) {
      const net = railByName.get(r.network);
      handoffPaid = { tx: r.tx, network: r.network, url: net ? explorerTxUrl(net.explorer, r.tx) : null, receiptId: r.receiptId, amount: r.amount };
    } else if (t.paid === true) {
      handoffPaid = { tx: null, network: null, url: null, receiptId: t.receipt_id ?? null, amount: null };
    }

    const amountAtomic = pay.ok ? pay.atomic : null;
    rows.push({
      id: t.id,
      title: typeof t.title === 'string' && t.title.trim() ? t.title : '(untitled task)',
      worker,
      wallet,
      amountAtomic,
      amountText: pay.ok ? pay.text : null,
      verifier: v.verifier,
      verifierRaw: v.verifierRaw,
      viaRequester: v.viaRequester,
      verifiedAt: v.verifiedAt,
      handoffPaid,
      blocks,
      noPaymentDue: amountAtomic === 0n,
      payable: blocks.length === 0 && !handoffPaid && amountAtomic != null && amountAtomic > 0n,
    });
  }
  rows.sort((a, b) => (a.verifiedAt ?? 0) - (b.verifiedAt ?? 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return rows;
}

// ---------------------------------------------------------------- matching

// Pair tasks with transfers already on chain. Each task gets at most one
// transfer and no transfer is used twice. A transfer counts for a task only if
// it went to the task's worker wallet, was for at least the task amount, and
// was mined after the task was verified. Oldest task first, each taking the
// oldest transfer that fits.
// tasks: [{ id, wallet, amount: BigInt, verifiedAt: ms }]
// transfers: [{ to, amount: BigInt, timestamp: unix seconds, blockNumber, logIndex, txHash }]
export function matchPayments(tasks, transfers) {
  const seen = new Set();
  const pool = [];
  for (const x of transfers) {
    const key = `${x.txHash}:${x.logIndex}`;
    if (seen.has(key)) continue;
    seen.add(key);
    pool.push(x);
  }
  pool.sort((a, b) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex);
  const order = [...tasks].sort((a, b) => a.verifiedAt - b.verifiedAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const used = new Set();
  const out = new Map();
  for (const t of order) {
    for (let i = 0; i < pool.length; i++) {
      if (used.has(i)) continue;
      const x = pool[i];
      if (!sameAddress(x.to, t.wallet)) continue;
      if (x.amount < t.amount) continue;
      if (x.timestamp == null || x.timestamp * 1000 <= t.verifiedAt) continue;
      used.add(i);
      out.set(t.id, x);
      break;
    }
  }
  return out;
}

// ---------------------------------------------------------------- spending cap

// All values in atomic units. cap === null means no cap.
export function checkCap({ cap, spent, amount, decimals = 6 }) {
  if (typeof amount !== 'bigint' || amount <= 0n) return { ok: false, reason: 'nothing to pay' };
  if (cap == null) return { ok: true, remaining: null };
  const after = spent + amount;
  if (after > cap) {
    return {
      ok: false,
      remaining: cap - spent,
      reason: `Paying ${formatAtomic(amount, decimals)} USDC would bring this session to ${formatAtomic(after, decimals)} USDC, over the ${formatAtomic(cap, decimals)} USDC cap.`,
    };
  }
  return { ok: true, remaining: cap - after };
}

// ---------------------------------------------------------------- log scanning helpers

// Inclusive block ranges of at most `size` blocks, newest first when descending.
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

// "eth_getLogs is limited to a 1,000 range" -> 1000; "up to a 2K block range" -> 2000.
export function parseRangeLimit(message) {
  const m = /([\d,]+)\s*(k)?\s*(?:block\s*)?range/i.exec(String(message || ''))
    || /range[^\d]{0,30}([\d,]+)\s*(k)?/i.exec(String(message || ''));
  if (!m) return null;
  const n = Number(m[1].replace(/,/g, '')) * (m[2] ? 1000 : 1);
  return Number.isFinite(n) && n >= 1 ? n : null;
}

// ---------------------------------------------------------------- status and proof

// What to show for a row given what the chain scan knows.
// scan: { payer, match: Map, coveredFromMs } or null when no wallet has been checked.
export function rowStatus(row, scan) {
  if (row.handoffPaid) return { kind: 'handoff', tx: row.handoffPaid.tx, url: row.handoffPaid.url };
  if (row.noPaymentDue) return { kind: 'none' };
  const m = scan?.match?.get(row.id);
  if (m) return { kind: 'wallet', tx: m.txHash, transfer: m };
  if (row.blocks.length) return { kind: 'blocked' };
  if (!scan) return { kind: 'unpaid', checked: false };
  if (scan.coveredFromMs == null || row.verifiedAt < scan.coveredFromMs) return { kind: 'unchecked' };
  return { kind: 'unpaid', checked: true };
}

// Plain text a requester can paste into handoff by hand.
export function proofText({ side, rail, project, payer, rows, scan, generatedAt = new Date() }) {
  const lines = [];
  const mine = [];
  const handoff = [];
  for (const r of rows) {
    const s = rowStatus(r, scan);
    if (s.kind === 'wallet') mine.push([r, s]);
    else if (s.kind === 'handoff') handoff.push([r, s]);
  }
  lines.push(`handoff pay: payment proof (${side}, ${rail.label}, chain ${rail.chainId})`);
  if (project) lines.push(`project: ${project.id}${project.title ? ` (${project.title})` : ''}`);
  lines.push(`generated: ${generatedAt.toISOString()}`);
  if (payer) lines.push(`payer wallet: ${payer}`);
  lines.push('');
  const block = ([r, s], by) => {
    lines.push(`task ${r.id}: ${r.title}`);
    lines.push(`  worker: ${r.worker ?? 'unknown'}${r.wallet ? ` (${r.wallet})` : ''}`);
    const amt = s.kind === 'wallet' ? `${formatAtomic(s.transfer.amount, rail.decimals)} USDC sent` : '';
    lines.push(`  amount: ${r.amountText ?? '?'} USDC${amt ? ` (${amt})` : ''}`);
    lines.push(`  paid by: ${by}`);
    if (s.tx) {
      lines.push(`  tx: ${s.tx}`);
      const url = s.kind === 'wallet' ? explorerTxUrl(rail.explorer, s.tx) : s.url;
      if (url) lines.push(`  link: ${url}`);
    } else {
      lines.push(`  tx: not in handoff's public activity feed${r.handoffPaid?.receiptId ? ` (receipt ${r.handoffPaid.receiptId})` : ''}`);
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
