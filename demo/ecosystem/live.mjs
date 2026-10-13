// Records handoff capital (fc-studio's raise) while real actions run on handoff.lol and Base Sepolia; the page is re-read after each one.
import { chromium } from 'playwright-core';
import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdirSync, appendFileSync } from 'node:fs';
import { call, must } from './lib.mjs';
import { SEL, encodeCall } from '../../capital-lib.js';
const RPC = 'https://sepolia.base.org', USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const S = '0xf86c8c57277d3127ae9fa895df0b2e44ecf7a4d0', INV = 'notben_agent', INVW = '0xfbFc3b23EAB590E7F67422649097826b8D817B42', CO = 'fc-studio';
const CAP = 'https://miniapps.lol/api/v1/apps/Henrich/handoff-capital/bundle';
const dir = new URL('./live-rec/', import.meta.url).pathname; mkdirSync(dir, { recursive: true });
const out = {}; const note = (k, v) => { out[k] = v; writeFileSync(new URL('./live.json', import.meta.url), JSON.stringify(out, null, 1)); appendFileSync(new URL('./live.log', import.meta.url), `${new Date().toISOString()}  ${k} ${JSON.stringify(v)}\n`); console.log(k, JSON.stringify(v)); };
const cast = (...a) => execFileSync('cast', [...a, '--rpc-url', RPC], { encoding: 'utf8' }).trim();
const usdcOf = (w) => BigInt(cast('call', USDC, 'balanceOf(address)(uint256)', w).split(' ')[0]);
const rcpt = (tx) => JSON.parse(execFileSync('cast', ['receipt', tx, '--json', '--rpc-url', RPC, '--confirmations', '2'], { encoding: 'utf8' }));
const fmt = (a) => (Number(a) / 1e6).toString();
const hms = () => new Date().toISOString().slice(11, 19) + ' UTC';
async function wcall(as, to, data, what) {
  const r = must(await call(as, 'POST', `/api/v1/agents/${as}/wallet/call`, { to, data, value_wei: '0' }), what);
  const rc = rcpt(r.tx);
  if (Number(BigInt(rc.status)) !== 1) throw new Error(`${what} reverted ${r.tx}`);
  return { tx: r.tx, block: Number(BigInt(rc.blockNumber)) };
}

const segs = [];
const b = await chromium.launch({ channel: 'chrome', headless: true });
const ctx = await b.newContext({ viewport: { width: 1280, height: 720 }, recordVideo: { dir, size: { width: 1280, height: 720 } }, colorScheme: 'light' });
const page = await ctx.newPage();
const t0 = Date.now(); const now = () => (Date.now() - t0) / 1000;
const hold = async (s) => { const a = now(); await page.waitForTimeout(s * 1000); segs.push([a, now()]); };
const cap = (text) => page.evaluate((text) => {
  let d = document.getElementById('__cap');
  if (!d) { d = document.createElement('div'); d.id = '__cap'; d.style.cssText = 'position:fixed;left:0;right:0;bottom:0;z-index:2147483647;background:#000;color:#fff;font:600 21px/1.4 -apple-system,system-ui,sans-serif;padding:14px 28px;'; document.documentElement.appendChild(d); }
  d.innerHTML = text;
}, text);
const mark = (...res) => page.evaluate((srcs) => {
  document.querySelectorAll('[data-mark]').forEach((e) => { e.style.outline = ''; e.removeAttribute('data-mark'); });
  let n = 0;
  for (const src of srcs) {
    const re = new RegExp(src);
    const el = [...document.querySelectorAll('li,div,p,span,b')].reverse().find((e) => re.test(e.textContent.trim()) && ![...e.children].some((c) => re.test(c.textContent.trim())));
    const row = el && (el.closest('li') || el.closest('.lk-split') || el);
    if (row) { row.setAttribute('data-mark', ''); row.style.outline = '3px solid #ffd400'; row.style.outlineOffset = '3px'; n++; }
  }
  return n;
}, res.map((r) => r.source));
const toRev = async () => { await page.evaluate(() => { const h = document.getElementById('h-rev'); if (h) window.scrollTo(0, h.getBoundingClientRect().top + scrollY - 40); }); await page.waitForTimeout(700); };
const reread = async (re, label) => {
  for (let k = 0; k < 20; k++) {
    try { await page.goto(CAP, { waitUntil: 'networkidle', timeout: 60000 }); } catch (e) { console.log('goto', e.message.slice(0, 60)); }
    for (let i = 0; i < 90; i++) { const t = await page.locator('body').innerText().catch(() => ''); if (/block \d+/.test(t) && re.test(t)) { await page.waitForTimeout(1200); await toRev(); return t; } await page.waitForTimeout(500); }
    console.log('reread retry', label, k);
  }
  throw new Error('page never showed ' + label);
};

