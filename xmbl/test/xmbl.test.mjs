// Tests for the XMBL sealed release scripts. Everything runs against a FAKE broker and a FAKE RPC;
// the only real crypto is local (sealKeyPair / sealSecret / openSecret / MAYO). Nothing is sent to
// handoff or to any chain. request-seal and claim-and-check exercise their send path in-process with
// an injected fake broker; no command is ever run with --live, and sweep's send path is not run.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawnSync, execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { generateKeyPairSync, verify as edVerify, createHash } from 'node:crypto';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { sealSecret, verify as mayoVerify } from '@xmbl/identity';
import * as lib from '../lib.mjs';
import { requestSeal } from '../request-seal.mjs';
import { claimAndCheck } from '../claim-and-check.mjs';
import { sweep } from '../sweep.mjs';

const XMBL = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = path.join(XMBL, `.tmp-test-${process.pid}`);
const PAYER = '0x5D51FBfeDF7669bf39e68EEe3644a6DD8f2A5A3c';
const WORKER_WALLET = '0x1111111111111111111111111111111111111111';
const hex = (u8) => Buffer.from(u8).toString('hex');

// ---- a fake broker: the same routes and shapes the xmbl agent described, in memory
function fakeBroker({ agentPub, buggyAddress = false } = {}) {
  const claims = new Map();
  const seen = { seal: [], claim: [] };
  const respond = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const broker = {
    seen,
    lastKey: null,
    async fetch(url, init) {
      const p = new URL(url).pathname;
      if (p.endsWith('/xmbl/settlement/seal')) {
        const h = init.headers;
        const { stmt } = lib.signingStatement(h['x-agent-id'], 'POST', url, h['x-timestamp'], init.body);
        if (!edVerify(null, Buffer.from(stmt), agentPub, Buffer.from(h['x-signature'], 'base64'))) return respond(401, { error: 'authenticate as an agent' });
        const body = JSON.parse(init.body);
        seen.seal.push({ headers: h, body });
        if (Object.keys(body).some((k) => /private/i.test(k))) return respond(400, { error: 'no' });
        const pk = { A: body.receiver_lwe_pk.A.map((r) => r.map(BigInt)), b: body.receiver_lwe_pk.b.map(BigInt), n: body.receiver_lwe_pk.n, q: BigInt(body.receiver_lwe_pk.q) };
        const key = secp256k1.utils.randomSecretKey();
        broker.lastKey = Buffer.from(key);
        const address = buggyAddress ? lib.buggyCompressedAddress(key) : lib.evmAddressFromKey(key);
        const seal = sealSecret(pk, Buffer.from(key), { receiver: body.receiver_address, meta: { settlement_id: body.settlement_id, chain: body.evm_chain, address } });
        const claimId = `clm_${Math.random().toString(16).slice(2, 10)}`;
        claims.set(body.settlement_id, { claimId, receiver: body.receiver_address, seal });
        return respond(200, { claim_id: claimId, fund_here: { address, chain: body.evm_chain, asset: 'USDC', amount: body.amount_usdc }, seal, type6_xid: 'type6_fake', submitted: false });
      }
      if (p.endsWith('/xmbl/settlement/claim')) {
        const body = JSON.parse(init.body);
        seen.claim.push(body);
        const c = claims.get(body.settlement_id);
        if (!c) return respond(404, { error: 'no claim for this settlement' });
        const derived = `xmb${createHash('sha256').update(Buffer.from(body.proof.pub, 'base64')).digest('hex').slice(0, 40)}`;
        if (derived !== body.claimant_address || c.receiver !== derived) return respond(403, { error: 'claimant does not match' });
        if (!(await mayoVerify(c.claimId, body.proof.sig, body.proof.pub))) return respond(403, { error: 'bad proof' });
        return respond(200, { seal: c.seal });
      }
      return respond(404, { error: 'not found' });
    },
  };
  return broker;
}

// ---- a fake Base Sepolia JSON-RPC
function fakeRpcHandler({ usdc = 0n, eth = 0n } = {}) {
  return async (method, params) => {
    switch (method) {
      case 'eth_chainId': return '0x14a34';
      case 'eth_getTransactionCount': return '0x0';
      case 'eth_getBalance': return `0x${eth.toString(16)}`;
      case 'eth_call': return `0x${usdc.toString(16).padStart(64, '0')}`;
      case 'eth_getBlockByNumber': return { number: '0x100', baseFeePerGas: '0xf4240', timestamp: '0x66000000' };
      case 'eth_maxPriorityFeePerGas': return '0x186a0';
      case 'eth_estimateGas': if (usdc === 0n) throw new Error('execution reverted'); return '0xc350';
      case 'eth_sendRawTransaction': throw new Error('the fake RPC never sends');
      default: throw new Error(`fake rpc: ${method}`);
    }
  };
}

