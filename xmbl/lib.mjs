// Shared helpers for the XMBL sealed key release scripts (testnet only).
//
// Nothing here prints, logs or returns a released EVM private key. Functions that must hold one
// (address derivation, signing) take it, use it, and zero the buffer before returning.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, createPrivateKey, sign as edSign } from 'node:crypto';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { sealKeyPair, openSecret, releaseAndSign, Identity, sign as mayoSign } from '@xmbl/identity';

export const SEAL_N = 729; // the broker requires the mainnet lattice for receiver_lwe_pk
export const SEAL_ALG = 'xmbl-seal-v1';
export const DEFAULT_API = 'https://handoff.lol/api/v1'; // testnet only
export const BASE_SEPOLIA = Object.freeze({
  name: 'base-sepolia',
  chainId: 84532,
  usdc: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
  rpcUrl: 'https://sepolia.base.org',
  explorer: 'https://sepolia.basescan.org/tx/',
});
export const XMB_RE = /^xmb[0-9a-f]{40}$/;
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
export const isAddress = (v) => typeof v === 'string' && ADDRESS_RE.test(v);
export const sameAddress = (a, b) => isAddress(a) && isAddress(b) && a.toLowerCase() === b.toLowerCase();

const hex = (u8) => Buffer.from(u8).toString('hex');

// ---------------------------------------------------------------- arguments

// A route parameter this project must never send, in any spelling.
const FORBIDDEN = /evm[_-]?private[_-]?key/i;

export class RefusedError extends Error {}

// `--name value`, `--name=value` and bare `--flag`. Refuses any argument named evm_private_key.
export function parseArgs(argv, { flags = [] } = {}) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (FORBIDDEN.test(a)) throw new RefusedError('refused: this tool never takes or sends evm_private_key. The broker must mint the key; see the README.');
    if (!a.startsWith('--')) throw new RefusedError(`unexpected argument ${a}`);
    const eq = a.indexOf('=');
    const name = a.slice(2, eq > 0 ? eq : undefined);
    if (eq > 0) out[name] = a.slice(eq + 1);
    else if (flags.includes(name)) out[name] = true;
    else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) out[name] = argv[++i];
    else throw new RefusedError(`--${name} needs a value`);
  }
  return out;
}

// Throws if any key anywhere in `obj` is named like evm_private_key.
export function assertNoPrivateKeyField(obj, where = 'request') {
  const walk = (v, p) => {
    if (!v || typeof v !== 'object') return;
    for (const [k, x] of Object.entries(v)) {
      if (FORBIDDEN.test(k)) throw new RefusedError(`refused: ${where} contains ${p}${k}. This tool never sends or accepts evm_private_key.`);
      walk(x, `${p}${k}.`);
    }
  };
  walk(obj, '');
}

export function requireDecimalUsdc(s) {
  if (typeof s !== 'string' || !/^(?:\d+)(?:\.\d{1,6})?$/.test(s) || /^0+(?:\.0+)?$/.test(s)) {
    throw new RefusedError(`--amount must be a positive USDC amount with at most 6 decimals (got ${s})`);
  }
  return s;
}

export function toAtomic6(s) {
  const [w, f = ''] = String(s).split('.');
  return BigInt(w) * 1_000_000n + BigInt((f + '000000').slice(0, 6));
}
export function formatUsdc(atomic) {
  const a = BigInt(atomic);
  const frac = (a % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '');
  return `${a / 1_000_000n}.${frac.padEnd(2, '0')}`;
}

// ---------------------------------------------------------------- worker keys

// Cubic-LWE keys hold small integers (< q = 3329), so JSON numbers carry them exactly.
export function serializeLwePk(pk) {
  return JSON.stringify({ A: pk.A.map((r) => r.map(Number)), b: pk.b.map(Number), n: pk.n, q: Number(pk.q) });
}
export function parseLwePk(json) {
  const o = typeof json === 'string' ? JSON.parse(json) : json;
  if (!o || o.n !== SEAL_N || !Array.isArray(o.A) || o.A.length !== o.n || !Array.isArray(o.b) || o.b.length !== o.n) {
    throw new RefusedError(`receiver_lwe_pk must be a Cubic-LWE public key with n = ${SEAL_N} (got n = ${o?.n})`);
  }
  return o;
}
const serializeLweSk = (sk) => JSON.stringify({ s: sk.s.map(Number), n: sk.n, q: Number(sk.q) });
const parseLweSk = (json) => {
  const o = JSON.parse(json);
  return { s: o.s.map((x) => BigInt(x)), n: o.n, q: BigInt(o.q) };
};

