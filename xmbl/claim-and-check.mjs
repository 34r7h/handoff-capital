#!/usr/bin/env node
// Worker side, BEFORE the requester funds: MAYO-sign the claim, claim the seal (--live only), open
// it with the worker's Cubic-LWE secret key, derive the EVM address the released key controls and
// require it to equal fund_here.address. The key is never printed, logged or saved.
//
//   node claim-and-check.mjs --settlement <id> --claim <claim_id> --seal-response <file> --keys <folder>
//                            [--save-seal <file>] [--live]
//
// Without --live nothing is sent: the check runs on the seal inside --seal-response.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs, loadWorkerKeys, claimProof, checkSealResponse, checkReleasedAddress, assertNoPrivateKeyField, checkLine, postJson, DEFAULT_API, SEAL_ALG, SEAL_N, RefusedError } from './lib.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

export async function claimAndCheck({ argv, fetchImpl = fetch, log = console.log }) {
  const a = parseArgs(argv, { flags: ['live', 'dry-run'] });
  for (const k of ['settlement', 'claim', 'seal-response', 'keys']) if (!a[k]) throw new RefusedError(`--${k} is required`);
  const api = (a.api || DEFAULT_API).replace(/\/$/, '');
  if (/mainnet\./i.test(api)) throw new RefusedError('refused: XMBL sealed release is testnet only (https://handoff.lol)');
  const resp = JSON.parse(fs.readFileSync(a['seal-response'], 'utf8'));
  const check = checkSealResponse(resp);
  if (!check.ok) { log(`FUNDING UNSAFE: the seal response fails its checks:\n  - ${check.errors.join('\n  - ')}`); return 3; }
  if (check.claimId !== a.claim) { log(`FUNDING UNSAFE: --claim ${a.claim} is not the response's claim_id ${check.claimId}`); return 3; }
  const keys = loadWorkerKeys(a.keys);
  const proof = await claimProof(keys.mayo, a.claim);
  const claimBody = { settlement_id: a.settlement, claimant_address: keys.mayo.address, proof };

  let seal;
  if (a.live) {
    const res = await postJson(fetchImpl, `${api}/xmbl/settlement/claim`, JSON.stringify(claimBody));
    seal = res?.seal ?? res;
    const save = path.resolve(a['save-seal'] || path.join(here, 'out', `claimed-seal-${a.claim}.json`));
    fs.mkdirSync(path.dirname(save), { recursive: true });
    fs.writeFileSync(save, JSON.stringify(seal));
    log(`claimed the seal from the broker; saved it to ${save}`);
  } else {
    log('DRY RUN: the claim below was NOT sent. Pass --live to claim from the broker.');
    log(`  POST ${api}/xmbl/settlement/claim`);
    log(`  ${JSON.stringify({ ...claimBody, proof: { pub: `<MAYO public key, ${proof.pub.length} base64 chars>`, sig: `<MAYO signature over "${a.claim}", ${proof.sig.length} chars>` } })}`);
    log(`checking the seal inside ${a['seal-response']} instead.`);
    seal = resp.seal;
  }

  try { assertNoPrivateKeyField(seal, 'the seal'); } catch (e) { log(`FUNDING UNSAFE: ${e.message}`); return 3; }
  if (!seal || seal.alg !== SEAL_ALG || seal.n !== SEAL_N) { log(`FUNDING UNSAFE: the seal is not an ${SEAL_ALG} envelope with n = ${SEAL_N}`); return 3; }
  if (seal.receiver !== keys.mayo.address) { log(`FUNDING UNSAFE: the seal is addressed to ${seal.receiver}, not this worker (${keys.mayo.address})`); return 3; }

  let result;
  try {
    result = checkReleasedAddress(keys.lweSk, seal, check.fund.address);
  } catch (e) {
    log(`FUNDING UNSAFE: this worker's key cannot open the seal (${e.message})`);
    return 3;
  }
  if (!result.ok) {
    log(`FUNDING UNSAFE: the released key controls ${result.derived ?? 'no valid address'}, but fund_here.address is ${check.fund.address}.`);
    log('Do not fund it: USDC sent there could never be moved. (This is what the sealChainKey bug in @xmbl/identity 0.1.18/0.1.19 looks like.)');
    return 3;
  }
  log(`ADDRESS CHECK OK: the released key controls ${result.derived}, which is fund_here.address.`);
  log('Give the requester this line:');
  log(checkLine({ settlement: a.settlement, claimId: a.claim, fund: result.derived, receiver: keys.mayo.address }));
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  claimAndCheck({ argv: process.argv.slice(2) }).then((c) => process.exit(c), (e) => {
    console.error(e instanceof RefusedError ? e.message : `error: ${e.message}`);
    process.exit(2);
  });
}
