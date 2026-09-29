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
  extractProjectId,
  receiptTxSet,
  APP_RAILS,
  railsForSide,
  railMatchesNetwork,
  tokenLabel,
  combineChecks,
  scanAdaptive,
  isShrinkableLogError,
  isRateLimitError,
  toCapUnits,
  scaleAtomic,
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

describe('project ids', () => {
  test('from a bare id or a pasted link', () => {
    assert.equal(extractProjectId(' 62E63CE5-23ad-40c2-b4a1-981d5c83ffec '), '62e63ce5-23ad-40c2-b4a1-981d5c83ffec');
    assert.equal(extractProjectId('https://handoff.lol/projects/2af16779-4c0f-4c93-94b7-6a0281fc6846?tab=tasks'), '2af16779-4c0f-4c93-94b7-6a0281fc6846');
    assert.equal(extractProjectId('not an id'), null);
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
  const rows = (tasks, receipts = new Map()) => buildRows({ request, tasks, agents, receipts, payRail: rail });

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

  test("handoff's own payouts are recognised by tx hash", () => {
    const tx = '0x' + 'AB'.repeat(32);
    const set = receiptTxSet({ receipts: [{ status: 'settled', tx, resource: 'settle:x' }, { status: 'failed', tx: '0x' + '01'.repeat(32) }] });
    assert.equal(set.has(tx.toLowerCase()), true);
    assert.equal(set.size, 1);
  });

  test('tasks verified before the scanned range are unchecked, never unpaid', () => {
    const r = rows([{ ...base, id: 't', status_history: hist('boss', '2026-09-01T00:00:00Z') }]);
    const late = combineChecks({ rows: r, rails: [rail], scans: new Map([[rail.name, { transfers: [], coveredFromMs: Date.parse('2026-09-05T00:00:00Z') }]]) });
    assert.equal(rowStatus(r[0], late).kind, 'unchecked');
    const early = combineChecks({ rows: r, rails: [rail], scans: new Map([[rail.name, { transfers: [], coveredFromMs: Date.parse('2026-08-01T00:00:00Z') }]]) });
    assert.deepEqual(rowStatus(r[0], early), { kind: 'unpaid', checked: true });
    assert.deepEqual(rowStatus(r[0], null), { kind: 'unpaid', checked: false });
  });

  test('proof text lists task, worker, amount, tx and link', () => {
    const [row] = rows([{ ...base, id: 't', title: 'Build it', status_history: hist('boss') }]);
    const tx = '0x' + '34'.repeat(32);
    const check = { covered: new Set(['t']), match: new Map([['t', { txHash: tx, amount: 50000n, to: WORKER.toLowerCase(), rail: rail.name }]]) };
    const text = proofText({ side: 'testnet', rails: [rail], project: request, payer: PAYER, rows: [row], check, generatedAt: new Date(0) });
    assert.match(text, /chain: Base Sepolia \(84532\)/);
    assert.doesNotMatch(text, /paid in/);
    assert.match(text, /task t: Build it/);
    assert.match(text, new RegExp(`worker: w1 \\(${WORKER}\\)`));
    assert.match(text, /amount: 0\.05 USDC/);
    assert.match(text, new RegExp(`tx: ${tx}`));
    assert.match(text, new RegExp(`link: https://sepolia\\.basescan\\.org/tx/${tx}`));
  });
});

// ---------------------------------------------------------------- rails, adaptive scans, cross-rail checks

const MAINNET_SETTLEMENT = {
  success: true,
  defaultNetwork: 'base',
  networks: [{ name: 'base', label: 'Base (mainnet)', chainId: 8453, usdc: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', decimals: 6, assetName: 'USDC', rpcUrl: 'https://mainnet.base.org', nativeSymbol: 'ETH', explorer: 'https://basescan.org/tx/', testnet: false }],
};
const TESTNET_SETTLEMENT = {
  success: true,
  defaultNetwork: 'base-sepolia',
  networks: [
    { name: 'arc-testnet', label: 'Arc Testnet', chainId: 5042002, usdc: '0x3600000000000000000000000000000000000000', decimals: 6, rpcUrl: 'https://rpc.testnet.arc.network', explorer: 'https://testnet.arcscan.app/tx/', testnet: true },
    { name: 'base-sepolia', label: 'Base Sepolia', chainId: 84532, usdc: '0x036CbD53842c5426634e7929541eC2318f3dCF7e', decimals: 6, rpcUrl: 'https://sepolia.base.org', explorer: 'https://sepolia.basescan.org/tx/', testnet: true },
  ],
};
const USDG = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168';

describe('rail registry', () => {
  test('mainnet has handoff\'s Base rail plus the app\'s Robinhood Chain USDG rail', () => {
    const rails = railsForSide('mainnet', MAINNET_SETTLEMENT);
    assert.deepEqual(rails.map((r) => [r.name, r.chainId, r.symbol, r.source]), [['base', 8453, 'USDC', 'handoff'], ['robinhood', 4663, 'USDG', 'app']]);
    const rh = rails[1];
    assert.equal(rh.token, USDG);
    assert.equal(rh.decimals, 6);
    assert.equal(rh.rpcUrl, 'https://rpc.mainnet.chain.robinhood.com');
    assert.equal(rh.explorer, 'https://robinhoodchain.blockscout.com/tx/');
    assert.equal(rh.nativeSymbol, 'ETH');
    assert.deepEqual(rh.scan, { initial: 10_000_000, max: 10_000_000, concurrency: 1 });
    assert.deepEqual(rails[0].scan, { initial: 2000, max: 2000, concurrency: 3 });
    assert.equal(rails[0].token, '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913');
  });
  test('testnet keeps handoff\'s rails only (no Robinhood testnet rail)', () => {
    const rails = railsForSide('testnet', TESTNET_SETTLEMENT);
    assert.deepEqual(rails.map((r) => r.name), ['arc-testnet', 'base-sepolia']);
    assert.ok(rails.every((r) => r.source === 'handoff' && r.chainId !== 46630));
    assert.deepEqual(rails[1].scan, { initial: 1000, max: 1000, concurrency: 3 });
    assert.equal(APP_RAILS.some((r) => r.side === 'testnet'), false);
  });
  test('an unusable handoff config gives no rails at all, never app rails alone', () => {
    assert.throws(() => railsForSide('mainnet', { success: true, networks: [] }));
    assert.throws(() => railsForSide('mainnet', null));
  });
  test('task networks name rails by name, alias or chain id', () => {
    const [base, rh] = railsForSide('mainnet', MAINNET_SETTLEMENT);
    assert.equal(railMatchesNetwork(base, 'Base'), true);
    assert.equal(railMatchesNetwork(base, 'eip155:8453'), true);
    assert.equal(railMatchesNetwork(rh, 'robinhood'), true);
    assert.equal(railMatchesNetwork(rh, '4663'), true);
    assert.equal(railMatchesNetwork(rh, 'base'), false);
  });
});

describe('log errors and range limits', () => {
  test('result-count and span caps shrink; rate limits do not', () => {
    assert.equal(isShrinkableLogError({ code: -32000, message: 'logs matched by query exceeds limit of 10000' }), true);
    assert.equal(isShrinkableLogError({ code: -32602, message: 'query spans 20000001 blocks (55437734 to 75437734), but only 10000000 are allowed for this request; narrow the block range' }), true);
    assert.equal(isShrinkableLogError({ code: -32614, message: 'eth_getLogs is limited to a 1,000 range' }), true);
    assert.equal(isShrinkableLogError({ code: 429, message: 'Too Many Requests' }), false);
    assert.equal(isShrinkableLogError({ code: -32005, message: 'rate limit exceeded' }), false);
    assert.equal(isRateLimitError({ code: 429, message: 'Too Many Requests' }), true);
  });
  test('a span cap is read from the message; a result-count cap is not a block range', () => {
    assert.equal(parseRangeLimit('query spans 20000001 blocks (55437734 to 75437734), but only 10000000 are allowed for this request; narrow the block range'), 10_000_000);
    assert.equal(parseRangeLimit('logs matched by query exceeds limit of 10000'), null);
  });
});

describe('adaptive log scan', () => {
  // A fake RPC over blocks [0, 99999] with logs at the given block numbers.
  function fakeChain(logBlocks, { spanCap = Infinity, countCap = Infinity, calls = [] } = {}) {
    return async (lo, hi) => {
      calls.push([lo, hi]);
      const span = hi - lo + 1;
      if (span > spanCap) throw Object.assign(new Error(`query spans ${span} blocks (${lo} to ${hi}), but only ${spanCap} are allowed for this request; narrow the block range`), { code: -32602 });
      const hits = logBlocks.filter((b) => b >= lo && b <= hi);
      if (hits.length > countCap) throw Object.assign(new Error(`logs matched by query exceeds limit of ${countCap}`), { code: -32000 });
      return hits.map((b) => ({ blockNumber: b }));
    };
  }
  const sorted = (items) => items.map((x) => x.blockNumber).sort((a, b) => a - b);

  test('a span cap is learned from the error and then respected', async () => {
    const calls = [];
    const logs = [10, 1500, 2999, 4999];
    const r = await scanAdaptive({ fetchRange: fakeChain(logs, { spanCap: 1000, calls }), fromBlock: 0, toBlock: 4999, strategy: { initial: 10000, max: 10000, concurrency: 1 } });
    assert.deepEqual(sorted(r.items), logs);
    assert.equal(r.complete, true);
    assert.equal(r.low, 0);
    assert.equal(r.calls, 6); // one refused 5,000-block query, then five of 1,000
    assert.ok(calls.slice(1).every(([lo, hi]) => hi - lo + 1 <= 1000));
  });

  test('a result-count cap halves the range until the logs fit', async () => {
    const logs = [...Array(40).keys()].map((i) => 5000 + i); // a dense burst
    const r = await scanAdaptive({ fetchRange: fakeChain(logs, { countCap: 8 }), fromBlock: 0, toBlock: 99_999, strategy: { initial: 100_000, max: 100_000, concurrency: 1 } });
    assert.deepEqual(sorted(r.items), logs);
    assert.equal(r.complete, true);
    assert.ok(r.shrinks > 0);
  });

  test('the range grows back after successes, up to the rail max', async () => {
    const calls = [];
    const r = await scanAdaptive({ fetchRange: fakeChain([], { calls }), fromBlock: 0, toBlock: 9999, strategy: { initial: 100, max: 800, concurrency: 1 } });
    assert.equal(r.complete, true);
    assert.deepEqual(calls.slice(0, 7).map(([lo, hi]) => hi - lo + 1), [100, 100, 200, 200, 400, 400, 800]);
    assert.equal(r.calls, 17);
    assert.ok(calls.every(([lo, hi]) => hi - lo + 1 <= 800));
  });

  test('coverage stays contiguous: results after a failed range in the same batch are dropped and re-read once', async () => {
    const calls = [];
    const logs = [9950, 9850, 9860, 9870, 9750, 9650]; // the middle range of the first batch is too dense
    const r = await scanAdaptive({ fetchRange: fakeChain(logs, { countCap: 2, calls }), fromBlock: 9600, toBlock: 9999, strategy: { initial: 100, max: 100, concurrency: 3 } });
    assert.deepEqual(calls.slice(0, 3), [[9900, 9999], [9800, 9899], [9700, 9799]]);
    assert.ok(calls.filter(([lo, hi]) => lo <= 9750 && 9750 <= hi).length >= 2); // [9700, 9799] was read, dropped, read again
    assert.deepEqual(sorted(r.items), [...logs].sort((a, b) => a - b)); // no duplicates, nothing missing
    assert.equal(r.complete, true);
    assert.equal(r.low, 9600);
  });

  test('a call budget stops early and reports the lowest covered block', async () => {
    const r = await scanAdaptive({ fetchRange: fakeChain([]), fromBlock: 0, toBlock: 9999, strategy: { initial: 100, max: 100, concurrency: 1 }, maxCalls: 3 });
    assert.equal(r.calls, 3);
    assert.equal(r.low, 9700);
    assert.equal(r.complete, false);
  });

  test('a rate limit propagates instead of shrinking', async () => {
    let calls = 0;
    const fetchRange = async () => { calls++; throw Object.assign(new Error('Too Many Requests'), { code: 429 }); };
    await assert.rejects(scanAdaptive({ fetchRange, fromBlock: 0, toBlock: 9999, strategy: { initial: 1000, max: 1000, concurrency: 1 } }), /Too Many Requests/);
    assert.equal(calls, 1);
  });
});

describe('cross-rail payments (mainnet)', () => {
  const rails = railsForSide('mainnet', MAINNET_SETTLEMENT);
  const [base, rh] = rails;
  const T0 = Date.parse('2026-09-20T00:00:00Z');
  const s = (ms) => Math.floor(ms / 1000);
  const request = { id: 'p', requester: 'boss', title: 'P' };
  const hist = (at) => [{ status: 'verified', at: new Date(at).toISOString(), by: 'boss' }];
  const agents = new Map([
    ['w1', { ok: true, agent: { wallet_address: WORKER, wallet_custodial: false } }],
    ['cust', { ok: true, agent: { wallet_address: OTHER, wallet_custodial: true } }],
  ]);
  const task = (id, at, extra = {}) => ({ id, status: 'verified', assignee: 'w1', payment: { amount: '0.05', currency: 'USDC' }, status_history: hist(at), ...extra });
  const rowsOn = (payRail, tasks) => buildRows({ request, tasks, agents, receipts: new Map(), payRail, rails });
  const xfer = (rail, block, atMs, amount = 50000n, to = WORKER) => ({ to: to.toLowerCase(), amount, timestamp: s(atMs), blockNumber: block, logIndex: 0, txHash: '0x' + block.toString(16).padStart(64, '0'), rail: rail.name });
  const scans = (b, r) => new Map([[base.name, b], [rh.name, r]]);

  test('a task paid on Robinhood shows as paid, with that rail, even when Base is the pay rail', () => {
    const rows = rowsOn(base, [task('a', T0)]);
    const check = combineChecks({ rows, rails, scans: scans({ transfers: [], coveredFromMs: T0 - 1 }, { transfers: [xfer(rh, 75_000_000, T0 + 60_000)], coveredFromMs: T0 - 1 }) });
    const st = rowStatus(rows[0], check);
    assert.equal(st.kind, 'wallet');
    assert.equal(st.transfer.rail, 'robinhood');
  });

  test('no Pay button until every mainnet rail is checked back to the verification', () => {
    const rows = rowsOn(base, [task('a', T0)]);
    const baseOnly = combineChecks({ rows, rails, scans: new Map([[base.name, { transfers: [], coveredFromMs: T0 - 1 }]]) });
    assert.equal(rowStatus(rows[0], baseOnly).kind, 'unchecked');
    const rhShort = combineChecks({ rows, rails, scans: scans({ transfers: [], coveredFromMs: T0 - 1 }, { transfers: [], coveredFromMs: T0 + 1 }) });
    assert.equal(rowStatus(rows[0], rhShort).kind, 'unchecked');
    const both = combineChecks({ rows, rails, scans: scans({ transfers: [], coveredFromMs: T0 - 1 }, { transfers: [], coveredFromMs: T0 - 1 }) });
    assert.deepEqual(rowStatus(rows[0], both), { kind: 'unpaid', checked: true });
  });

  test('transfers from different chains are ordered by time, not block number', () => {
    const rows = rowsOn(base, [task('old', T0), task('new', T0 + 1000)]);
    const check = combineChecks({ rows, rails, scans: scans(
      { transfers: [xfer(base, 100, T0 + 120_000)], coveredFromMs: T0 - 1 },
      { transfers: [xfer(rh, 75_000_000, T0 + 60_000)], coveredFromMs: T0 - 1 },
    ) });
    assert.equal(check.match.get('old').rail, 'robinhood');
    assert.equal(check.match.get('new').rail, 'base');
  });

  test('one transfer never pays two tasks across rails, and the rules still hold per task', () => {
    const rows = rowsOn(rh, [task('a', T0), task('b', T0)]);
    const check = combineChecks({ rows, rails, scans: scans(
      { transfers: [xfer(base, 10, T0 - 60_000)], coveredFromMs: T0 - 120_000 }, // before verification
      { transfers: [xfer(rh, 20, T0 + 60_000), xfer(rh, 30, T0 + 90_000, 49_999n)], coveredFromMs: T0 - 1 }, // second is short
    ) });
    assert.equal(check.match.size, 1);
    assert.equal(check.match.get('a').rail, 'robinhood');
    assert.equal(rowStatus(rows.find((r) => r.id === 'b'), check).kind, 'unpaid');
  });

  test('amounts compare after scaling by each side\'s decimals', () => {
    const t = [{ id: 'a', wallet: WORKER, amount: 50000n, decimals: 6, verifiedAt: T0 }];
    const at = (amount) => [{ to: WORKER.toLowerCase(), amount, decimals: 18, timestamp: s(T0 + 60_000), blockNumber: 1, logIndex: 0, txHash: '0x' + '1'.repeat(64), rail: 'x' }];
    assert.equal(matchPayments(t, at(50_000_000_000_000_000n)).size, 1);
    assert.equal(matchPayments(t, at(49_000_000_000_000_000n)).size, 0);
    assert.equal(scaleAtomic(50000n, 6, 18), 50_000_000_000_000_000n);
  });

  test("handoff's own payouts don't count as the requester's", () => {
    const rows = rowsOn(base, [task('a', T0)]);
    const x = xfer(base, 10, T0 + 60_000);
    const check = combineChecks({ rows, rails, handoffTxs: new Set([x.txHash]), scans: scans({ transfers: [x], coveredFromMs: T0 - 1 }, { transfers: [], coveredFromMs: T0 - 1 }) });
    assert.equal(check.match.size, 0);
    assert.equal(check.handoffOwned, 1);
  });

  test('a task that names its network is payable only there, but a payment on any rail still counts', () => {
    const onBase = rowsOn(rh, [task('a', T0, { payment: { amount: '0.05', currency: 'USDC', network: 'base' } })])[0];
    assert.equal(onBase.payable, false);
    assert.equal(onBase.candidate, true);
    assert.match(onBase.railBlocks.join(), /only that rail can pay it/);
    assert.equal(rowsOn(base, [task('a', T0, { payment: { amount: '0.05', currency: 'USDC', network: 'base' } })])[0].payable, true);
    assert.equal(rowsOn(rh, [task('a', T0, { payment: { amount: '0.05', currency: 'USDC', network: 'robinhood' } })])[0].payable, true);
    const check = combineChecks({ rows: [onBase], rails, scans: scans({ transfers: [], coveredFromMs: T0 - 1 }, { transfers: [xfer(rh, 5, T0 + 60_000)], coveredFromMs: T0 - 1 }) });
    assert.equal(rowStatus(onBase, check).kind, 'wallet');
    const elsewhere = rowsOn(base, [task('a', T0, { payment: { amount: '0.05', currency: 'USDC', network: 'arc-testnet' } })])[0];
    assert.equal(elsewhere.candidate, false);
    assert.match(elsewhere.blocks.join(), /isn't a rail on this side/);
  });

  test("a custodial wallet can't be paid on a rail handoff doesn't list", () => {
    const t = task('c', T0, { assignee: 'cust' });
    const onRh = rowsOn(rh, [t])[0];
    assert.equal(onRh.payable, false);
    assert.equal(onRh.candidate, true); // still checked for payments on every rail
    assert.deepEqual(onRh.railBlocks, ["custodial wallet; handoff doesn't watch this chain"]);
    assert.equal(rowStatus(onRh, null).kind, 'blocked');
    assert.equal(rowsOn(base, [t])[0].payable, true);
  });

  test('USDG for a USDC-priced task is labelled on the row and in the proof', () => {
    assert.equal(tokenLabel('USDG', 'USDC'), 'paid in USDG (task priced in USDC)');
    assert.equal(tokenLabel('USDC', 'USDC'), null);
    const [row] = rowsOn(rh, [task('a', T0)]);
    assert.equal(row.payNote, 'paid in USDG (task priced in USDC)');
    assert.equal(rowsOn(base, [task('a', T0)])[0].payNote, null);
    const x = xfer(rh, 75_000_000, T0 + 60_000);
    const check = combineChecks({ rows: [row], rails, scans: scans({ transfers: [], coveredFromMs: T0 - 1 }, { transfers: [x], coveredFromMs: T0 - 1 }) });
    const text = proofText({ side: 'mainnet', rails, project: request, payer: PAYER, rows: [row], check, generatedAt: new Date(0) });
    assert.match(text, /amount: 0\.05 USDC \(0\.05 USDG sent\)/);
    assert.ok(text.includes('  paid in USDG (task priced in USDC)\n'));
    assert.match(text, /chain: Robinhood Chain \(4663\)/);
    assert.ok(text.includes(`link: https://robinhoodchain.blockscout.com/tx/${x.txHash}`));
  });
});

describe('one mainnet cap across rails', () => {
  const cap = 500000n; // 0.50 in 6-decimal units
  test('0.30 on Base then 0.30 on Robinhood: the second is refused; 0.20 still fits', () => {
    let spent = 0n;
    const first = checkCap({ cap, spent, amount: 300000n, decimals: 6, unit: 'USD' });
    assert.equal(first.ok, true);
    spent += toCapUnits(300000n, 6);
    const second = checkCap({ cap, spent, amount: 300000n, decimals: 6, unit: 'USD' });
    assert.equal(second.ok, false);
    assert.match(second.reason, /over the 0\.50 USD cap/);
    assert.equal(checkCap({ cap, spent, amount: 200000n, decimals: 6 }).ok, true);
  });
  test('amounts in other decimals are converted, rounding up', () => {
    assert.equal(toCapUnits(1n, 18), 1n);
    assert.equal(toCapUnits(500_000_000_000_000_000n, 18), 500000n);
    assert.equal(checkCap({ cap, spent: 0n, amount: 500_000_000_000_000_001n, decimals: 18 }).ok, false);
  });
});