let worker; let agent; let agentPub; let handoffHome;
before(async () => {
  fs.mkdirSync(TMP, { recursive: true });
  worker = await lib.makeWorkerKeys(path.join(TMP, 'worker'));
  const kp = generateKeyPairSync('ed25519');
  agentPub = kp.publicKey;
  agent = { id: 'test-requester', priv: kp.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64') };
  handoffHome = path.join(TMP, 'handoff');
  fs.mkdirSync(path.join(handoffHome, 'agents', agent.id), { recursive: true });
  fs.writeFileSync(path.join(handoffHome, 'agents', agent.id, 'config.json'), JSON.stringify({ agent_id: agent.id, sig_privkey: agent.priv }));
  process.env.HANDOFF_HOME = handoffHome;
});
after(() => {
  delete process.env.HANDOFF_HOME;
  fs.rmSync(TMP, { recursive: true, force: true });
});

const sealArgs = (extra = []) => ['--as', agent.id, '--settlement', 'stl_1', '--payer', PAYER, '--receiver-xmb', worker.xmb, '--pk', worker.pkFile, '--amount', '0.05', ...extra];
async function sealVia(broker, extra = []) {
  const logs = [];
  const out = path.join(TMP, `seal-${Math.random().toString(16).slice(2)}.json`);
  const code = await requestSeal({ argv: sealArgs(['--live', '--out', out, ...extra]), fetchImpl: broker.fetch, log: (l) => logs.push(l) });
  return { code, logs, out, resp: code === 0 ? JSON.parse(fs.readFileSync(out, 'utf8')) : null };
}

describe('worker keys', () => {
  test('a fresh n = 729 seal key pair and MAYO identity; secrets are 0600, the pk is ~2.5 MB', () => {
    assert.match(worker.xmb, lib.XMB_RE);
    assert.equal(worker.n, 729);
    assert.ok(worker.pkBytes > 2_000_000 && worker.pkBytes < 4_000_000, `pk ${worker.pkBytes} bytes, under the broker's 4 MB limit`);
    for (const f of ['lwe.sk', 'mayo.sk']) assert.equal(fs.statSync(path.join(TMP, 'worker', f)).mode & 0o777, 0o600);
    assert.throws(() => lib.parseLwePk(JSON.stringify({ A: [], b: [], n: 27, q: 3329 })), /n = 729/);
  });
  test('a key folder is never reused', async () => {
    await assert.rejects(lib.makeWorkerKeys(path.join(TMP, 'worker')), /already exists/);
  });
});

describe('the whole flow against a fake broker', () => {
  test('seal, claim, open: the released key controls fund_here.address (real sealKeyPair/openSecret round-trip)', async () => {
    const broker = fakeBroker({ agentPub });
    const s = await sealVia(broker);
    assert.equal(s.code, 0, s.logs.join('\n'));
    assert.equal(s.resp.submitted, false);
    const logs = [];
    const code = await claimAndCheck({ argv: ['--settlement', 'stl_1', '--claim', s.resp.claim_id, '--seal-response', s.out, '--keys', path.join(TMP, 'worker'), '--live', '--save-seal', path.join(TMP, 'claimed.seal.json')], fetchImpl: broker.fetch, log: (l) => logs.push(l) });
    assert.equal(code, 0, logs.join('\n'));
    assert.ok(logs.some((l) => l.startsWith('ADDRESS CHECK OK')));
    const line = logs.find((l) => l.startsWith('xmbl-check OK'));
    assert.equal(line, `xmbl-check OK settlement=stl_1 claim=${s.resp.claim_id} fund=${s.resp.fund_here.address.toLowerCase()} receiver=${worker.xmb}`);
    assert.equal(broker.seen.claim[0].claimant_address, worker.xmb);
    const k = lib.loadWorkerKeys(path.join(TMP, 'worker'));
    assert.equal(lib.checkReleasedAddress(k.lweSk, s.resp.seal, s.resp.fund_here.address).ok, true);
  });

  test('a fund address no key controls (the sealChainKey bug) is caught: FUNDING UNSAFE, non-zero exit', async () => {
    const broker = fakeBroker({ agentPub, buggyAddress: true });
    const s = await sealVia(broker);
    const logs = [];
    const code = await claimAndCheck({ argv: ['--settlement', 'stl_1', '--claim', s.resp.claim_id, '--seal-response', s.out, '--keys', path.join(TMP, 'worker')], log: (l) => logs.push(l) });
    assert.equal(code, 3);
    assert.ok(logs.some((l) => l.startsWith('FUNDING UNSAFE')), logs.join('\n'));
    assert.ok(!logs.some((l) => l.startsWith('xmbl-check OK')));
    const k = lib.loadWorkerKeys(path.join(TMP, 'worker'));
    const r = lib.checkReleasedAddress(k.lweSk, s.resp.seal, s.resp.fund_here.address);
    assert.equal(r.ok, false);
    assert.equal(r.derived, lib.evmAddressFromKey(broker.lastKey));
    assert.notEqual(r.derived, lib.buggyCompressedAddress(broker.lastKey));
  });

  test('a seal for someone else, or a claim id that does not match, is refused', async () => {
    const other = await lib.makeWorkerKeys(path.join(TMP, 'other'));
    const broker = fakeBroker({ agentPub });
    const logs = [];
    const out = path.join(TMP, 'other-seal.json');
    await requestSeal({ argv: ['--as', agent.id, '--settlement', 'stl_2', '--payer', PAYER, '--receiver-xmb', other.xmb, '--pk', other.pkFile, '--amount', '0.05', '--live', '--out', out], fetchImpl: broker.fetch, log: () => {} });
    const resp = JSON.parse(fs.readFileSync(out, 'utf8'));
    assert.equal(await claimAndCheck({ argv: ['--settlement', 'stl_2', '--claim', resp.claim_id, '--seal-response', out, '--keys', path.join(TMP, 'worker')], log: (l) => logs.push(l) }), 3);
    assert.ok(logs.some((l) => /addressed to xmb/.test(l)));
    assert.equal(await claimAndCheck({ argv: ['--settlement', 'stl_2', '--claim', 'clm_other', '--seal-response', out, '--keys', path.join(TMP, 'other')], log: () => {} }), 3);
  });

  test('request-seal signs with the handoff agent scheme and sends no private key', async () => {
    const broker = fakeBroker({ agentPub });
    const s = await sealVia(broker);
    const { headers, body } = broker.seen.seal[0];
    assert.equal(headers['x-agent-id'], agent.id);
    assert.match(headers['x-timestamp'], /^\d{13}$/);
    const { stmt } = lib.signingStatement(agent.id, 'POST', 'https://handoff.lol/api/v1/xmbl/settlement/seal', headers['x-timestamp'], JSON.stringify(body));
    assert.ok(stmt.startsWith(`handoff-signed-req\n${agent.id}\nPOST\n/api/v1/xmbl/settlement/seal\n`));
    assert.ok(edVerify(null, Buffer.from(stmt), agentPub, Buffer.from(headers['x-signature'], 'base64')));
    assert.deepEqual(Object.keys(body).sort(), ['amount_usdc', 'evm_chain', 'payer_address', 'receiver_address', 'receiver_lwe_pk', 'settlement_id']);
    assert.equal(body.receiver_lwe_pk.n, 729);
    assert.equal(body.evm_chain, 'base-sepolia');
    assert.equal(s.code, 0);
  });
});

describe('evm_private_key is refused', () => {
  test('as an argument, in any spelling', async () => {
    for (const a of ['--evm_private_key', '--evm-private-key=0xabc', '--EVM_PRIVATE_KEY']) {
      assert.throws(() => lib.parseArgs([a, '0x' + '11'.repeat(32)]), /never takes or sends evm_private_key/);
    }
    await assert.rejects(requestSeal({ argv: sealArgs(['--evm_private_key', '0x' + '11'.repeat(32)]), fetchImpl: () => assert.fail('must not send'), log: () => {} }), /evm_private_key/);
  });
  test('from the command line: exit 2 and nothing sent', () => {
    const r = spawnSync(process.execPath, [path.join(XMBL, 'request-seal.mjs'), ...sealArgs(['--evm_private_key', '0x' + '11'.repeat(32)])], { encoding: 'utf8', env: { ...process.env, HANDOFF_HOME: handoffHome } });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /never takes or sends evm_private_key/);
  });
  test('in a request body or a broker response', () => {
    assert.throws(() => lib.assertNoPrivateKeyField({ a: { evm_private_key: 'x' } }), /evm_private_key/);
    const bad = lib.checkSealResponse({ claim_id: 'c', fund_here: { address: PAYER, amount: '0.05' }, seal: { alg: 'xmbl-seal-v1', n: 729, receiver: worker.xmb }, evm_private_key: '0x' });
    assert.equal(bad.ok, false);
    assert.match(bad.errors.join(), /evm_private_key/);
  });
  test('mainnet and other chains are refused (testnet only)', async () => {
    assert.throws(() => lib.buildSealBody({ settlement: 's', payer: PAYER, receiverXmb: worker.xmb, pkJson: fs.readFileSync(worker.pkFile, 'utf8'), amount: '0.05', chain: 'base' }), /testnet only/);
    await assert.rejects(requestSeal({ argv: sealArgs(['--api', 'https://mainnet.handoff.lol/api/v1']), log: () => {} }), /testnet only/);
    assert.match(lib.checkSealResponse({ claim_id: 'c', fund_here: { address: PAYER, amount: '0.05', chain: 'base' }, seal: { alg: 'xmbl-seal-v1', n: 729, receiver: worker.xmb } }).errors.join(), /not base-sepolia/);
  });
});

