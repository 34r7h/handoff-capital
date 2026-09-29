#!/usr/bin/env node
// Worker side, after funding: move the USDC from the released key's address to the worker's own
// wallet on Base Sepolia, paying gas with the ETH the requester sent along. The transaction is
// signed inside @xmbl/identity (releaseAndSign); the key is never printed.
//
//   node sweep.mjs --settlement <id> --seal-response <file> --keys <folder> --to <worker 0x…>
//                  [--seal <claimed-seal.json>] [--rpc <url>] [--live]
//
// DRY RUN BY DEFAULT: prints the unsigned transaction and sends nothing. Only --live signs and sends.
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { parseArgs, loadWorkerKeys, checkSealResponse, checkReleasedAddress, planSweep, signSweep, txSigningHash, makeRpc, formatUsdc, isAddress, BASE_SEPOLIA, RefusedError } from './lib.mjs';

const fmtEth = (wei) => `${(Number(wei) / 1e18).toFixed(9)} ETH`;

export async function sweep({ argv, rpc, log = console.log }) {
  const a = parseArgs(argv, { flags: ['live', 'dry-run'] });
  for (const k of ['settlement', 'seal-response', 'keys', 'to']) if (!a[k]) throw new RefusedError(`--${k} is required`);
  if (!isAddress(a.to)) throw new RefusedError(`--to must be the worker's 0x wallet (got ${a.to})`);
  const resp = JSON.parse(fs.readFileSync(a['seal-response'], 'utf8'));
  const check = checkSealResponse(resp);
  if (!check.ok) { log(`SWEEP REFUSED: the seal response fails its checks:\n  - ${check.errors.join('\n  - ')}`); return 3; }
  const seal = a.seal ? JSON.parse(fs.readFileSync(a.seal, 'utf8')) : resp.seal;
  const keys = loadWorkerKeys(a.keys);
  const fund = check.fund.address;
  const owns = checkReleasedAddress(keys.lweSk, seal, fund);
  if (!owns.ok) { log(`SWEEP REFUSED: the released key controls ${owns.derived}, not ${fund}.`); return 3; }

  rpc = rpc || makeRpc(a.rpc || BASE_SEPOLIA.rpcUrl);
  const plan = await planSweep({ rpc, fund, to: a.to, expectedAtomic: check.fund.amountAtomic });
  const t = plan.tx;
  log(`${a.live ? 'LIVE' : 'DRY RUN: nothing signed or sent. Pass --live to sign and send.'}`);
  log(`from ${fund} (the released key's address) on Base Sepolia (${t.chainId})`);
  log(`  holds ${formatUsdc(plan.usdcBalance)} USDC and ${fmtEth(plan.ethBalance)}; nonce ${t.nonce}`);
  log(`  sweeps ${formatUsdc(plan.amount)} USDC to ${a.to}${plan.funded ? '' : ' (not funded yet: shows the expected amount)'}`);
  log(`  gas budget ${fmtEth(plan.gasBudget)} (${t.gas} gas at ${t.maxFeePerGas} wei max fee)${plan.enoughGas ? '' : ' - MORE THAN THE ETH IT HOLDS'}`);
  log('unsigned EIP-1559 transaction:');
  log(JSON.stringify({ type: '0x2', chainId: t.chainId, nonce: t.nonce, maxPriorityFeePerGas: String(t.maxPriorityFeePerGas), maxFeePerGas: String(t.maxFeePerGas), gas: String(t.gas), to: t.to, value: '0', data: t.data, accessList: [] }, null, 2));
  log(`signing hash: ${txSigningHash(t)}`);
  if (!a.live) return 0;

  if (!plan.funded) { log('SWEEP REFUSED: the address holds no USDC yet.'); return 3; }
  if (!plan.enoughGas) { log('SWEEP REFUSED: not enough ETH for gas at the address.'); return 3; }
  const signed = signSweep(keys.lweSk, seal, t, fund);
  const hash = await rpc('eth_sendRawTransaction', [signed.raw]);
  log(`sent: ${hash}`);
  log(`${BASE_SEPOLIA.explorer}${hash}`);
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  sweep({ argv: process.argv.slice(2) }).then((c) => process.exit(c), (e) => {
    console.error(e instanceof RefusedError ? e.message : `error: ${e.message}`);
    process.exit(2);
  });
}
