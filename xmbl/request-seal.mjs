#!/usr/bin/env node
// Requester side: ask the handoff broker (testnet) to mint a fresh EVM key, seal it to the worker's
// Cubic-LWE public key and store a claim. Signed as a handoff agent, with that agent's local key.
//
//   node request-seal.mjs --as <agentId> --settlement <id> --payer <0x…> --receiver-xmb <xmb…>
//                         --pk <lwe-pk.json> --amount <usdc> [--chain base-sepolia] [--out <file>] [--live]
//
// DRY RUN BY DEFAULT: prints the exact request (minus the signature and the pk body) and sends
// nothing. Only --live sends. Never takes or sends evm_private_key.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs, buildSealBody, findAgentSigKey, signedHeaders, checkSealResponse, postJson, fmtBytes, DEFAULT_API, RefusedError } from './lib.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

export async function requestSeal({ argv, fetchImpl = fetch, log = console.log, now = Date.now }) {
  const a = parseArgs(argv, { flags: ['live', 'dry-run'] });
  if (a.live && a['dry-run']) throw new RefusedError('pass either --live or --dry-run, not both');
  for (const k of ['as', 'settlement', 'payer', 'receiver-xmb', 'pk', 'amount']) if (!a[k]) throw new RefusedError(`--${k} is required`);
  const api = (a.api || DEFAULT_API).replace(/\/$/, '');
  if (/mainnet\./i.test(api)) throw new RefusedError('refused: XMBL sealed release is testnet only (https://handoff.lol)');
  const pkText = fs.readFileSync(a.pk, 'utf8');
  const body = buildSealBody({ settlement: a.settlement, payer: a.payer, receiverXmb: a['receiver-xmb'], pkJson: pkText, amount: a.amount, chain: a.chain || 'base-sepolia' });
  const bodyStr = JSON.stringify(body);
  const url = `${api}/xmbl/settlement/seal`;
  const key = findAgentSigKey(a.as);
  if (!key) throw new RefusedError(`no handoff signing key (sig_privkey) found for agent "${a.as}" under ~/.handoff`);
  const { headers, stmt, bodyHash } = signedHeaders(a.as, key.priv, 'POST', url, bodyStr, now());

  if (!a.live) {
    log('DRY RUN: nothing sent. Pass --live to send this request.');
    log('');
    log(`POST ${url}`);
    log('content-type: application/json');
    log(`x-agent-id: ${headers['x-agent-id']}`);
    log(`x-timestamp: ${headers['x-timestamp']}`);
    log(`x-signature: <redacted: Ed25519, ${headers['x-signature'].length} base64 chars, by ${a.as}'s handoff signing key from ~/.handoff/${key.where}>`);
    log('signed statement:');
    for (const line of stmt.split('\n')) log(`  ${line}`);
    log('');
    log(`body (${fmtBytes(Buffer.byteLength(bodyStr))}, sha256 ${bodyHash}; receiver_lwe_pk elided):`);
    log(JSON.stringify({ ...body, receiver_lwe_pk: `<${fmtBytes(Buffer.byteLength(pkText))} from ${a.pk}: Cubic-LWE public key, n = ${body.receiver_lwe_pk.n}>` }, null, 2));
    return 0;
  }

  const res = await postJson(fetchImpl, url, bodyStr, headers);
  const check = checkSealResponse(res);
  const out = path.resolve(a.out || path.join(here, 'out', `seal-${a.settlement}.json`));
  if (!check.ok) {
    log(`The broker's response failed the checks, so it was not saved:\n  - ${check.errors.join('\n  - ')}`);
    return 3;
  }
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(res));
  log(`claim_id: ${check.claimId}`);
  log(`fund_here: ${check.fund.amount} ${check.fund.asset ?? 'USDC'} to ${check.fund.address} on ${check.fund.chain ?? 'base-sepolia'}`);
  log(`sealed to: ${check.receiver}; submitted to XMBL: ${check.submitted}; type6_xid: ${check.type6 ?? 'none'}`);
  log(`saved the full response to ${out}. Give it to the worker. Do NOT fund until the worker's claim-and-check prints ADDRESS CHECK OK.`);
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  requestSeal({ argv: process.argv.slice(2) }).then((c) => process.exit(c), (e) => {
    console.error(e instanceof RefusedError ? e.message : `error: ${e.message}`);
    process.exit(2);
  });
}
