import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  TRANSFER_TOPIC,
  toAtomic,
  formatAtomic,
  encodeTransfer,
  decodeTransferLog,
  padTopicAddress,
  matchPayments,
  checkCap,
  chunkRanges,
  parseRangeLimit,
  pickRail,
  railsFrom,
  explorerTxUrl,
  actorId,
  taskVerification,
  readPayment,
  receiptIndex,
  buildRows,
  rowStatus,
  proofText,
} from '../lib.js';

const WORKER = '0x1fa853271f619F98A4777A5BFac8b01E256b572d';
const OTHER = '0x5c34f9309A36Ac9B92763F7137D36E006f2318Fa';
const PAYER = '0x5D51FBfeDF7669bf39e68EEe3644a6DD8f2A5A3c';

describe('calldata', () => {
  test('transfer(0x1fa8…572d, 0.05 USDC) matches a hand-built vector', () => {
    // selector a9059cbb = first 4 bytes of keccak256("transfer(address,uint256)")
    // arg 1: address left-padded to 32 bytes; arg 2: 50000 = 0xc350 left-padded to 32 bytes
    const expected = '0xa9059cbb'
      + '000000000000000000000000' + '1fa853271f619f98a4777a5bfac8b01e256b572d'
      + '000000000000000000000000000000000000000000000000000000000000c350';
    const got = encodeTransfer(WORKER, 50000n);
    assert.equal(got, expected);
    assert.equal(got.length, 2 + 8 + 64 + 64);
  });

  test('1 USDC (1_000_000 = 0xf4240) to a second address', () => {
    const expected = '0xa9059cbb'
      + '0000000000000000000000005c34f9309a36ac9b92763f7137d36e006f2318fa'
      + '00000000000000000000000000000000000000000000000000000000000f4240';
    assert.equal(encodeTransfer(OTHER, 1_000_000n), expected);
  });

  test('refuses bad recipients and amounts', () => {
    assert.throws(() => encodeTransfer('0x1234', 1n));
    assert.throws(() => encodeTransfer(WORKER, 0n));
    assert.throws(() => encodeTransfer(WORKER, -5n));
    assert.throws(() => encodeTransfer(WORKER, 5));
  });
});

describe('atomic units (6 decimals)', () => {
  test('0.05 as string and as number', () => {
    assert.equal(toAtomic('0.05', 6), 50000n);
    assert.equal(toAtomic(0.05, 6), 50000n);
  });
  test('whole, tiny, padded and exponent forms', () => {
    assert.equal(toAtomic('1', 6), 1_000_000n);
    assert.equal(toAtomic('2.1', 6), 2_100_000n);
    assert.equal(toAtomic('0.000001', 6), 1n);
    assert.equal(toAtomic(1e-6, 6), 1n);
    assert.equal(toAtomic('0.050000', 6), 50000n);
    assert.equal(toAtomic('0.50', 6), 500000n);
    assert.equal(toAtomic('0', 6), 0n);
    assert.equal(toAtomic('.5', 6), 500000n);
    assert.equal(toAtomic('5e-2', 6), 50000n);
    assert.equal(toAtomic(0.3, 6), 300000n);
  });
  test('refuses precision the token cannot hold, negatives and junk', () => {
    assert.throws(() => toAtomic('0.0000001', 6));
    assert.throws(() => toAtomic(1e-7, 6));
    assert.throws(() => toAtomic('-1', 6));
    assert.throws(() => toAtomic('abc', 6));
    assert.throws(() => toAtomic('', 6));
    assert.throws(() => toAtomic('.', 6));
    assert.throws(() => toAtomic(NaN, 6));
    assert.throws(() => toAtomic(null, 6));
  });
  test('format back', () => {
    assert.equal(formatAtomic(50000n, 6), '0.05');
    assert.equal(formatAtomic(500000n, 6), '0.50');
    assert.equal(formatAtomic(1n, 6), '0.000001');
    assert.equal(formatAtomic(2_100_000n, 6), '2.10');
    assert.equal(formatAtomic(0n, 6), '0.00');
  });
});

describe('Transfer log decoding', () => {
  test('decodes a hand-built log', () => {
    const log = {
      topics: [TRANSFER_TOPIC, padTopicAddress(PAYER), padTopicAddress(WORKER)],
      data: '0x' + (50000).toString(16).padStart(64, '0'),
      blockNumber: '0x10',
      logIndex: '0x2',
      transactionHash: '0x' + 'ab'.repeat(32),
      blockTimestamp: '0x66000000',
    };
    const d = decodeTransferLog(log);
    assert.equal(d.from, PAYER.toLowerCase());
    assert.equal(d.to, WORKER.toLowerCase());
    assert.equal(d.amount, 50000n);
    assert.equal(d.blockNumber, 16);
    assert.equal(d.logIndex, 2);
    assert.equal(d.timestamp, 0x66000000);
  });
  test('ignores other events and removed logs', () => {
    assert.equal(decodeTransferLog({ topics: ['0x' + '11'.repeat(32)], data: '0x' }), null);
    assert.equal(decodeTransferLog({ removed: true, topics: [TRANSFER_TOPIC, padTopicAddress(PAYER), padTopicAddress(WORKER)], data: '0x' + '0'.repeat(64) }), null);
  });
});

