import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { XMBL_LABEL, XMBL_GAS_WEI, parseSealResponse, parseCheckLine, fundingStep, encodeBalanceOf, xmblProofText } from '../lib.js';

const FUND = '0x8366a39cc670b4001a1121b8f6a443a643e40951';
const XMB = `xmb${'ab'.repeat(20)}`;
const good = { claim_id: 'clm_1', fund_here: { address: FUND, chain: 'base-sepolia', asset: 'USDC', amount: '0.05' }, seal: { alg: 'xmbl-seal-v1', n: 729, receiver: XMB, kemU: '…' }, type6_xid: 't6', submitted: false };

describe('XMBL sealed release: pasted seal response', () => {
  test('the label says what this is', () => {
    assert.equal(XMBL_LABEL, 'Key release sealed by the handoff broker with experimental, unaudited Cubic-LWE. Not an escrow: the broker minted the key. Testnet only.');
  });
  test('a good response is accepted, with a note when it was not submitted to XMBL', () => {
    const r = parseSealResponse(JSON.stringify(good));
    assert.equal(r.ok, true, r.errors.join());
    assert.equal(r.fund.amountAtomic, 50000n);
    assert.equal(r.receiver, XMB);
    assert.match(r.notes.join(), /submitted: false/);
  });
  test('bad fields are reported and nothing is accepted', () => {
    assert.equal(parseSealResponse('not json').ok, false);
    const r = parseSealResponse(JSON.stringify({ ...good, fund_here: { address: 'nope', chain: 'base', asset: 'DAI', amount: '0.0000001' }, seal: { alg: 'x', n: 27, receiver: 'bob' } }));
    assert.equal(r.ok, false);
    for (const want of [/fund_here.address/, /Base Sepolia only/, /not USDC/, /not a USDC amount/, /alg/, /n is 27/, /receiver/]) assert.match(r.errors.join(' '), want);
  });
  test('a response carrying a private key is refused', () => {
    const r = parseSealResponse(JSON.stringify({ ...good, fund_here: { ...good.fund_here, evm_private_key: '0x11' } }));
    assert.equal(r.ok, false);
    assert.match(r.errors.join(), /fund_here.evm_private_key/);
  });
});

describe('XMBL sealed release: the worker\'s check line', () => {
  const seal = parseSealResponse(JSON.stringify(good));
  test('a matching line passes', () => {
    const c = parseCheckLine(`xmbl-check OK settlement=stl_1 claim=clm_1 fund=${FUND} receiver=${XMB}`, seal);
    assert.equal(c.ok, true, c.errors.join());
  });
  test('a line for another address, claim or worker fails', () => {
    const c = parseCheckLine(`xmbl-check OK settlement=stl_1 claim=clm_2 fund=0x${'22'.repeat(20)} receiver=xmb${'cd'.repeat(20)}`, seal);
    assert.equal(c.ok, false);
    assert.equal(c.errors.length, 3);
    assert.equal(parseCheckLine('FUNDING UNSAFE: …', seal).ok, false);
  });
});

describe('XMBL sealed release: funding steps', () => {
  const amountAtomic = 50000n;
  test('fresh -> USDC -> gas -> funded; exactly the amount plus the gas top-up', () => {
    assert.equal(fundingStep({ usdc: 0n, eth: 0n, nonce: 0, amountAtomic }).step, 'fund-usdc');
    assert.equal(fundingStep({ usdc: 50000n, eth: 0n, nonce: 0, amountAtomic }).step, 'fund-gas');
    assert.equal(fundingStep({ usdc: 50000n, eth: XMBL_GAS_WEI, nonce: 0, amountAtomic }).step, 'funded');
    assert.equal(XMBL_GAS_WEI, 20_000_000_000_000n);
  });
  test('a used or oddly funded address is never funded again', () => {
    assert.equal(fundingStep({ usdc: 0n, eth: 5n, nonce: 1, amountAtomic }).step, 'used');
    assert.equal(fundingStep({ usdc: 1n, eth: 0n, nonce: 0, amountAtomic }).step, 'unsafe');
    assert.equal(fundingStep({ usdc: 0n, eth: XMBL_GAS_WEI, nonce: 0, amountAtomic }).step, 'unsafe');
  });
  test('balanceOf calldata and the two-leg proof', () => {
    assert.equal(encodeBalanceOf(FUND), `0x70a08231000000000000000000000000${FUND.slice(2)}`);
    const tx = (n) => `0x${String(n).repeat(64)}`;
    const text = xmblProofText({ seal: parseSealResponse(JSON.stringify(good)), requester: '0xaa', worker: '0xbb', leg1: { amount: 50000n, from: '0xaa', to: FUND, txHash: tx(1) }, leg2: { amount: 50000n, from: FUND, to: '0xbb', txHash: tx(2) }, explorer: 'https://sepolia.basescan.org/tx/' });
    assert.match(text, /leg 1, requester 0xaa -> one-time address: 0\.05 USDC/);
    assert.match(text, /leg 2, one-time address -> worker 0xbb: 0\.05 USDC/);
    assert.ok(text.includes(XMBL_LABEL));
  });
});