describe('the key never reaches stdout', () => {
  let rpcServer; let rpcUrl; let sealFile; let key;
  before(async () => {
    const broker = fakeBroker({ agentPub });
    const s = await sealVia(broker);
    sealFile = s.out;
    key = broker.lastKey;
    const handle = fakeRpcHandler({ usdc: 50000n, eth: 20_000_000_000_000n });
    rpcServer = http.createServer((req, res) => {
      let b = '';
      req.on('data', (c) => { b += c; });
      req.on('end', async () => {
        const { id, method, params } = JSON.parse(b);
        try { res.end(JSON.stringify({ jsonrpc: '2.0', id, result: await handle(method, params) })); } catch (e) { res.end(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32000, message: e.message } })); }
      });
    });
    await new Promise((r) => rpcServer.listen(0, '127.0.0.1', r));
    rpcUrl = `http://127.0.0.1:${rpcServer.address().port}`;
  });
  after(() => rpcServer.close());

  const secretsIn = (text) => {
    const k = lib.loadWorkerKeys(path.join(TMP, 'worker'));
    const found = [];
    for (const [name, v] of [['key hex', hex(key)], ['key hex upper', hex(key).toUpperCase()], ['key base64', key.toString('base64')], ['MAYO secret', k.mayo.privateKey], ['LWE secret', JSON.stringify(k.lweSk.s.slice(0, 40).map(Number))]]) {
      if (text.includes(v)) found.push(name);
    }
    return found;
  };
  // Async, so the fake RPC server in this process can answer the child.
  const run = (script, args) => new Promise((resolve) => {
    execFile(process.execPath, [path.join(XMBL, script), ...args], { encoding: 'utf8', env: { ...process.env, HANDOFF_HOME: handoffHome } }, (err, stdout, stderr) => {
      resolve({ status: err ? err.code : 0, stdout, stderr, all: `${stdout}\n${stderr}` });
    });
  });

  test('worker-keys prints the xmb address and pk path only', async () => {
    const dir = path.join(TMP, 'w-print');
    const r = await run('worker-keys.mjs', ['--out', dir]);
    assert.equal(r.status, 0, r.all);
    const mayo = JSON.parse(fs.readFileSync(path.join(dir, 'mayo.sk'), 'utf8'));
    assert.ok(!r.all.includes(mayo.privateKey));
    assert.ok(!r.all.includes(fs.readFileSync(path.join(dir, 'lwe.sk'), 'utf8').slice(5, 60)));
    assert.match(r.stdout, new RegExp(`xmb address: ${mayo.address}`));
  });
  test('request-seal dry run: the request without signature, key or pk body', async () => {
    const r = await run('request-seal.mjs', sealArgs());
    assert.equal(r.status, 0, r.all);
    assert.match(r.stdout, /^DRY RUN: nothing sent/m);
    assert.match(r.stdout, /POST https:\/\/handoff\.lol\/api\/v1\/xmbl\/settlement\/seal/);
    assert.match(r.stdout, /x-signature: <redacted/);
    assert.ok(!r.all.includes(agent.priv));
    assert.ok(r.all.length < 20_000, 'the 2.5 MB pk is not printed');
  });
  test('claim-and-check dry run opens the seal and prints the check line, not the key', async () => {
    const resp = JSON.parse(fs.readFileSync(sealFile, 'utf8'));
    const r = await run('claim-and-check.mjs', ['--settlement', 'stl_1', '--claim', resp.claim_id, '--seal-response', sealFile, '--keys', path.join(TMP, 'worker')]);
    assert.equal(r.status, 0, r.all);
    assert.match(r.stdout, /ADDRESS CHECK OK/);
    assert.deepEqual(secretsIn(r.all), []);
  });
  test('sweep dry run prints the unsigned transaction, not the key', async () => {
    const r = await run('sweep.mjs', ['--settlement', 'stl_1', '--seal-response', sealFile, '--keys', path.join(TMP, 'worker'), '--to', WORKER_WALLET, '--rpc', rpcUrl]);
    assert.equal(r.status, 0, r.all);
    assert.match(r.stdout, /DRY RUN: nothing signed or sent/);
    assert.match(r.stdout, /"to": "0x036CbD53842c5426634e7929541eC2318f3dCF7e"/);
    assert.ok(r.stdout.includes(lib.encodeTransfer(WORKER_WALLET, 50000n)));
    assert.deepEqual(secretsIn(r.all), []);
  });
});

