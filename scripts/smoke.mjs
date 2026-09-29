#!/usr/bin/env node
// Read-only smoke test. Loads a real project from handoff's public API and
// prints what the app would show with no wallet connected, and optionally
// checks the log scanner against real chains. Sends nothing, signs nothing,
// writes nothing to handoff.
//
//   node scripts/smoke.mjs [--side testnet|mainnet] [--project <id>] [--limit N] [--chain-check] [--robinhood]
import { SIDES, getSettlement, getProject, getTasks, getActivity, getAgents, listProjects, makeRpc, scanTransfers, latestBlock, blockTimestamp } from '../api.js';
import { railsForSide, pickRail, receiptIndex, buildRows, rowStatus, formatAtomic, toAtomic, matchPayments, decodeTransferLog, isTxHash, TRANSFER_TOPIC } from '../lib.js';

const args = process.argv.slice(2);
const opt = (name, dflt) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : dflt; };
const side = opt('side', 'testnet');
const limit = Number(opt('limit', 25));
let projectId = opt('project', null);
const { api } = SIDES[side] || (() => { throw new Error(`unknown side ${side}`); })();
const fail = (m) => { console.log(`  FAIL: ${m}`); process.exitCode = 1; };

const settlement = await getSettlement(api);
const rails = railsForSide(side, settlement);
const payRail = rails.find((r) => r.name === pickRail(settlement).name);
console.log(`side: ${side}  api: ${api}`);
for (const r of rails) console.log(`rail: ${r.label} (${r.name}), chain ${r.chainId}, ${r.symbol} ${r.token}, ${r.decimals} decimals, ${r.source === 'app' ? 'added by this app' : 'from handoff'}${r === payRail ? ', default pay rail' : ''}`);

let rows = [];
let activity = null;
if (!projectId && !args.includes('--robinhood')) {
  const list = await listProjects(api, 200);
  console.log(`/requests lists ${list.length} projects`);
  projectId = list[0]?.id;
  if (!projectId) console.log('no projects on this side: the app shows its empty state');
}

if (projectId) {
  const [project, tasks, feed] = await Promise.all([getProject(api, projectId), getTasks(api, projectId), getActivity(api)]);
  activity = feed;
  const receipts = receiptIndex(activity);
  const verified = tasks.filter((t) => t.status === 'verified');
  const byStatus = {};
  for (const t of tasks) byStatus[t.status] = (byStatus[t.status] || 0) + 1;
  console.log(`\nproject: ${project.id}  "${project.title}"  requester ${project.requester}`);
  console.log(`tasks: ${tasks.length}  ${JSON.stringify(byStatus)}`);
  const agents = await getAgents(api, [...new Set(verified.map((t) => t.assignee).filter(Boolean))]);
  rows = buildRows({ request: project, tasks, agents, receipts, payRail, rails });
  console.log(`verified tasks: ${rows.length}  (activity feed: ${activity.receipts?.length ?? 0} receipts shown of ${activity.stats?.receipts_total ?? '?'})`);

  const label = (r) => {
    const s = rowStatus(r, null);
    if (s.kind === 'handoff') return s.tx ? `paid by handoff → ${s.url || s.tx}` : `paid by handoff (receipt ${r.handoffPaid.receiptId ?? '?'}, tx not in public feed)`;
    if (s.kind === 'none') return 'no payment due (amount 0)';
    if (s.kind === 'blocked') return "can't pay";
    return 'unpaid (your wallet not checked: no wallet connected)';
  };
  const counts = {};
  for (const r of rows) { const k = label(r).split(' →')[0].split(' (')[0]; counts[k] = (counts[k] || 0) + 1; }
  console.log(`display summary: ${JSON.stringify(counts)}`);
  console.log(`payable on ${payRail.label} (a Pay button once every rail's check confirms unpaid): ${rows.filter((r) => r.payable).length}`);

  console.log(`\nfirst ${Math.min(limit, rows.length)} rows as the app would show them:`);
  for (const r of rows.slice(0, limit)) {
    console.log(`\n- ${r.title.slice(0, 90)}`);
    console.log(`  task ${r.id}`);
    console.log(`  worker: ${r.worker ?? '(none)'}  wallet: ${r.wallet ?? '(none)'}${r.custodial ? ' (custodial)' : ''}`);
    console.log(`  amount: ${r.amountText != null ? `${r.amountText} ${r.priceCurrency}` : '(unreadable)'}`);
    console.log(`  verified by: ${r.verifier ?? '(unknown)'}${r.viaRequester ? ' (as requester)' : ''} at ${r.verifiedAt ? new Date(r.verifiedAt).toISOString() : '(unknown)'}`);
    console.log(`  status: ${label(r)}`);
    const flags = [...r.blocks, ...r.railBlocks];
    if (flags.length) console.log(`  flags: ${flags.join('; ')}`);
  }
}