describe('matching tasks to transfers', () => {
  const T0 = Date.parse('2026-09-01T00:00:00Z');
  const sec = (ms) => Math.floor(ms / 1000);
  const task = (id, verifiedAt, amount = 50000n, wallet = WORKER) => ({ id, wallet, amount, verifiedAt });
  const xfer = (n, atMs, amount = 50000n, to = WORKER) => ({
    to: to.toLowerCase(), amount, timestamp: sec(atMs), blockNumber: n, logIndex: 0, txHash: '0x' + n.toString(16).padStart(64, '0'),
  });

  test('one transfer cannot pay two tasks', () => {
    const m = matchPayments([task('a', T0), task('b', T0 + 1000)], [xfer(10, T0 + 60_000)]);
    assert.equal(m.size, 1);
    assert.equal(m.get('a').blockNumber, 10);
    assert.equal(m.has('b'), false);
  });

  test('a transfer mined before verification does not count', () => {
    const m = matchPayments([task('a', T0)], [xfer(5, T0 - 60_000)]);
    assert.equal(m.size, 0);
  });

  test('a short amount does not count', () => {
    const m = matchPayments([task('a', T0, 50000n)], [xfer(10, T0 + 60_000, 49999n)]);
    assert.equal(m.size, 0);
    const over = matchPayments([task('a', T0, 50000n)], [xfer(10, T0 + 60_000, 60000n)]);
    assert.equal(over.size, 1);
  });

  test('a transfer to another wallet does not count', () => {
    const m = matchPayments([task('a', T0)], [xfer(10, T0 + 60_000, 50000n, OTHER)]);
    assert.equal(m.size, 0);
  });

  test('oldest task takes the oldest transfer that fits', () => {
    const m = matchPayments(
      [task('newer', T0 + 10_000), task('older', T0)],
      [xfer(30, T0 + 90_000), xfer(20, T0 + 60_000)],
    );
    assert.equal(m.get('older').blockNumber, 20);
    assert.equal(m.get('newer').blockNumber, 30);
  });

  test('a transfer between two verifications only pays the earlier task', () => {
    const m = matchPayments(
      [task('a', T0), task('b', T0 + 120_000)],
      [xfer(20, T0 + 60_000), xfer(30, T0 + 180_000)],
    );
    assert.equal(m.get('a').blockNumber, 20);
    assert.equal(m.get('b').blockNumber, 30);
    const onlyEarly = matchPayments([task('a', T0 + 120_000)], [xfer(20, T0 + 60_000)]);
    assert.equal(onlyEarly.size, 0);
  });

  test('the same log seen twice is still one transfer', () => {
    const x = xfer(10, T0 + 60_000);
    const m = matchPayments([task('a', T0), task('b', T0)], [x, { ...x }]);
    assert.equal(m.size, 1);
  });
});

describe('spending cap', () => {
  const cap = 500000n; // 0.50 USDC
  test('refuses a payment that would exceed the cap', () => {
    const r = checkCap({ cap, spent: 460000n, amount: 50000n });
    assert.equal(r.ok, false);
    assert.match(r.reason, /over the 0\.50 USDC cap/);
  });
  test('allows a payment that lands exactly on the cap', () => {
    const r = checkCap({ cap, spent: 450000n, amount: 50000n });
    assert.equal(r.ok, true);
    assert.equal(r.remaining, 0n);
  });
  test('a single payment above the cap is refused from zero', () => {
    assert.equal(checkCap({ cap, spent: 0n, amount: 500001n }).ok, false);
  });
  test('no cap means no limit, but zero is never payable', () => {
    assert.equal(checkCap({ cap: null, spent: 10n ** 12n, amount: 1n }).ok, true);
    assert.equal(checkCap({ cap, spent: 0n, amount: 0n }).ok, false);
  });
});

