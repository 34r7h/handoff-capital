import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  rateAt, parseComponents, buildStore, componentFilesToFetch, upstreamOf, reachOf, reachTable,
  encodeParams, encodeConstructor, encodeCall, SEL, decodeState, decodeString, decodeShareLog, TOPIC,
  proRata, equalFounders, shareContractOf,
} from '../capital-lib.js';

test('rateAt follows handoff: 10%, then half each step, nothing past step 8', () => {
  assert.deepEqual([1, 2, 3, 4, 5, 6, 7, 8, 9].map((d) => rateAt(d)), [1000, 500, 250, 125, 62, 31, 15, 7, 0]);
  assert.equal(rateAt(0), 0);
});

test('parseComponents reads both forms and rejects a bad list whole', () => {
  assert.deepEqual(parseComponents('{"components":["impecc/lol-kit-style",{"author":"SirKit","name":"lol-search"},"impecc/lol-kit-style"]}'), ['impecc/lol-kit-style', 'SirKit/lol-search']);
  assert.deepEqual(parseComponents('["a/b"]'), ['a/b']);
  assert.deepEqual(parseComponents('{"components":["nope"]}'), []);
  assert.deepEqual(parseComponents('not json'), []);
});

// A's app 1 inside B's app 2 (a pinned dep) inside C's app 3 (a component, so its current version counts).
const v = (author, name, hash, created_at, deps = [], comp) => ({ author, name, hash, created_at, deps, file_hashes: comp ? { 'components.json': comp } : {} });
const versions = [
  v('A', 'one', 'a1', '2026-10-01'),
  v('B', 'two', 'b1', '2026-10-01'),
  v('B', 'two', 'b2', '2026-10-02', ['a1']),
  v('C', 'three', 'c1', '2026-10-03', [], 'fC'),
  v('D', 'four', 'd1', '2026-10-03', ['c1']),
  v('A', 'loop', 'l1', '2026-10-03', [], 'fL'), // names itself through C: a cycle
];
const components = new Map([['fC', ['B/two']], ['fL', ['D/four']]]);

test('the walk mirrors handoff: components at their current version, deps pinned, each family once at its first depth', () => {
  const store = buildStore(versions, components);
  assert.deepEqual(componentFilesToFetch(store).sort(), ['fC', 'fL']);
  assert.deepEqual([...upstreamOf(store, 'C/three')], [['B/two', 1], ['A/one', 2]]);
  assert.deepEqual([...upstreamOf(store, 'D/four')], [['C/three', 1], ['B/two', 2], ['A/one', 3]]);
  assert.deepEqual([...upstreamOf(store, 'A/loop')], [['D/four', 1], ['C/three', 2], ['B/two', 3], ['A/one', 4]]);
  assert.deepEqual([...upstreamOf(store, 'A/one')], []);
});

test('reach: which apps would pay an author, at the best step, and never an app of the same owner', () => {
  const store = buildStore(versions, components);
  assert.deepEqual(reachOf(store, 'A').map((r) => [r.app, r.depth, r.bps]), [['C/three', 2, 500], ['D/four', 3, 250], ['B/two', 1, 1000]].sort((x, y) => y[2] - x[2]));
  // A/loop is A's own app, so it never pays A
  assert.ok(!reachOf(store, 'A').some((r) => r.app === 'A/loop'));
  // if B and C share an owner, C's app pays B nothing
  const owners = new Map([['B', 'usr_1'], ['C', 'usr_1']]);
  assert.deepEqual(reachOf(store, 'B', owners).map((r) => r.app), ['D/four', 'A/loop']);
  assert.deepEqual(reachTable(store).map((r) => [r.author, r.apps]), [['A', 3], ['B', 3], ['C', 2], ['D', 1]]);
});