function writeSecret(file, text) {
  fs.writeFileSync(file, text, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
}

// A fresh Cubic-LWE seal key pair and a fresh MAYO identity for the claim proof.
// Secrets go to 0600 files in `dir`; the return value holds public data only.
export async function makeWorkerKeys(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (const f of ['lwe.sk', 'mayo.sk']) {
    if (fs.existsSync(path.join(dir, f))) throw new RefusedError(`${path.join(dir, f)} already exists. Use a fresh folder per payout; keys are never reused.`);
  }
  const { pk, sk } = sealKeyPair(); // N = 729
  const id = await Identity.create();
  const pkFile = path.join(dir, 'lwe-pk.json');
  writeSecret(path.join(dir, 'lwe.sk'), serializeLweSk(sk));
  writeSecret(path.join(dir, 'mayo.sk'), JSON.stringify({ address: id.address, publicKey: id.publicKey, privateKey: id.privateKey }));
  fs.writeFileSync(pkFile, serializeLwePk(pk));
  const pub = { xmb: id.address, mayoPublicKey: id.publicKey, pkFile, pkBytes: fs.statSync(pkFile).size, n: pk.n };
  fs.writeFileSync(path.join(dir, 'identity.json'), JSON.stringify({ xmb: pub.xmb, mayo_public_key: pub.mayoPublicKey, lwe_pk_file: 'lwe-pk.json', n: pub.n }, null, 2));
  return pub;
}

export function loadWorkerKeys(dir) {
  const read = (f) => fs.readFileSync(path.join(dir, f), 'utf8');
  const mayo = JSON.parse(read('mayo.sk'));
  return { lweSk: parseLweSk(read('lwe.sk')), mayo };
}

// ---------------------------------------------------------------- handoff agent signing

// The scheme handoff's own tools use (~/.handoff/handoff-lib.mjs signedRestHeaders):
// Ed25519 (PKCS#8 DER, base64 `sig_privkey`) over
//   "handoff-signed-req\n<agentId>\n<METHOD>\n<pathname>\n<ts ms>\n<sha256 hex of the body>"
export function signingStatement(agentId, method, url, ts, bodyStr) {
  const bodyHash = createHash('sha256').update(Buffer.from(bodyStr || '', 'utf8')).digest('hex');
  return { stmt: `handoff-signed-req\n${agentId}\n${method.toUpperCase()}\n${new URL(url).pathname}\n${ts}\n${bodyHash}`, bodyHash };
}
export function signedHeaders(agentId, sigPriv, method, url, bodyStr, ts = Date.now()) {
  const { stmt, bodyHash } = signingStatement(agentId, method, url, ts, bodyStr);
  const key = createPrivateKey({ key: Buffer.from(sigPriv, 'base64'), format: 'der', type: 'pkcs8' });
  return { headers: { 'x-agent-id': agentId, 'x-signature': edSign(null, Buffer.from(stmt, 'utf8'), key).toString('base64'), 'x-timestamp': String(ts) }, stmt, bodyHash };
}

// Where handoff keeps an agent's signing key, in the order handoff's own resolver trusts them.
// Unlike that resolver, a file outside agents/<id>/ must NAME the agent (agent_id) to be used, so
// another agent's key can never be picked up by accident. Returns { priv, where } or null.
export function findAgentSigKey(id, root = process.env.HANDOFF_HOME || path.join(os.homedir(), '.handoff')) {
  const cands = [];
  if (process.env.AGENT_ID === id && process.env.AGENT_SIG_PRIVKEY) cands.push({ where: 'env AGENT_SIG_PRIVKEY', obj: { agent_id: id, sig_privkey: process.env.AGENT_SIG_PRIVKEY }, named: true });
  const tryJson = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } };
  const own = tryJson(path.join(root, 'agents', id, 'config.json'));
  if (own) cands.push({ where: `agents/${id}/config.json`, obj: own, named: true });
  const dirs = [];
  try { for (const h of fs.readdirSync(path.join(root, 'keys'))) dirs.push(path.join('keys', h)); } catch { /* none */ }
  try {
    for (const h of fs.readdirSync(root)) {
      if (['agents', 'keys', 'test'].includes(h) || h.startsWith('.') || h.includes('.')) continue;
      dirs.push(h);
    }
  } catch { /* none */ }
  for (const d of dirs) {
    let files = [];
    try { if (!fs.statSync(path.join(root, d)).isDirectory()) continue; files = fs.readdirSync(path.join(root, d)); } catch { continue; }
    for (const f of files) {
      if (!f.endsWith('.json') || f.includes('inbox')) continue;
      const obj = tryJson(path.join(root, d, f));
      if (obj && !Array.isArray(obj)) cands.push({ where: `${d}/${f}`, obj });
    }
  }
  try {
    for (const d of fs.readdirSync(path.join(root, 'agents'))) {
      const st = tryJson(path.join(root, 'agents', d, 'crypto-keys.json'));
      if (st) cands.push({ where: `agents/${d}/crypto-keys.json`, obj: { agent_id: st.agent_id, sig_privkey: st.sig_privkey || st.sig?.priv } });
    }
  } catch { /* none */ }
  for (const c of cands) {
    const owner = c.obj?.agent_id;
    if (owner != null ? String(owner).toLowerCase() !== id.toLowerCase() : !c.named) continue;
    const priv = c.obj.sig_privkey || c.obj.sig?.priv;
    if (typeof priv === 'string' && priv.trim()) return { priv, where: c.where };
  }
  return null;
}