if (args.includes('--chain-check') && activity) {
  // Prove the scanner and decoder against a real settled payout on the default rail.
  const rail = payRail;
  console.log(`\nchain check on ${rail.name}:`);
  const rec = (activity.receipts || []).find((x) => x.status === 'settled' && x.network === rail.name && isTxHash(x.tx));
  if (!rec) {
    console.log('  no settled receipt on this rail in the activity feed');
  } else {
    const rpc = makeRpc(rail.rpcUrl);
    const receipt = await rpc('eth_getTransactionReceipt', [rec.tx]);
    const log = receipt.logs.map((l) => ({ l, d: decodeTransferLog({ ...l, blockNumber: receipt.blockNumber }) }))
      .find(({ l, d }) => d && l.address.toLowerCase() === rail.token.toLowerCase() && d.to === rec.payTo.toLowerCase());
    if (!log) fail(`tx ${rec.tx} has no ${rail.symbol} Transfer to ${rec.payTo}`);
    else {
      const block = Number(BigInt(receipt.blockNumber));
      // Several recipients at once, as the app queries them (an OR list in topic2).
      const tos = [...new Set([rec.payTo, '0x000000000000000000000000000000000000dEaD', ...rows.map((r) => r.wallet).filter(Boolean)])].slice(0, 8);
      const r = await scanTransfers({ rpc, rail, from: log.d.from, tos, fromBlock: block - 3000, toBlock: block + 10 });
      const hit = r.transfers.find((f) => f.txHash === rec.tx);
      console.log(`  receipt ${rec.id}: amount "${rec.amount}" to ${rec.payTo} in ${rec.tx} (block ${block})`);
      console.log(`  scan over 3,011 blocks from ${log.d.from} to ${tos.length} recipients: ${r.calls} calls, ${r.transfers.length} transfer(s); this one ${hit ? 'found' : 'MISSING'}`);
      if (!hit) fail('payout not found');
      else {
        // Receipt amounts come in two unit styles: "0.05" (USDC) and "400000" (atomic).
        const asUsdc = (() => { try { return toAtomic(String(rec.amount), rail.decimals); } catch { return null; } })();
        const asAtomic = /^\d+$/.test(String(rec.amount)) ? BigInt(rec.amount) : null;
        const want = hit.amount === asUsdc ? asUsdc : hit.amount === asAtomic ? asAtomic : asUsdc;
        console.log(`  decoded amount ${formatAtomic(hit.amount, rail.decimals)} ${rail.symbol} vs receipt amount "${rec.amount}": ${hit.amount === want ? 'match' : 'MISMATCH'}`);
        const m = matchPayments([{ id: 'x', wallet: rec.payTo, amount: want, verifiedAt: hit.timestamp * 1000 - 60000 }], r.transfers);
        const late = matchPayments([{ id: 'x', wallet: rec.payTo, amount: want, verifiedAt: hit.timestamp * 1000 + 60000 }], [hit]);
        console.log(`  a task verified 1 min before it matches: ${m.get('x')?.txHash === rec.tx}; one verified 1 min after does not: ${late.size === 0}`);
        if (hit.amount !== want || m.get('x')?.txHash !== rec.tx || late.size !== 0) fail('decode or match mismatch');
      }
    }
  }
}

