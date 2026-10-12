import { execFileSync } from 'node:child_process';
import { call, must, log, state, save, usdc } from './lib.mjs';
import { SEL, encodeCall, decodeState } from '../../capital-lib.js';
const RPC = 'https://sepolia.base.org', USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const CO = 'fc-studio', INV = 'SirKit', S = state.shares.address;
const cast = (...a) => execFileSync('cast', [...a, '--rpc-url', RPC], { encoding: 'utf8' }).trim();
const rcpt = (tx) => JSON.parse(execFileSync('cast', ['receipt', tx, '--json', '--rpc-url', RPC, '--confirmations', '1'], { encoding: 'utf8' }));
const wallet = async (id) => (await call(id, 'GET', `/api/v1/agents/${id}/wallet`)).wallet.address;
const st = () => decodeState(cast('call', S, 'state()(uint256,uint256,uint256,uint256,bool,uint256,uint256,uint256)') && execFileSync('cast', ['call', S, SEL.state, '--rpc-url', RPC], { encoding: 'utf8' }).trim());
const fmt = (s) => `supply ${s.supply} · sold ${s.sold}/${s.forSale} · price ${usdc(s.price)} · revenue ${usdc(s.revenue)} · claimed ${usdc(s.claimed)} · unbooked ${usdc(s.unbooked)}`;
async function wcall(as, to, data, what) {
  const r = must(await call(as, 'POST', `/api/v1/agents/${as}/wallet/call`, { to, data, value_wei: '0' }), what);
  const tx = r.tx || r.hash || r.tx_hash || r.result?.tx;
  const rc = rcpt(tx);
  if (rc.status !== '0x1' && rc.status !== 1 && rc.status !== '1') throw new Error(`${what} reverted: ${tx}`);
  return { tx, block: Number(BigInt(rc.blockNumber)), r };
}
const step = process.argv[2];
if (step === 'policy') {
  const r = must(await call(CO, 'PUT', `/api/v1/companies/${CO}`, { policies: [{ kind: 'onchain', scope: 'capital', ref: S, chain: 'base-sepolia' }] }), 'policy');
  log(`${CO} registered ${S} as its capital policy on handoff (kind onchain, scope capital, base-sepolia)`, { policy: r });
  log(`share contract state: ${fmt(st())}`);
}
if (step === 'buy') {
  const w = await wallet(INV);
  state.investor = { id: INV, wallet: w }; save();
  const bal0 = BigInt(cast('call', USDC, 'balanceOf(address)(uint256)', w).split(' ')[0]);
  const a = await wcall(INV, USDC, encodeCall(SEL.approve, ['address', 'uint256'], [S, 1000n]), 'approve');
  log(`${INV} (wallet ${w}, owner usr_fb2446eb53) approved the share contract for 0.001 USDC: tx ${a.tx} block ${a.block}`);
  const b = await wcall(INV, S, encodeCall(SEL.buy, ['uint256'], [1n]), 'buy');
  const bal1 = BigInt(cast('call', USDC, 'balanceOf(address)(uint256)', w).split(' ')[0]);
  const held = cast('call', S, 'balanceOf(address)(uint256)', w).split(' ')[0];
  log(`${INV} bought 1 share of ${CO} for 0.001 USDC: tx ${b.tx} block ${b.block}; its USDC ${usdc(bal0)} → ${usdc(bal1)}; it now holds ${held} of the shares`, { buy: b });
  log(`share contract state: ${fmt(st())}`);
}
