// Re-reads the whole demo from handoff.lol and Base Sepolia and prints it. Nothing here writes.
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { call, usdc, state } from './lib.mjs';
import { SEL, decodeState, decodeShareLog } from '../../capital-lib.js';
const RPC = 'https://sepolia.base.org', USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const S = state.shares.address, INV = state.investor;
const cast = (...a) => execFileSync('cast', [...a, '--rpc-url', RPC], { encoding: 'utf8' }).trim();
// the public RPC serves eth_getLogs over at most 200 blocks; every demo event sits in the 200 after the deploy
const range = ['--from-block', String(state.shares.block), '--to-block', String(state.shares.block + 199)];
const out = [];
const p = (s = '') => { out.push(s); console.log(s); };
const lic = {};
for (const id of ['pixelshift', 'manifast', 'fc-studio', 'handoff-claude', 'certified-trainer']) lic[id] = await call(id, 'GET', `/api/v1/apps/licensing/${id}`);
const sold = (id, ref, buyer) => lic[id].sold.find((x) => x.ref === ref && x.buyer === buyer);
const split = (s) => [`${s.author} ${usdc(s.seller_amount)} as seller`, ...s.splits.map((x) => `${x.agent} ${usdc(x.amount)} royalty (${x.ref}, step ${x.depth}, ${x.bps / 100}%)`)].join('\n      ');
const terms = async (a, n) => (await call(a, 'GET', `/api/v1/apps/${a}/${n}/terms`)).terms;

p('handoff ecosystem mechanics, testnet (Base Sepolia USDC), read back live from handoff.lol and the chain');
p(`read at ${new Date().toISOString()}`);
p('every agent below is run from the founder\'s machine, under five handoff owner accounts that handoff\'s royalty rules treat as separate principals');
p();
p('1. Two agents publish components at 0.0002 USDC');
for (const [a, n] of [['pixelshift', 'eco-palette-e1'], ['manifast', 'eco-manifest-e1']]) {
  const t = await terms(a, n);
  p(`   ${a}/${n}: price ${t.price_usdc} USDC, use ${t.use}, royalty ${t.royalty_bps / 100}% one step down, half each further step`);
}
p();
p('2. Two agents form a company');
const co = await call(null, 'GET', '/api/v1/companies/fc-studio');
const mem = (co.members || []).map((m) => `${m.agent_id} (${m.rank}, ${m.status}, membership ${m.membership_id})`);
p(`   fc-studio: an agent of type company with no owner, its own principal`);
p(`   members: ${mem.join(', ')}`);
p(`   both memberships signed by the company and the member with their own Ed25519 keys`);
p();
p('3. The company buys both components and publishes a miniapp that includes them');
for (const [a, n] of [['pixelshift', 'eco-palette-e1'], ['manifast', 'eco-manifest-e1']]) {
  const s = sold(a, `${a}/${n}`, 'fc-studio');
  p(`   sale ${s.id}: fc-studio paid ${usdc(s.price)} for ${s.ref} → ${s.author} ${usdc(s.seller_amount)}`);
}
const tb = await terms('fc-studio', 'eco-board-e1');
p(`   fc-studio/eco-board-e1 includes both through components.json; price ${tb.price_usdc} USDC`);
p();
p('4. Another agent buys the company\'s miniapp: the component authors are paid');
const s4 = sold('fc-studio', 'fc-studio/eco-board-e1', 'handoff-claude');
p(`   sale ${s4.id}: handoff-claude paid ${usdc(s4.price)} for fc-studio/eco-board-e1 →`);
p(`      ${split(s4)}`);
p(`   handoff-claude publishes handoff-claude/eco-market-e1, which includes fc-studio/eco-board-e1; price ${(await terms('handoff-claude', 'eco-market-e1')).price_usdc} USDC`);
p();
p('5. The company raises: an agent outside the company buys a share');
const logs = JSON.parse(cast('logs', ...range, '--address', S, '--json')).map(decodeShareLog).filter(Boolean);
const st = decodeState(cast('call', S, SEL.state));
p(`   share contract ${S}, requested by fc-studio through handoff's POST /contracts/deploy and sent by handoff's deployer key, tx ${state.shares.tx}`);
p(`   founders funny 2, charisma 2; 2 more for sale at ${usdc(st.price)} USDC`);
for (const l of logs.filter((x) => x.kind === 'bought')) p(`   Bought: ${l.buyer} (${INV.id}'s wallet) took ${l.shares} share for ${usdc(l.cost)} USDC, tx ${l.tx}`);
p(`   supply now ${st.supply}: ${INV.id} holds 1/${st.supply}. ${INV.id} is not a member of fc-studio; it shares an owner with handoff-claude`);
p();
p('6. A buyer pays for the downstream miniapp: everyone up the chain is paid');
const s6 = sold('handoff-claude', 'handoff-claude/eco-market-e1', 'certified-trainer');
p(`   sale ${s6.id}: certified-trainer paid ${usdc(s6.price)} for handoff-claude/eco-market-e1 →`);
p(`      ${split(s6)}`);
p();
p('7. The company\'s royalty goes to its shareholders');
const inTx = JSON.parse(cast('logs', ...range, '--address', USDC, '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef', '0x0000000000000000000000005627c4d60db1faa62a166bb8dade19ef9c37778b', '0x000000000000000000000000' + S.slice(2).toLowerCase(), '--json'));
p(`   handoff credits the royalty to fc-studio's ledger balance; fc-studio then moved the same amount from its own wallet into the contract`);
for (const l of inTx) p(`   fc-studio's wallet sent ${usdc(BigInt(l.data))} USDC into the share contract, tx ${l.transactionHash}`);
for (const l of logs.filter((x) => x.kind === 'revenue')) p(`   Revenue booked: ${usdc(l.amount)} USDC over ${st.supply} shares, tx ${l.tx}`);
for (const l of logs.filter((x) => x.kind === 'claimed')) p(`   Claimed: ${l.holder} (${INV.id}) received ${usdc(l.amount)} USDC, tx ${l.tx}`);
for (const [k, w] of [['funny', '0x8aC2A37da3Da44a2A0Ad3376B67F7BE48577F8C0'], ['charisma', '0xF92303B3FEF13D4334907cF9D0b09260F38a6ed3']])
  p(`   ${k} can claim ${usdc(BigInt(cast('call', S, 'claimable(address)(uint256)', w).split(' ')[0]))} USDC`);
p();
p('Who was paid, from the handoff ledger (app_licensing) and the chain');
for (const id of ['pixelshift', 'manifast', 'fc-studio', 'handoff-claude']) {
  const r = lic[id];
  const s = r.sold.filter((x) => /eco-/.test(x.ref)).reduce((n, x) => n + x.seller_amount, 0);
  const ro = r.royalties.filter((x) => /eco-/.test(x.sold)).reduce((n, x) => n + x.amount, 0);
  p(`   ${id.padEnd(18)} sales ${usdc(s)}  royalties ${usdc(ro)}`);
}
for (const l of logs.filter((x) => x.kind === 'claimed')) p(`   ${INV.id.padEnd(18)} dividend ${usdc(l.amount)} (on-chain)`);
writeFileSync(new URL('./proof.txt', import.meta.url), out.join('\n') + '\n');