// ---------------------------------------------------------------- seal requests and responses

export function buildSealBody({ settlement, payer, receiverXmb, pkJson, amount, chain = 'base-sepolia' }) {
  if (!settlement || typeof settlement !== 'string') throw new RefusedError('--settlement is required');
  if (!isAddress(payer)) throw new RefusedError(`--payer must be a 0x address (got ${payer})`);
  if (!XMB_RE.test(receiverXmb || '')) throw new RefusedError(`--receiver-xmb must be an xmb… address (xmb + 40 hex; got ${receiverXmb})`);
  if (chain !== 'base-sepolia') throw new RefusedError(`--chain ${chain} refused: XMBL sealed release is testnet only (base-sepolia)`);
  requireDecimalUsdc(amount);
  const pk = parseLwePk(pkJson);
  const body = { settlement_id: settlement, payer_address: payer, receiver_address: receiverXmb, receiver_lwe_pk: pk, amount_usdc: amount, evm_chain: chain };
  assertNoPrivateKeyField(body);
  return body;
}

// Checks a /xmbl/settlement/seal response. Returns the fields this project relies on.
export function checkSealResponse(r) {
  const errors = [];
  if (!r || typeof r !== 'object') return { ok: false, errors: ['the response is not a JSON object'] };
  try { assertNoPrivateKeyField(r, 'the seal response'); } catch (e) { errors.push(e.message); }
  if (typeof r.claim_id !== 'string' || !r.claim_id) errors.push('claim_id is missing');
  const f = r.fund_here || {};
  if (!isAddress(f.address)) errors.push('fund_here.address is not a 0x address');
  if (f.chain != null && !['base-sepolia', '84532', 'eip155:84532'].includes(String(f.chain).toLowerCase())) errors.push(`fund_here.chain is ${f.chain}, not base-sepolia`);
  if (f.asset != null && String(f.asset).toUpperCase() !== 'USDC') errors.push(`fund_here.asset is ${f.asset}, not USDC`);
  let amountAtomic = null;
  try { amountAtomic = toAtomic6(requireDecimalUsdc(String(f.amount))); } catch { errors.push(`fund_here.amount ${f.amount} is not a USDC amount`); }
  const s = r.seal;
  if (!s || s.alg !== SEAL_ALG) errors.push(`seal.alg is ${s?.alg}, not ${SEAL_ALG}`);
  else {
    if (s.n !== SEAL_N) errors.push(`seal.n is ${s.n}, not ${SEAL_N}`);
    if (!XMB_RE.test(s.receiver || '')) errors.push('seal.receiver is not an xmb… address');
  }
  return { ok: errors.length === 0, errors, claimId: r.claim_id, fund: { address: f.address, chain: f.chain, asset: f.asset, amount: f.amount, amountAtomic }, receiver: s?.receiver, submitted: r.submitted, type6: r.type6_xid };
}

