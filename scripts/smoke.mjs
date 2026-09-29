#!/usr/bin/env node
// Read-only smoke test: loads a real project from handoff's public API and
// prints what the app would show with no wallet connected. Sends nothing,
// signs nothing, writes nothing to handoff.
//
//   node scripts/smoke.mjs [--side testnet|mainnet] [--project <id>] [--chain-check] [--limit N]
import { SIDES, getSettlement, getProject, getTasks, getActivity, getAgents, listProjects, makeRpc, scanTransfers, logChunkFor } from '../api.js';
import { railsFrom, pickRail, receiptIndex, buildRows, rowStatus, formatAtomic, toAtomic, matchPayments, decodeTransferLog, isTxHash } from '../lib.js';

const args = process.argv.slice(2);
const opt = (name, dflt) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : dflt; };
const side = opt('side', 'testnet');
const limit = Number(opt('limit', 25));
let projectId = opt('project', null);
const { api } = SIDES[side] || (() => { throw new Error(`unknown side ${side}`); })();

const settlement = await getSettlement(api);
const rails = railsFrom(settlement);
const rail = pickRail(settlement);
console.log(`side: ${side}  api: ${api}`);
console.log(`rail: ${rail.label} (${rail.name}), chain ${rail.chainId}, USDC ${rail.usdc}, ${rail.decimals} decimals, rpc ${rail.rpcUrl}`);
console.log(`other networks on this side: ${rails.filter((r) => r.name !== rail.name).map((r) => r.name).join(', ') || 'none'}`);

if (!projectId) {
  const list = await listProjects(api, 200);
  console.log(`/requests lists ${list.length} projects`);
  projectId = list[0]?.id;
  if (!projectId) { console.log('no projects on this side: the app shows its empty state'); process.exit(0); }
}

const [project, tasks, activity] = await Promise.all([getProject(api, projectId), getTasks(api, projectId), getActivity(api)]);
const receipts = receiptIndex(activity);
const verified = tasks.filter((t) => t.status === 'verified');
const byStatus = {};
for (const t of tasks) byStatus[t.status] = (byStatus[t.status] || 0) + 1;
console.log(`\nproject: ${project.id}  "${project.title}"  requester ${project.requester}`);
console.log(`tasks: ${tasks.length}  ${JSON.stringify(byStatus)}`);
const agents = await getAgents(api, [...new Set(verified.map((t) => t.assignee).filter(Boolean))]);
const rows = buildRows({ request: project, tasks, agents, receipts, rail, rails });
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
console.log(`payable now (would get a Pay button once a wallet scan confirms unpaid): ${rows.filter((r) => r.payable).length}`);

console.log(`\nfirst ${Math.min(limit, rows.length)} rows as the app would show them:`);
for (const r of rows.slice(0, limit)) {
  console.log(`\n- ${r.title.slice(0, 90)}`);
  console.log(`  task ${r.id}`);
  console.log(`  worker: ${r.worker ?? '(none)'}  wallet: ${r.wallet ?? '(none)'}`);
  console.log(`  amount: ${r.amountText != null ? `${r.amountText} USDC` : '(unreadable)'}`);
  console.log(`  verified by: ${r.verifier ?? '(unknown)'}${r.viaRequester ? ' (as requester)' : ''} at ${r.verifiedAt ? new Date(r.verifiedAt).toISOString() : '(unknown)'}`);
  console.log(`  status: ${label(r)}`);
  if (r.blocks.length) console.log(`  flags: ${r.blocks.join('; ')}`);
}

if (args.includes('--chain-check')) {
  // Prove the log scanner and decoder against a real settled payout on this rail.
  console.log(`\nchain check on ${rail.name}:`);
  const rec = (activity.receipts || []).find((x) => x.status === 'settled' && x.network === rail.name && isTxHash(x.tx));
  if (!rec) { console.log('  no settled receipt on this rail in the activity feed'); process.exit(0); }
  const rpc = makeRpc(rail.rpcUrl);
  const receipt = await rpc('eth_getTransactionReceipt', [rec.tx]);
  const log = receipt.logs.map((l) => ({ l, d: decodeTransferLog({ ...l, blockNumber: receipt.blockNumber }) }))
    .find(({ l, d }) => d && l.address.toLowerCase() === rail.usdc.toLowerCase() && d.to === rec.payTo.toLowerCase());
  if (!log) { console.log(`  tx ${rec.tx} has no USDC Transfer to ${rec.payTo}`); process.exit(1); }
  const block = Number(BigInt(receipt.blockNumber));
  const chunk = logChunkFor(rail.chainId);
  // Several recipients at once, as the app queries them (an OR list in topic2).
  const tos = [...new Set([rec.payTo, '0x000000000000000000000000000000000000dEaD', ...rows.map((r) => r.wallet).filter(Boolean)])].slice(0, 8);
  const found = await scanTransfers({ rpc, token: rail.usdc, from: log.d.from, tos, fromBlock: block - chunk - 500, toBlock: block + 10, chunk });
  const hit = found.find((f) => f.txHash === rec.tx);
  console.log(`  receipt ${rec.id}: amount "${rec.amount}" to ${rec.payTo} in ${rec.tx} (block ${block})`);
  console.log(`  chunked scan over ${chunk + 511} blocks from ${log.d.from} to ${tos.length} recipients: ${found.length} transfer(s); this one ${hit ? 'found' : 'MISSING'}`);
  if (!hit) process.exit(1);
  // Receipt amounts come in two unit styles: "0.05" (USDC) and "400000" (atomic).
  const asUsdc = (() => { try { return toAtomic(String(rec.amount), rail.decimals); } catch { return null; } })();
  const asAtomic = /^\d+$/.test(String(rec.amount)) ? BigInt(rec.amount) : null;
  const want = hit.amount === asUsdc ? asUsdc : hit.amount === asAtomic ? asAtomic : asUsdc;
  const units = want === asUsdc && hit.amount === asUsdc ? 'USDC' : 'atomic units';
  console.log(`  decoded amount ${formatAtomic(hit.amount, rail.decimals)} USDC vs receipt amount "${rec.amount}" read as ${units}: ${hit.amount === want ? 'match' : 'MISMATCH'}; mined ${new Date(hit.timestamp * 1000).toISOString()}`);
  const m = matchPayments([{ id: 'x', wallet: rec.payTo, amount: want, verifiedAt: hit.timestamp * 1000 - 60000 }], found);
  const late = matchPayments([{ id: 'x', wallet: rec.payTo, amount: want, verifiedAt: hit.timestamp * 1000 + 60000 }], found.filter((f) => f === hit));
  console.log(`  a task verified 1 min before it matches: ${m.get('x')?.txHash === rec.tx}; one verified 1 min after does not: ${late.size === 0}`);
  if (hit.amount !== want || m.get('x')?.txHash !== rec.tx || late.size !== 0) process.exit(1);
}