describe('sweep transaction', () => {
  test('RLP matches the standard vectors', () => {
    const h = (v) => hex(lib.rlp(v));
    assert.equal(h('dog'), '83646f67');
    assert.equal(h(['cat', 'dog']), 'c88363617483646f67');
    assert.equal(h(0n), '80');
    assert.equal(h(15n), '0f');
    assert.equal(h(1024n), '820400');
    assert.equal(h([]), 'c0');
    assert.equal(h('Lorem ipsum dolor sit amet, consectetur adipisicing elit'), `b838${Buffer.from('Lorem ipsum dolor sit amet, consectetur adipisicing elit').toString('hex')}`);
    assert.equal(h([[], [[]], [[], [[]]]]), 'c7c0c1c0c3c0c1c0');
  });
  test('the signed sweep recovers to the funded address and pays the worker', async () => {
    const broker = fakeBroker({ agentPub });
    const s = await sealVia(broker);
    const k = lib.loadWorkerKeys(path.join(TMP, 'worker'));
    const plan = await lib.planSweep({ rpc: fakeRpcHandler({ usdc: 50000n, eth: 20_000_000_000_000n }), fund: s.resp.fund_here.address, to: WORKER_WALLET, expectedAtomic: 50000n });
    assert.equal(plan.funded, true);
    assert.equal(plan.enoughGas, true);
    assert.equal(plan.tx.data, lib.encodeTransfer(WORKER_WALLET, 50000n));
    const signed = lib.signSweep(k.lweSk, s.resp.seal, plan.tx, s.resp.fund_here.address);
    assert.ok(signed.raw.startsWith('0x02'));
    assert.ok(lib.sameAddress(signed.signer, s.resp.fund_here.address));
    // Independent recovery from the raw bytes' signing hash.
    const digest = keccak_256(lib.unsignedTxBytes(plan.tx));
    assert.equal(`0x${hex(digest)}`, lib.txSigningHash(plan.tx));
  });
  test('an unfunded address: the dry run shows the expected amount and the plan is marked unfunded', async () => {
    const broker = fakeBroker({ agentPub });
    const s = await sealVia(broker);
    const logs = [];
    const code = await sweep({ argv: ['--settlement', 'stl_1', '--seal-response', s.out, '--keys', path.join(TMP, 'worker'), '--to', WORKER_WALLET], rpc: fakeRpcHandler(), log: (l) => logs.push(l) });
    assert.equal(code, 0);
    assert.ok(logs.some((l) => /not funded yet/.test(l)));
    const plan = await lib.planSweep({ rpc: fakeRpcHandler(), fund: s.resp.fund_here.address, to: WORKER_WALLET, expectedAtomic: 50000n });
    assert.equal(plan.funded, false); // sweep --live refuses an unfunded plan before signing
    assert.equal(plan.enoughGas, false);
  });
});

describe('handoff agent signing key lookup', () => {
  test('agents/<id>/config.json first; files elsewhere must name the agent', () => {
    const root = path.join(TMP, 'lookup');
    const w = (p, o) => { fs.mkdirSync(path.dirname(path.join(root, p)), { recursive: true }); fs.writeFileSync(path.join(root, p), JSON.stringify(o)); };
    w('keys/default/other.json', { agent_id: 'someone-else', sig_privkey: 'AAAA' });
    w('keys/default/unnamed.json', { sig_privkey: 'BBBB' });
    assert.equal(lib.findAgentSigKey('me', root), null);
    w('keys/claude/me.json', { agent_id: 'me', sig_privkey: 'CCCC' });
    assert.deepEqual(lib.findAgentSigKey('me', root), { priv: 'CCCC', where: 'keys/claude/me.json' });
    w('agents/me/config.json', { sig: { priv: 'DDDD' } });
    assert.deepEqual(lib.findAgentSigKey('me', root), { priv: 'DDDD', where: 'agents/me/config.json' });
  });
});