try {
  const start = new Date().toISOString().slice(0, 16).replace('T', ' ');
  await page.setContent(`<html style="background:#000"><body style="margin:0;background:#000;color:#eee;height:720px;display:flex;align-items:center;justify-content:center;font:26px/1.5 -apple-system,system-ui,sans-serif"><div style="max-width:1000px">Recorded live, ${start} UTC<br><span style="color:#aaa;font-size:21px">handoff capital on miniapps.lol, open on FC Studio’s raise. Each action runs on handoff.lol and Base Sepolia testnet, then the page reads the contract again. Amounts are test USDC.</span></div></body>`);
  await page.waitForTimeout(800); await hold(5);

  await reread(/1 of 2 sold/, 'start');
  await mark(/^1 of 2 sold/, /^Holders/);
  await cap(`${hms()} · FC Studio’s raise: 1 of 2 shares sold, 3 holders. One share is left at 0.001 USDC`); await hold(4.5);

  await mark();
  await cap(`${hms()} · notben_agent, an agent outside FC Studio under another owner, calls buy(1) from its handoff wallet…`); await hold(3.5);
  const u0 = usdcOf(INVW);
  const buy = await wcall(INV, S, encodeCall(SEL.buy, ['uint256'], [1n]), 'buy');
  note('buy', { ...buy, usdc_before: fmt(u0), usdc_after: fmt(usdcOf(INVW)), shares: cast('call', S, 'balanceOf(address)(uint256)', INVW).split(' ')[0] });
  await reread(/2 of 2 sold/, 'bought');
  await mark(/^2 of 2 sold/, /^0xfbfc…7b42 bought 1/, /^Holders/);
  await cap(`${hms()} · Re-read from the contract: 2 of 2 sold, and notben_agent’s buy in block ${buy.block}. It now holds 1 of 6 shares`); await hold(5.5);

  await page.evaluate(() => { const h = [...document.querySelectorAll('h2,h3')].find((e) => /^Who pays/.test(e.textContent.trim())); if (h) window.scrollTo(0, h.getBoundingClientRect().top + scrollY - 60); }); await page.waitForTimeout(900);
  await mark(/eco-market-e1/);
  await cap(`${hms()} · notben_agent buys eco-market, which includes FC Studio’s eco-board, for 0.01 USDC on handoff…`); await hold(3.5);
  const sale = must(await call(INV, 'POST', '/api/v1/apps/handoff-claude/eco-market-e1/buy', {}), 'sale').sale;
  const sp = Object.fromEntries(sale.splits.map((x) => [x.agent, fmt(x.amount)]));
  note('sale', { id: sale.id, price: fmt(sale.price), seller: sale.author, seller_amount: fmt(sale.seller_amount), splits: sale.splits.map((x) => ({ agent: x.agent, amount: fmt(x.amount), depth: x.depth, bps: x.bps, ref: x.ref })) });
  await cap(`${hms()} · Sale ${sale.id}: handoff-claude ${fmt(sale.seller_amount)}, FC Studio ${sp['fc-studio']} (10%), pixelshift ${sp.pixelshift} and manifast ${sp.manifast} (5% each)`); await hold(6);

  await toRev(); await mark();
  await cap(`${hms()} · FC Studio pays an amount equal to its 0.001 royalty from its own wallet into the share contract…`); await hold(3.5);
  const pay = must(await call(CO, 'POST', `/api/v1/agents/${CO}/wallet/spend`, { to: S, amount_usdc: '0.001' }), 'pay');
  const prc = rcpt(pay.tx);
  note('pay', { tx: pay.tx, block: Number(BigInt(prc.blockNumber)) });
  await reread(/Arrived, not booked yet\s*0\.001 USDC/, 'arrived');
  await mark(/^Arrived, not booked yet/);
  await cap(`${hms()} · Re-read: 0.001 USDC has arrived at the contract, not booked to holders yet`); await hold(4.5);

  await mark();
  await cap(`${hms()} · notben_agent calls claim(), which books the 0.001 over all 6 shares and pays out its part…`); await hold(3.5);
  const c0 = usdcOf(INVW);
  const claim = await wcall(INV, S, encodeCall(SEL.claim), 'claim');
  const got = usdcOf(INVW) - c0;
  note('claim', { ...claim, received: fmt(got) });
  await reread(/Booked to holders\s*0\.002 USDC/, 'claimed');
  await mark(/^Booked to holders/, /^Claimed$/, /^0xfbfc…7b42 claimed/);
  await cap(`${hms()} · Re-read: booked to holders 0.001 → 0.002, and notben_agent claimed ${fmt(got)} USDC in block ${claim.block}`); await hold(6);

  const s = cast('call', S, 'state()(uint256,uint256,uint256,uint256,bool,uint256,uint256,uint256)').split('\n').map((x) => x.split(' ')[0]);
  note('state', { supply: s[0], sold: s[1], forSale: s[2], revenue: fmt(s[5]), claimed: fmt(s[6]), unbooked: fmt(s[7]) });
  note('page', (await page.locator('body').innerText()).split('Revenue and holders')[1].split('Sources')[0]);
  await page.setContent(`<html style="background:#000"><body style="margin:0;background:#000;color:#eee;height:720px;display:flex;align-items:center;justify-content:center;font:24px/1.55 -apple-system,system-ui,sans-serif"><div style="max-width:1000px">Every figure shown was read from the AgentShares contract on Base Sepolia, live.<br><span style="color:#aaa;font-size:20px">Transactions: github.com/34r7h/handoff-capital, demo/ecosystem. All agents shown are the founder’s, in test USDC.</span></div></body>`);
  await page.waitForTimeout(300); await hold(4.5);
} catch (e) {
  console.log('ERROR', e.message);
  note('error', e.message);
} finally {
  const v = page.video();
  await ctx.close(); await b.close();
  const src = await v.path();
  writeFileSync(dir + 'segs.json', JSON.stringify({ src, segs }, null, 1));
  console.log(src, segs.length, segs.reduce((a, [x, y]) => a + y - x, 0).toFixed(1));
}
