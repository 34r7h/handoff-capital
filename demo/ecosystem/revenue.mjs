import { execFileSync } from 'node:child_process';
import { call, must, log, state, save, usdc } from './lib.mjs';
import { SEL, encodeCall, decodeState } from '../../capital-lib.js';
const RPC = 'https://sepolia.base.org', USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const CO = 'fc-studio', S = state.shares.address, INV = state.investor;
const cast = (...a) => execFileSync('cast', [...a, '--rpc-url', RPC], { encoding: 'utf8' }).trim();
const num = (s) => BigInt(s.split(' ')[0]);
const rcpt = (tx) => JSON.parse(execFileSync('cast', ['receipt', tx, '--json', '--rpc-url', RPC, '--confirmations', '1'], { encoding: 'utf8' }));
const st = () => decodeState(cast('call', S, SEL.state));
const fmt = (s) => `supply ${s.supply} · sold ${s.sold}/${s.forSale} · revenue ${usdc(s.revenue)} · claimed ${usdc(s.claimed)} · unbooked ${usdc(s.unbooked)}`;
const W = { funny: '0x8aC2A37da3Da44a2A0Ad3376B67F7BE48577F8C0', charisma: '0xF92303B3FEF13D4334907cF9D0b09260F38a6ed3', [INV.id]: INV.wallet };
const claimables = () => Object.entries(W).map(([k, w]) => `${k} ${usdc(num(cast('call', S, 'claimable(address)(uint256)', w)))}`).join(' · ');
const step = process.argv[2];
if (step === 'pay') {
  const sale = state.sales['certified-trainer>handoff-claude/eco-market-e1'];
  const r = must(await call(CO, 'POST', `/api/v1/agents/${CO}/wallet/spend`, { to: S, amount_usdc: '0.001' }), 'spend');
  const rc = rcpt(r.tx);
  log(`${CO} paid an amount equal to its 0.001 USDC royalty from sale ${sale} into its share contract ${S} from its own wallet (wallet/spend does not debit the handoff ledger) (gasless EIP-3009 through POST /wallet/spend): tx ${r.tx} block ${Number(BigInt(rc.blockNumber))}`, { spend: r });
  log(`share contract USDC balance ${usdc(num(cast('call', USDC, 'balanceOf(address)(uint256)', S)))}; state: ${fmt(st())}`);
  log(`claimable now (pro rata over 5 shares): ${claimables()}`);
}
if (step === 'claim') {
  const b0 = num(cast('call', USDC, 'balanceOf(address)(uint256)', INV.wallet));
  const r = must(await call(INV.id, 'POST', `/api/v1/agents/${INV.id}/wallet/call`, { to: S, data: encodeCall(SEL.claim), value_wei: '0' }), 'claim');
  const rc = rcpt(r.tx);
  if (Number(BigInt(rc.status)) !== 1) throw new Error('claim reverted ' + r.tx);
  const b1 = num(cast('call', USDC, 'balanceOf(address)(uint256)', INV.wallet));
  const logs = rc.logs.filter((l) => l.address.toLowerCase() === S.toLowerCase()).map((l) => l.topics[0].slice(0, 10));
  log(`${INV.id} claimed its dividend: tx ${r.tx} block ${Number(BigInt(rc.blockNumber))}; its USDC ${usdc(b0)} → ${usdc(b1)} (+${usdc(b1 - b0)}); contract events ${logs.join(', ')}`, { claim: r });
  log(`state: ${fmt(st())}; still claimable: ${claimables()}`);
}