describe('scan helpers', () => {
  test('chunks cover the range exactly', () => {
    assert.deepEqual(chunkRanges(1, 2500, 1000), [[1, 1000], [1001, 2000], [2001, 2500]]);
    assert.deepEqual(chunkRanges(1, 2500, 1000, true), [[1501, 2500], [501, 1500], [1, 500]]);
    assert.deepEqual(chunkRanges(5, 4, 1000), []);
  });
  test('reads RPC range limits from error text', () => {
    assert.equal(parseRangeLimit('eth_getLogs is limited to a 1,000 range'), 1000);
    assert.equal(parseRangeLimit('You can make eth_getLogs requests with up to a 2K block range'), 2000);
    assert.equal(parseRangeLimit('exceed maximum block range: 50000'), 50000);
    assert.equal(parseRangeLimit('rate limit exceeded'), null);
  });
});

describe('settlement rail', () => {
  const testnet = {
    success: true,
    defaultNetwork: 'base-sepolia',
    networks: [
      { name: 'arc-testnet', label: 'Arc Testnet', chainId: 5042002, usdc: '0x3600000000000000000000000000000000000000', decimals: 6, rpcUrl: 'https://rpc.testnet.arc.network', explorer: 'https://testnet.arcscan.app/tx/' },
      { name: 'base-sepolia', label: 'Base Sepolia', chainId: 84532, usdc: '0x036CbD53842c5426634e7929541eC2318f3dCF7e', decimals: 6, rpcUrl: 'https://sepolia.base.org', explorer: 'https://sepolia.basescan.org/tx/' },
    ],
  };
  test('defaults to defaultNetwork and honours a named pick', () => {
    assert.equal(pickRail(testnet).chainId, 84532);
    assert.equal(pickRail(testnet, 'arc-testnet').chainId, 5042002);
    assert.equal(railsFrom(testnet).length, 2);
  });
  test('accepts a flat config too', () => {
    const r = pickRail({ chainId: 8453, usdc: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', rpcUrl: 'https://mainnet.base.org', explorer: 'https://basescan.org/tx/', decimals: 6 });
    assert.equal(r.chainId, 8453);
  });
  test('explorer links', () => {
    const tx = '0x' + 'cd'.repeat(32);
    assert.equal(explorerTxUrl('https://basescan.org/tx/', tx), `https://basescan.org/tx/${tx}`);
    assert.equal(explorerTxUrl('https://basescan.org/tx/', 'nope'), null);
  });
});

describe('task rows', () => {
  const rail = pickRail({ defaultNetwork: 'base-sepolia', networks: [{ name: 'base-sepolia', label: 'Base Sepolia', chainId: 84532, usdc: '0x036CbD53842c5426634e7929541eC2318f3dCF7e', decimals: 6, rpcUrl: 'https://sepolia.base.org', explorer: 'https://sepolia.basescan.org/tx/' }] });
  const request = { id: 'p1', requester: 'boss', title: 'Project' };
  const hist = (by, at = '2026-09-01T00:00:00.000Z') => [{ status: 'todo', at: '2026-08-31T00:00:00.000Z' }, { status: 'verified', at, by }];
  const agents = new Map([
    ['w1', { ok: true, agent: { agent_id: 'w1', wallet_address: WORKER } }],
    ['nowallet', { ok: true, agent: { agent_id: 'nowallet', wallet_address: null } }],
    ['ghost', { ok: false, notFound: true }],
  ]);
  const base = { status: 'verified', assignee: 'w1', payment: { amount: '0.05', currency: 'USDC' } };
  const rows = (tasks, receipts = new Map()) => buildRows({ request, tasks, agents, receipts, rail });

  test('actor ids strip prose', () => {
    assert.equal(actorId('handoff-advisor (independent) — checked it'), 'handoff-advisor');
    assert.equal(actorId('incident-recovery (rep-ledger proof)'), 'incident-recovery');
    assert.equal(actorId(null), null);
  });

  test('"requester" resolves to the project requester and uses the last verification', () => {
    const v = taskVerification({ status_history: [...hist('x', '2026-09-01T00:00:00Z'), { status: 'verified', at: '2026-09-02T00:00:00Z', by: 'requester' }] }, 'boss');
    assert.equal(v.verifier, 'boss');
    assert.equal(v.viaRequester, true);
    assert.equal(v.verifiedAt, Date.parse('2026-09-02T00:00:00Z'));
  });

  test('a clean task is payable; non-verified tasks are skipped', () => {
    const r = rows([{ ...base, id: 't1', title: 'ok', status_history: hist('requester') }, { ...base, id: 't2', status: 'todo', status_history: [] }]);
    assert.equal(r.length, 1);
    assert.equal(r[0].payable, true);
    assert.equal(r[0].amountAtomic, 50000n);
    assert.equal(r[0].verifier, 'boss');
  });

  test('flags self-verification, missing wallets and unknown workers', () => {
    const r = rows([
      { ...base, id: 'self', verified_by: 'w1', status_history: hist('w1') },
      { ...base, id: 'nw', assignee: 'nowallet', status_history: hist('boss') },
      { ...base, id: 'gh', assignee: 'ghost', status_history: hist('boss') },
      { ...base, id: 'na', assignee: undefined, status_history: hist('boss') },
      { ...base, id: 'ss', self_signed_by: 'w1', co_signed_by: null, status_history: hist('orchestrator') },
    ]);
    const by = Object.fromEntries(r.map((x) => [x.id, x]));
    assert.match(by.self.blocks.join(), /verified by the worker itself/);
    assert.match(by.nw.blocks.join(), /no wallet/);
    assert.match(by.gh.blocks.join(), /not a registered agent/);
    assert.match(by.na.blocks.join(), /no worker/);
    assert.match(by.ss.blocks.join(), /self-signed/);
    assert.ok(r.every((x) => !x.payable));
  });

  test('refuses unitless amounts, other networks and a different payee', () => {
    const r = rows([
      { ...base, id: 'bare', payment: '80', status_history: hist('boss') },
      { ...base, id: 'net', payment: { amount: '0.01', currency: 'USDC', network: 'arc-testnet' }, status_history: hist('boss') },
      { ...base, id: 'payto', payment: { amount: '0.01', currency: 'USDC', pay_to: OTHER }, status_history: hist('boss') },
      { ...base, id: 'zero', payment: { amount: '0', currency: 'USDC' }, status_history: hist('boss') },
    ]);
    const by = Object.fromEntries(r.map((x) => [x.id, x]));
    assert.match(by.bare.blocks.join(), /no currency or units/);
    assert.match(by.net.blocks.join(), /arc-testnet/);
    assert.match(by.payto.blocks.join(), /not the worker's wallet/);
    assert.equal(by.zero.noPaymentDue, true);
    assert.equal(rowStatus(by.zero, null).kind, 'none');
    assert.ok(r.every((x) => !x.payable));
    assert.equal(readPayment({ payment: { amount: 1e-6, currency: 'USDC' } }).atomic, 1n);
  });

  test('paid by handoff from a settled receipt or from the task flag', () => {
    const tx = '0x' + '12'.repeat(32);
    const receipts = receiptIndex({ receipts: [
      { id: 'r1', resource: 'task:11111111-1111-1111-1111-111111111111 (x)', status: 'settled', tx, network: 'base-sepolia', amount: '0.05' },
      { id: 'r2', resource: 'task:22222222-2222-2222-2222-222222222222 (x)', status: 'failed', tx, network: 'base-sepolia' },
    ] });
    const r = rows([
      { ...base, id: '11111111-1111-1111-1111-111111111111', status_history: hist('boss') },
      { ...base, id: '22222222-2222-2222-2222-222222222222', status_history: hist('boss') },
      { ...base, id: 'flagged', paid: true, receipt_id: 'r9', status_history: hist('boss') },
    ], receipts);
    const by = Object.fromEntries(r.map((x) => [x.id, x]));
    assert.equal(rowStatus(by['11111111-1111-1111-1111-111111111111'], null).url, `https://sepolia.basescan.org/tx/${tx}`);
    assert.equal(by['22222222-2222-2222-2222-222222222222'].handoffPaid, null);
    assert.equal(by.flagged.handoffPaid.receiptId, 'r9');
    assert.equal(rowStatus(by.flagged, null).kind, 'handoff');
  });

  test('tasks verified before the scanned range are unchecked, never unpaid', () => {
    const [row] = rows([{ ...base, id: 't', status_history: hist('boss', '2026-09-01T00:00:00Z') }]);
    const scan = { payer: PAYER, match: new Map(), coveredFromMs: Date.parse('2026-09-05T00:00:00Z') };
    assert.equal(rowStatus(row, scan).kind, 'unchecked');
    assert.equal(rowStatus(row, { ...scan, coveredFromMs: Date.parse('2026-08-01T00:00:00Z') }).kind, 'unpaid');
  });

  test('proof text lists task, worker, amount, tx and link', () => {
    const [row] = rows([{ ...base, id: 't', title: 'Build it', status_history: hist('boss') }]);
    const tx = '0x' + '34'.repeat(32);
    const scan = { payer: PAYER, coveredFromMs: 0, match: new Map([['t', { txHash: tx, amount: 50000n, to: WORKER.toLowerCase() }]]) };
    const text = proofText({ side: 'testnet', rail, project: request, payer: PAYER, rows: [row], scan, generatedAt: new Date(0) });
    assert.match(text, /task t: Build it/);
    assert.match(text, new RegExp(`worker: w1 \\(${WORKER}\\)`));
    assert.match(text, /amount: 0\.05 USDC/);
    assert.match(text, new RegExp(`tx: ${tx}`));
    assert.match(text, new RegExp(`link: https://sepolia\\.basescan\\.org/tx/${tx}`));
  });
});