// ---------------------------------------------------------------- the released key

// secp256k1 uncompressed public key -> keccak256 of its 64 coordinate bytes -> last 20 bytes.
export function evmAddressFromKey(key32) {
  const pub = secp256k1.getPublicKey(Uint8Array.from(key32), false); // 65 bytes, 0x04 || X || Y
  return `0x${hex(keccak_256(pub.slice(1)).slice(-20))}`;
}

// What sealChainKey('evm') in @xmbl/identity 0.1.18/0.1.19 reports: keccak256 of the COMPRESSED key
// minus its prefix byte. No key controls that address. Used only to prove the check catches it.
export function buggyCompressedAddress(key32) {
  const pub = secp256k1.getPublicKey(Uint8Array.from(key32), true);
  return `0x${hex(keccak_256(pub.slice(1)).slice(-20))}`;
}

// Opens the seal, derives the address the released key controls, zeroes the key, and compares.
// Never returns the key.
export function checkReleasedAddress(lweSk, seal, fundAddress) {
  const key = openSecret(lweSk, seal);
  try {
    if (key.length !== 32 || !secp256k1.utils.isValidSecretKey(Uint8Array.from(key))) {
      return { ok: false, derived: null, reason: 'the sealed secret is not a valid 32-byte secp256k1 key' };
    }
    const derived = evmAddressFromKey(key);
    return { ok: sameAddress(derived, fundAddress), derived };
  } finally {
    key.fill(0);
  }
}

// The line the worker hands the requester; the miniapp checks it names the same claim and address.
export const checkLine = ({ settlement, claimId, fund, receiver }) => `xmbl-check OK settlement=${settlement} claim=${claimId} fund=${fund.toLowerCase()} receiver=${receiver}`;

// ---------------------------------------------------------------- claim

export async function claimProof(mayo, claimId) {
  const sig = await mayoSign(claimId, mayo.privateKey);
  return { pub: mayo.publicKey, sig };
}

// ---------------------------------------------------------------- EIP-1559 transaction (sweep)

function rlpLength(len, offset) {
  if (len < 56) return Uint8Array.of(offset + len);
  const b = beBytes(BigInt(len));
  return Uint8Array.of(offset + 55 + b.length, ...b);
}
function beBytes(n) {
  if (n === 0n) return new Uint8Array(0);
  let h = n.toString(16);
  if (h.length % 2) h = `0${h}`;
  return Uint8Array.from(Buffer.from(h, 'hex'));
}
// RLP: Uint8Array | bigint | number | hex string ('0x…') | array.
export function rlp(v) {
  if (Array.isArray(v)) {
    const body = Buffer.concat(v.map((x) => Buffer.from(rlp(x))));
    return Uint8Array.from(Buffer.concat([rlpLength(body.length, 0xc0), body]));
  }
  let bytes;
  if (typeof v === 'bigint' || typeof v === 'number') bytes = beBytes(BigInt(v));
  else if (typeof v === 'string') bytes = Uint8Array.from(Buffer.from(v.startsWith('0x') ? v.slice(2) : v, v.startsWith('0x') ? 'hex' : 'utf8'));
  else bytes = Uint8Array.from(v);
  if (bytes.length === 1 && bytes[0] < 0x80) return bytes;
  return Uint8Array.from(Buffer.concat([rlpLength(bytes.length, 0x80), bytes]));
}

export function encodeTransfer(to, amount) {
  if (!isAddress(to)) throw new RefusedError(`not an address: ${to}`);
  return `0xa9059cbb${to.slice(2).toLowerCase().padStart(64, '0')}${BigInt(amount).toString(16).padStart(64, '0')}`;
}

const txFields = (t) => [BigInt(t.chainId), BigInt(t.nonce), BigInt(t.maxPriorityFeePerGas), BigInt(t.maxFeePerGas), BigInt(t.gas), t.to, BigInt(t.value), t.data, []];
export const unsignedTxBytes = (t) => Uint8Array.from([0x02, ...rlp(txFields(t))]);
export const txSigningHash = (t) => `0x${hex(keccak_256(unsignedTxBytes(t)))}`;