test('constructor encoding matches cast abi-encode byte for byte', () => {
  const hex = encodeConstructor({
    companyId: 'agy', name: 'agy shares', symbol: 'AGY',
    cash: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
    operator: '0xeB8BfD0e25f60B19F92c52dCe316E1D8868640E1',
    treasury: '0xDDf2980eFA32E9E15C9D0ece52F4BF32956EAE4c',
    price: 1_000_000n, sharesForSale: 400n,
    founders: ['0xeB8BfD0e25f60B19F92c52dCe316E1D8868640E1', '0xDDf2980eFA32E9E15C9D0ece52F4BF32956EAE4c'],
    founderShares: [300n, 300n],
  });
  // sha256 of `cast abi-encode` output (0x-prefixed, with its newline)
  assert.equal(createHash('sha256').update(`0x${hex}\n`).digest('hex'), '6325d2522520daf1483ac3bdef8d87f6678abb2c40d9e166fa833d8eb978f6f4');
});

test('strings: UTF-8, padding, empty', () => {
  const hex = encodeParams(['string', 'string'], ['ünïcode ✓ a string longer than thirty-two bytes for padding', '']);
  assert.equal(hex, '000000000000000000000000000000000000000000000000000000000000004000000000000000000000000000000000000000000000000000000000000000a0000000000000000000000000000000000000000000000000000000000000003fc3bc6ec3af636f646520e29c93206120737472696e67206c6f6e676572207468616e207468697274792d74776f20627974657320666f722070616464696e67000000000000000000000000000000000000000000000000000000000000000000');
  assert.equal(decodeString(hex, 0), 'ünïcode ✓ a string longer than thirty-two bytes for padding');
  assert.equal(decodeString(hex, 1), '');
});

test('calls and range checks', () => {
  assert.equal(encodeCall(SEL.buy, ['uint256'], [5n]), `0xd96a094a${'5'.padStart(64, '0')}`);
  assert.throws(() => encodeParams(['address'], ['0x12']), /not an address/);
  assert.throws(() => encodeParams(['uint256'], [-1n]), /out of range/);
});

test('state() and logs decode', () => {
  const w = (n) => BigInt(n).toString(16).padStart(64, '0');
  const s = decodeState(`0x${[1000, 250, 400, 1_000_000, 1, 7_000_000, 2_000_000, 5].map(w).join('')}`);
  assert.deepEqual(s, { supply: 1000n, sold: 250n, forSale: 400n, price: 1_000_000n, open: true, revenue: 7_000_000n, claimed: 2_000_000n, unbooked: 5n });
  const buyer = `0x${'ab'.repeat(20)}`;
  const log = { topics: [TOPIC.Bought, `0x${buyer.slice(2).padStart(64, '0')}`], data: `0x${w(10)}${w(10_000_000)}`, transactionHash: '0x01', blockNumber: '0x10' };
  assert.deepEqual(decodeShareLog(log), { tx: '0x01', block: 16, kind: 'bought', buyer, shares: 10n, cost: 10_000_000n });
  const rev = { topics: [TOPIC.Revenue], data: `0x${encodeParams(['uint256', 'string'], [3n, 'royalty SirKit/lol-search'])}`, blockNumber: '0x1' };
  assert.equal(decodeShareLog(rev).ref, 'royalty SirKit/lol-search');
  assert.equal(decodeShareLog({ topics: ['0x00'], data: '0x' }), null);
});

test('pro rata floors like the contract and founders split evenly', () => {
  assert.equal(proRata(10_000_000n, 1n, 3n), 3_333_333n);
  assert.equal(proRata(5n, 1n, 0n), 0n);
  assert.deepEqual(equalFounders(['0x1', '0x2', '0x3'], 700), { founders: ['0x1', '0x2', '0x3'], founderShares: [234n, 233n, 233n] });
});

test('a share contract is found from an onchain capital policy only', () => {
  const addr = '0x1a3ec387202188932f43a597636d76567a23e014';
  assert.equal(shareContractOf({ policies: [{ kind: 'onchain', scope: 'governance', ref: addr }] }), null);
  assert.deepEqual(shareContractOf({ policies: [{ kind: 'onchain', scope: 'capital', ref: addr, chain: 'base-sepolia' }] }), { address: addr, chain: 'base-sepolia' });
});
