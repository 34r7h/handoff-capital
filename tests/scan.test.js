import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { scanTransfers } from '../api.js';
import { TRANSFER_TOPIC, padTopicAddress, railsForSide } from '../lib.js';

const FROM = '0x559bb6ea072f59004638eacb55cdcb3104e0b9f7';
const TO = '0x8366a39cc670b4001a1121b8f6a443a643e40951';
const rail = railsForSide('mainnet', { defaultNetwork: 'base', networks: [{ name: 'base', chainId: 8453, usdc: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', rpcUrl: 'https://mainnet.base.org', explorer: 'https://basescan.org/tx/' }] })
  .find((r) => r.name === 'robinhood');

// A fake JSON-RPC: one Transfer log per listed block; real block time = 1_700_000_000 + block.
function fakeRpc(blocks, { claimed = () => '0x0', calls = [] } = {}) {
  return async (method, params) => {
    calls.push(method);
    if (method === 'eth_getBlockByNumber') return { timestamp: `0x${(1_700_000_000 + Number(BigInt(params[0]))).toString(16)}` };
    if (method !== 'eth_getLogs') throw new Error(`unexpected ${method}`);
    const [{ fromBlock, toBlock, topics, address }] = params;
    assert.equal(address, rail.token);
    assert.equal(topics[0], TRANSFER_TOPIC);
    assert.equal(topics[1], padTopicAddress(FROM));
    return blocks.filter((b) => b >= Number(BigInt(fromBlock)) && b <= Number(BigInt(toBlock))).map((b) => ({
      topics: [TRANSFER_TOPIC, padTopicAddress(FROM), padTopicAddress(TO)],
      data: `0x${(1_000_000).toString(16).padStart(64, '0')}`,
      blockNumber: `0x${b.toString(16)}`,
      logIndex: '0x0',
      transactionHash: `0x${b.toString(16).padStart(64, '0')}`,
      blockTimestamp: claimed(b),
    }));
  };
}

describe('transfer times from a scan', () => {
  test('logs with blockTimestamp "0x0" get their time from the block', async () => {
    const r = await scanTransfers({ rpc: fakeRpc([100, 200]), rail, from: FROM, tos: [TO], fromBlock: 0, toBlock: 1000 });
    assert.deepEqual(r.transfers.map((x) => x.timestamp), [1_700_000_100, 1_700_000_200]);
    assert.ok(r.transfers.every((x) => x.rail === 'robinhood' && x.decimals === 6));
  });
  test('claimed times are spot-checked; a wrong one makes every time come from its block', async () => {
    const r = await scanTransfers({ rpc: fakeRpc([100, 200], { claimed: (b) => `0x${(1_600_000_000 + b).toString(16)}` }), rail, from: FROM, fromBlock: 0, toBlock: 1000 });
    assert.deepEqual(r.transfers.map((x) => x.timestamp), [1_700_000_100, 1_700_000_200]);
  });
  test('correct claimed times cost one spot-check, not a block read per log', async () => {
    const calls = [];
    const r = await scanTransfers({ rpc: fakeRpc([100, 200, 300], { claimed: (b) => `0x${(1_700_000_000 + b).toString(16)}`, calls }), rail, from: FROM, fromBlock: 0, toBlock: 1000 });
    assert.deepEqual(r.transfers.map((x) => x.timestamp), [1_700_000_100, 1_700_000_200, 1_700_000_300]);
    assert.equal(calls.filter((m) => m === 'eth_getBlockByNumber').length, 1);
  });
});