// Reads what a sweep needs from the chain and builds the unsigned USDC transfer.
export async function planSweep({ rpc, fund, to, expectedAtomic, gasFallback = 65_000n }) {
  const q = async (m, p) => rpc(m, p);
  const chainId = Number(BigInt(await q('eth_chainId', [])));
  if (chainId !== BASE_SEPOLIA.chainId) throw new RefusedError(`RPC is on chain ${chainId}, not Base Sepolia (84532)`);
  const [nonceHex, ethHex, balHex, block, tipHex] = await Promise.all([
    q('eth_getTransactionCount', [fund, 'pending']),
    q('eth_getBalance', [fund, 'latest']),
    q('eth_call', [{ to: BASE_SEPOLIA.usdc, data: `0x70a08231${fund.slice(2).toLowerCase().padStart(64, '0')}` }, 'latest']),
    q('eth_getBlockByNumber', ['latest', false]),
    q('eth_maxPriorityFeePerGas', []).catch(() => '0x3b9aca0'),
  ]);
  const usdcBalance = BigInt(balHex || '0x0');
  const amount = usdcBalance > 0n ? usdcBalance : BigInt(expectedAtomic);
  const data = encodeTransfer(to, amount);
  let gas = gasFallback;
  try { gas = (BigInt(await q('eth_estimateGas', [{ from: fund, to: BASE_SEPOLIA.usdc, data }])) * 12n) / 10n; } catch { /* unfunded: estimate fails; keep the fallback */ }
  const tip = BigInt(tipHex);
  const maxFeePerGas = BigInt(block.baseFeePerGas || '0x0') * 2n + tip;
  const tx = { chainId, nonce: Number(BigInt(nonceHex)), maxPriorityFeePerGas: tip, maxFeePerGas, gas, to: BASE_SEPOLIA.usdc, value: 0n, data };
  const ethBalance = BigInt(ethHex);
  const gasBudget = gas * maxFeePerGas;
  return { tx, usdcBalance, ethBalance, gasBudget, funded: usdcBalance > 0n, enoughGas: ethBalance >= gasBudget, amount };
}

// Signs the sweep with the released key via releaseAndSign (which signs keccak256(payload)), checks
// the signature recovers to the funded address, and returns the raw transaction. The key stays
// inside @xmbl/identity; its `address` field is NOT used (it has the compressed-key bug).
export function signSweep(lweSk, seal, tx, fundAddress) {
  const payload = unsignedTxBytes(tx);
  const { signature } = releaseAndSign('evm', lweSk, seal, payload);
  const yParity = signature.v - 27;
  const r = BigInt(`0x${signature.r}`);
  const s = BigInt(`0x${signature.s}`);
  const digest = keccak_256(payload);
  const sig = new secp256k1.Signature(r, s).addRecoveryBit(yParity);
  const pub = sig.recoverPublicKey(digest).toBytes(false);
  const signer = `0x${hex(keccak_256(pub.slice(1)).slice(-20))}`;
  if (!sameAddress(signer, fundAddress)) throw new RefusedError(`SWEEP REFUSED: the signature recovers to ${signer}, not the funded address ${fundAddress}`);
  const raw = `0x02${hex(rlp([...txFields(tx), BigInt(yParity), r, s]))}`;
  return { raw, signer, hash: `0x${hex(keccak_256(Buffer.from(raw.slice(2), 'hex')))}` };
}

// ---------------------------------------------------------------- JSON-RPC and HTTP

export function makeRpc(url, fetchImpl = fetch) {
  let id = 0;
  return async (method, params = []) => {
    const res = await fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }) });
    const body = await res.json();
    if (body.error) throw new Error(`${method}: ${body.error.message}`);
    return body.result;
  };
}

export async function postJson(fetchImpl, url, body, headers = {}) {
  const res = await fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  if (!res.ok) throw new Error(`${new URL(url).pathname} answered HTTP ${res.status}: ${json?.error || text.slice(0, 200)}`);
  return json;
}

export const fmtBytes = (n) => `${n.toLocaleString('en-US')} bytes`;
