// Network reads: handoff's public HTTP API (GET only) and chain JSON-RPC.
// Works in the browser and in Node 18+ (global fetch). Never writes to handoff.
import { TRANSFER_TOPIC, decodeTransferLog, padTopicAddress, scanAdaptive, isRateLimitError } from './lib.js';

export const SIDES = {
  testnet: { label: 'Testnet', api: 'https://handoff.lol/api/v1', site: 'https://handoff.lol' },
  mainnet: { label: 'Mainnet', api: 'https://mainnet.handoff.lol/api/v1', site: 'https://mainnet.handoff.lol' },
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hex = (n) => `0x${Number(n).toString(16)}`;

export class HttpError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
  }
}

export async function getJson(url, { timeoutMs = 30000 } = {}) {
  let res;
  try {
    res = await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    const host = (() => { try { return new URL(url).host; } catch { return url; } })();
    throw new HttpError(`couldn't reach ${host} (${e.name === 'TimeoutError' ? 'timed out' : e.message})`, 0);
  }
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch { /* not JSON */ }
  if (!res.ok) throw new HttpError(body?.error || `HTTP ${res.status}`, res.status);
  if (body == null) throw new HttpError('the response was not JSON', res.status);
  if (body.success === false) throw new HttpError(body.error || 'request failed', res.status);
  return body;
}

// ---------------------------------------------------------------- handoff (read-only)

export const getSettlement = (api) => getJson(`${api}/config/settlement`);

export async function listProjects(api, limit = 200) {
  const body = await getJson(`${api}/requests?limit=${limit}`);
  return Array.isArray(body.requests) ? body.requests : [];
}

export async function getProject(api, id) {
  const body = await getJson(`${api}/requests/${encodeURIComponent(id)}`);
  return body.request ?? body;
}

export async function getTasks(api, id) {
  const body = await getJson(`${api}/requests/${encodeURIComponent(id)}/tasks`);
  return Array.isArray(body.tasks) ? body.tasks : [];
}

export async function getActivity(api) {
  return getJson(`${api}/activity`, { timeoutMs: 60000 });
}

export async function getAgent(api, id) {
  try {
    const body = await getJson(`${api}/agents/${encodeURIComponent(id)}`);
    const agent = body.agent ?? body;
    return { ok: true, agent };
  } catch (e) {
    if (e.status === 404) return { ok: false, notFound: true };
    return { ok: false, error: e.message };
  }
}

export async function getAgents(api, ids, concurrency = 6) {
  const out = new Map();
  const queue = [...new Set(ids.filter(Boolean))];
  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    while (queue.length) {
      const id = queue.shift();
      out.set(id, await getAgent(api, id));
    }
  }));
  return out;
}

// ---------------------------------------------------------------- JSON-RPC

export class RpcError extends Error {
  constructor(message, code, data) {
    super(message);
    this.name = 'RpcError';
    this.code = code;
    this.data = data;
  }
}

// fetch-based JSON-RPC client with backoff on rate limits and network blips.
export function makeRpc(url, { timeoutMs = 30000, retries = 5 } = {}) {
  let id = 0;
  return async function rpc(method, params = []) {
    for (let attempt = 0; ; attempt++) {
      try {
        let res;
        try {
          res = await fetch(url, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }),
            signal: AbortSignal.timeout(timeoutMs),
          });
        } catch (e) {
          throw new RpcError(`couldn't reach ${new URL(url).host} (${e.name === 'TimeoutError' ? 'timed out' : e.message})`, 'network');
        }
        if (res.status === 429) throw new RpcError('rate limited', 429);
        const text = await res.text();
        let body;
        try { body = JSON.parse(text); } catch { throw new RpcError(`RPC answered HTTP ${res.status} without JSON`, 'http'); }
        if (body.error) throw new RpcError(body.error.message || 'RPC error', body.error.code, body.error.data);
        if (!res.ok) throw new RpcError(`RPC answered HTTP ${res.status}`, 'http');
        return body.result;
      } catch (e) {
        const retryable = isRateLimitError(e) || e.code === 'network' || e.code === 'http';
        if (!retryable || attempt >= retries) throw e;
        await sleep(400 * 2 ** attempt + Math.random() * 250);
      }
    }
  };
}