if (args.includes('--robinhood')) {
  // Find a real, recent USDG Transfer on Robinhood Chain mainnet, then find it
  // again with the app's own adaptive scanner, filtered by its sender only.
  const rh = railsForSide('mainnet', await getSettlement(SIDES.mainnet.api)).find((r) => r.name === 'robinhood');
  console.log(`\nRobinhood Chain check (${rh.label}, chain ${rh.chainId}, ${rh.symbol} ${rh.token}):`);
  const base = makeRpc(rh.rpcUrl);
  const counts = { logs: 0, other: 0 };
  const rpc = (method, params) => { counts[method === 'eth_getLogs' ? 'logs' : 'other']++; return base(method, params); };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const chainId = Number(BigInt(await rpc('eth_chainId', [])));
  const latest = await latestBlock(rpc);
  console.log(`  eth_chainId ${chainId}, head block ${latest.toLocaleString()}`);
  if (chainId !== rh.chainId) fail('wrong chain');

  // Pick a quiet sender from the last 300 blocks (busy ones are market makers).
  const recent = await rpc('eth_getLogs', [{ address: rh.token, topics: [TRANSFER_TOPIC], fromBlock: `0x${(latest - 300).toString(16)}`, toBlock: `0x${latest.toString(16)}` }]);
  const bySender = new Map();
  for (const l of recent) {
    if (l.topics.length !== 3) continue;
    const list = bySender.get(l.topics[1]) || [];
    list.push(l);
    bySender.set(l.topics[1], list);
  }
  const ranked = [...bySender].sort((a, b) => a[1].length - b[1].length);
  console.log(`  last 300 blocks: ${recent.length} USDG transfers from ${bySender.size} senders`);
  let target = null;
  for (const [topic, list] of ranked.slice(0, 6)) {
    await sleep(300);
    const probe = await rpc('eth_getLogs', [{ address: rh.token, topics: [TRANSFER_TOPIC, topic], fromBlock: `0x${(latest - 1_000_000).toString(16)}`, toBlock: `0x${latest.toString(16)}` }]).catch((e) => ({ error: e }));
    if (Array.isArray(probe) && probe.length <= 200) { target = list[list.length - 1]; console.log(`  quiet sender 0x${topic.slice(26)}: ${probe.length} transfers in the last 1,000,000 blocks`); break; }
  }
  if (!target) fail('no quiet sender found');
  else {
    const want = { from: `0x${target.topics[1].slice(26)}`.toLowerCase(), to: `0x${target.topics[2].slice(26)}`.toLowerCase(), amount: BigInt(target.data), tx: target.transactionHash, logIndex: Number(BigInt(target.logIndex)), block: Number(BigInt(target.blockNumber)) };
    console.log(`  target: ${formatAtomic(want.amount, rh.decimals)} USDG ${want.from} -> ${want.to}, tx ${want.tx}, block ${want.block.toLocaleString()}`);
    const span = 12_100_000; // about 14 days at ~10 blocks a second
    const before = { ...counts };
    const t0 = Date.now();
    const r = await scanTransfers({ rpc, rail: rh, from: want.from, fromBlock: want.block - span + 1, toBlock: want.block, timestampCache: new Map() });
    const logCalls = counts.logs - before.logs;
    const fromTs = await blockTimestamp(rpc, r.low);
    const toTs = await blockTimestamp(rpc, want.block);
    console.log(`  adaptive scan, from-filtered: ${logCalls} eth_getLogs calls (${r.shrinks} shrink${r.shrinks === 1 ? '' : 's'}), ${(want.block - r.low + 1).toLocaleString()} blocks = ${((toTs - fromTs) / 86400).toFixed(1)} days (${new Date(fromTs * 1000).toISOString().slice(0, 16)} to ${new Date(toTs * 1000).toISOString().slice(0, 16)}), complete ${r.complete}, ${r.transfers.length} transfers, ${Date.now() - t0} ms`);
    const hit = r.transfers.find((x) => x.txHash === want.tx && x.logIndex === want.logIndex);
    const ok = hit && hit.from === want.from && hit.to === want.to && hit.amount === want.amount && hit.rail === 'robinhood';
    console.log(`  found it: ${!!hit}; decoded from/to/amount match the raw log: ${!!ok}`);
    if (!ok) fail('decoded transfer does not match');
    const receipt = await rpc('eth_getTransactionReceipt', [want.tx]);
    const inReceipt = receipt?.logs?.some((l) => l.address.toLowerCase() === rh.token.toLowerCase() && Number(BigInt(l.logIndex)) === want.logIndex && BigInt(l.data) === want.amount);
    console.log(`  the tx receipt has the same USDG log: ${!!inReceipt}; receipt status ${receipt?.status}`);
    if (!inReceipt) fail('receipt does not confirm the log');
    if (hit) {
      const m = matchPayments([{ id: 'x', wallet: want.to, amount: want.amount, verifiedAt: hit.timestamp * 1000 - 60000 }], [hit]);
      const late = matchPayments([{ id: 'x', wallet: want.to, amount: want.amount, verifiedAt: hit.timestamp * 1000 + 60000 }], [hit]);
      console.log(`  a task verified 1 min before it matches: ${m.size === 1}; one verified 1 min after does not: ${late.size === 0}`);
      if (m.size !== 1 || late.size !== 0) fail('matching rule');
    }

    // A busy sender over ~6 hours, to see the result-count cap and halving live.
    const [busyTopic] = ranked[ranked.length - 1];
    const busy = `0x${busyTopic.slice(26)}`;
    const b0 = counts.logs;
    const rb = await scanTransfers({ rpc, rail: rh, from: busy, fromBlock: latest - 200_000 + 1, toBlock: latest });
    console.log(`  busy sender ${busy} over 200,000 blocks: ${counts.logs - b0} eth_getLogs calls, ${rb.shrinks} shrink${rb.shrinks === 1 ? '' : 's'}, ${rb.transfers.length} transfers, complete ${rb.complete}`);
    if (!rb.complete) fail('busy scan incomplete');
  }
  console.log(`  RPC calls in this check: ${counts.logs} eth_getLogs, ${counts.other} other`);
}