// An EIP-1193 provider as the same (method, params) function.
export const walletRpc = (provider) => (method, params = []) => provider.request({ method, params });

export async function latestBlock(rpc) {
  return Number(BigInt(await rpc('eth_blockNumber', [])));
}

export async function blockTimestamp(rpc, n, cache) {
  if (cache?.has(n)) return cache.get(n);
  const b = await rpc('eth_getBlockByNumber', [hex(n), false]);
  if (!b) throw new RpcError(`block ${n} not found`, 'missing');
  const ts = Number(BigInt(b.timestamp));
  cache?.set(n, ts);
  return ts;
}

// A block at or before unix time `target` (seconds), found by stepping back
// from an estimate. Close enough to bound a scan; not necessarily the last one.
export async function blockAtOrBefore(rpc, target, latest, cache) {
  const latestTs = await blockTimestamp(rpc, latest, cache);
  if (target >= latestTs) return latest;
  const sampleN = Math.max(0, latest - 10000);
  const sampleTs = await blockTimestamp(rpc, sampleN, cache);
  const perBlock = Math.max(0.05, (latestTs - sampleTs) / Math.max(1, latest - sampleN));
  let n = Math.max(0, Math.floor(latest - (latestTs - target) / perBlock));
  for (let i = 0; i < 8 && n > 0; i++) {
    const ts = await blockTimestamp(rpc, n, cache);
    if (ts <= target) return n;
    n = Math.max(0, Math.floor(n - (ts - target) / perBlock) - 50 * (i + 1));
  }
  return n;
}

// Token Transfer logs from `from` (to any of `tos`, when given) in
// [fromBlock, toBlock], walked newest first with the rail's scan strategy:
// ranges shrink on range/result-limit errors and grow back after successes.
// Returns { transfers, low, calls, complete }: everything in [low, toBlock]
// was read; `complete` means low reached fromBlock. At most maxCalls queries.
export async function scanTransfers({ rpc, rail, from, tos = [], fromBlock, toBlock, maxCalls = Infinity, onProgress, timestampCache = new Map(), resolveTimestamps = true }) {
  if (toBlock < fromBlock) return { transfers: [], low: fromBlock, calls: 0, shrinks: 0, complete: true };
  const topics = [TRANSFER_TOPIC, padTopicAddress(from)];
  if (tos.length) topics.push(tos.map(padTopicAddress));
  const fetchRange = async (lo, hi) => {
    const logs = await rpc('eth_getLogs', [{ address: rail.token, topics, fromBlock: hex(lo), toBlock: hex(hi) }]);
    const out = [];
    for (const log of logs || []) {
      const d = decodeTransferLog(log);
      if (d) out.push({ ...d, rail: rail.name, decimals: rail.decimals });
    }
    return out;
  };
  const r = await scanAdaptive({ fetchRange, fromBlock, toBlock, strategy: rail.scan, maxCalls, onProgress });
  if (resolveTimestamps) {
    // Matching needs each transfer's mined time. Logs that carry none (or "0x0")
    // get it from their block. One claimed value is checked against its block;
    // if it disagrees, every log's time is read from its block instead.
    const claimed = r.items.find((d) => d.timestamp != null);
    if (claimed && (await blockTimestamp(rpc, claimed.blockNumber, timestampCache)) !== claimed.timestamp) {
      for (const d of r.items) d.timestamp = null;
    }
    for (const d of r.items) {
      if (d.timestamp == null) d.timestamp = await blockTimestamp(rpc, d.blockNumber, timestampCache);
    }
  }
  r.items.sort((x, y) => x.blockNumber - y.blockNumber || x.logIndex - y.logIndex);
  return { transfers: r.items, low: r.low, calls: r.calls, shrinks: r.shrinks, complete: r.complete };
}

export async function waitForReceipt(rpcs, txHash, { intervalMs = 3000, timeoutMs = 10 * 60 * 1000, onTick } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    for (const rpc of rpcs) {
      try {
        const r = await rpc('eth_getTransactionReceipt', [txHash]);
        lastError = null;
        if (r) return r;
        break; // this source answered "not yet"; wait before asking again
      } catch (e) {
        lastError = e; // try the next source
      }
    }
    onTick?.(lastError);
    await sleep(intervalMs);
  }
  return null;
}
