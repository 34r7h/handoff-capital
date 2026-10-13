// One continuous headless take of the live sites: a drawn cursor that moves and clicks, URLs typed into an address bar drawn afterwards, captions in a band below.
const { chromium } = require('playwright-core');
const fs = require('fs'), path = require('path');
const dir = path.join(__dirname, 'out', 'rec'); fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir, { recursive: true });
const W = 1280, H = 620;
const TX = { buy: '0xcd14aae4b5ac5a410bc4b9320091a4a264f2ba878ee94af3c6ef1318db3fb58e', pay: '0x1170cd111ec63253deec54e3a241f08831fa4b23c592bfb947780b527a2ffcbe', claim: '0x187da326dec1b2dab29717bb9d1f21c454109f847c538e801ee076e78323f9a6' };
(async () => {
  const b = await chromium.launch({ channel: 'chrome', headless: true });
  const ctx = await b.newContext({ viewport: { width: W, height: H }, recordVideo: { dir, size: { width: W, height: H } }, colorScheme: 'light', timezoneId: 'UTC', locale: 'en-US' });
  const page = await ctx.newPage();
  const t0 = Date.now(); const now = () => (Date.now() - t0) / 1000;
  const ev = [], fast = []; let st = { bar: '', typing: false, cap: '' };
  const set = (p) => { st = { ...st, ...p }; ev.push({ t: now(), ...st }); };
  set({});
  page.on('framenavigated', (f) => { if (f === page.mainFrame() && !st.typing) set({ bar: /^about:|^data:/.test(f.url()) ? '' : f.url() }); });
  let cx = 640, cy = 300;
  const curJS = ([x, y, click]) => {
    let c = document.getElementById('__cur');
    if (!c) { c = document.createElement('div'); c.id = '__cur'; c.innerHTML = '<svg width="24" height="32" viewBox="0 0 24 32"><path d="M2 2 L2 26 L8 20 L13 30 L17 28 L12 18 L21 18 Z" fill="#111" stroke="#fff" stroke-width="2" stroke-linejoin="round"/></svg>'; c.style.cssText = 'position:fixed;z-index:2147483647;pointer-events:none;left:0;top:0;width:24px;height:32px;filter:drop-shadow(0 1px 2px rgba(0,0,0,.45))'; document.documentElement.appendChild(c); }
    c.style.transform = `translate(${x - 2}px,${y - 2}px)`;
    if (click) { const r = document.createElement('div'); r.style.cssText = `position:fixed;z-index:2147483646;pointer-events:none;left:${x - 24}px;top:${y - 24}px;width:48px;height:48px;border-radius:50%;border:3px solid #ff3b30;background:rgba(255,59,48,.2);transition:transform .5s ease-out,opacity .5s ease-out;transform:scale(.25);opacity:1`; document.documentElement.appendChild(r); requestAnimationFrame(() => requestAnimationFrame(() => { r.style.transform = 'scale(1.5)'; r.style.opacity = '0'; })); setTimeout(() => r.remove(), 700); }
  };
  const cur = (click = false) => page.evaluate(curJS, [cx, cy, click]).catch(() => {});
  page.on('domcontentloaded', () => cur());
  page.on('load', () => cur());
  const wait = (s) => page.waitForTimeout(s * 1000);
  const moveTo = async (x, y, ms = 650) => {
    const x0 = cx, y0 = cy, n = Math.max(8, Math.round(ms / 30));
    for (let i = 1; i <= n; i++) { const k = i / n, e = k < .5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2; cx = x0 + (x - x0) * e; cy = y0 + (y - y0) * e; await page.mouse.move(cx, cy); await cur(); await page.waitForTimeout(ms / n); }
  };
  const center = async (loc) => { const bx = await loc.boundingBox({ timeout: 3000 }).catch(() => null); return bx && { x: bx.x + Math.min(bx.width / 2, 60), y: bx.y + bx.height / 2, bx }; };
  const intoView = async (loc, lo = 70, hi = 470) => {
    for (let k = 0; k < 25; k++) {
      const c = await center(loc); if (!c) return null;
      if (c.y >= lo && c.y <= hi) return c;
      const d = Math.max(-420, Math.min(420, c.y - (lo + hi) / 2));
      for (let i = 0; i < 8; i++) { await page.mouse.wheel(0, d / 8); await page.waitForTimeout(35); }
      await page.waitForTimeout(250);
      const c2 = await center(loc); if (!c2 || Math.abs(c2.y - c.y) < 4) return c2;
    }
    return center(loc);
  };
  const point = async (loc, ms) => { const c = await intoView(loc); if (c) await moveTo(c.x, c.y, ms); return c; };
  const click = async (loc) => { const c = await point(loc); await wait(0.25); await cur(true); await page.mouse.click(cx, cy); return c; };
  const mark = (frame, ...res) => frame.evaluate((srcs) => {
    document.querySelectorAll('[data-mark]').forEach((e) => { e.style.outline = ''; e.removeAttribute('data-mark'); });
    let n = 0;
    for (const src of srcs) {
      const re = new RegExp(src);
      const el = [...document.querySelectorAll('li,div,p,span,b,dd,dt,td,a,h1,h2,h3')].reverse().find((e) => e.offsetParent && re.test(e.textContent.trim().replace(/\s+/g, ' ')) && ![...e.children].some((c) => re.test(c.textContent.trim().replace(/\s+/g, ' '))));
      if (el) { el.setAttribute('data-mark', String(n)); el.style.outline = '3px solid #ffb800'; el.style.outlineOffset = '3px'; n++; }
    }
    return n;
  }, res.map((r) => r.source)).catch(() => 0);
  const marked = (frame, i = 0) => frame.locator(`[data-mark="${i}"]`).first();
  const typeURL = async (url, per = 0.035) => {
    set({ typing: true, bar: '' });
    for (let i = 1; i <= url.length; i++) { set({ bar: url.slice(0, i) }); await wait(per); }
    await wait(0.35);
    set({ typing: false });
    const a = now();
    try { await page.goto('https://' + url, { waitUntil: 'domcontentloaded', timeout: 60000 }); } catch (e) { console.log('goto', url, e.message.slice(0, 80)); }
    return a;
  };
  const until = async (frameFn, re, ms = 45000) => {
    const a = Date.now();
    while (Date.now() - a < ms) { const f = frameFn(); if (f) { const t = await f.locator('body').innerText().catch(() => ''); if (re.test(t)) return f; } await page.waitForTimeout(400); }
    console.log('until timeout', re); return frameFn() || page.mainFrame();
  };
  const top = () => page.mainFrame();
  const storeF = () => page.frames().find((f) => f !== page.mainFrame() && /miniapps\.lol\/#\//.test(f.url()));
  const capF = () => page.frames().find((f) => /\/bundle/.test(f.url()));
  const load = async (url, frameFn, re, settle = 1.2) => { const a = await typeURL(url); const f = await until(frameFn, re); await wait(settle); fast.push([a, now()]); await cur(); return f; };
  const card = async (html) => { await page.setContent(`<html style="background:#0b0b10"><body style="margin:0;background:#0b0b10;color:#eee;height:${H}px;display:flex;align-items:center;justify-content:center;font:26px/1.5 -apple-system,system-ui,sans-serif"><div style="max-width:1040px">${html}</div></body>`); await cur(); };
  const read = new Date().toISOString().slice(0, 16).replace('T', ' ');

  try {
    await card(`handoff on Base Sepolia testnet: the whole loop, on the live sites<br><span style="color:#aaa;font-size:20px">Recorded ${read} UTC in a browser. The run itself took place on 2026-10-12 (15:21–15:28 UTC) and 2026-10-13 (00:49–00:51 UTC). Every figure shown is read from the live pages and from the chain. Amounts are test USDC.</span>`);
    set({ cap: '' }); await wait(6);

    let f = await load('miniapps.lol/app/pixelshift/eco-palette-e1', storeF, /0\.0002 usdc/);
    set({ cap: '1 · On miniapps.lol, the miniapp store, pixelshift, an agent, published eco-palette, a component other apps include, priced at 0.0002 USDC.' });
    await mark(f, /^0\.0002 usdc/); await point(marked(f)); await wait(4.5);
    await point(f.getByRole('link', { name: /Pixelshift/ }).first()); await wait(1);

    f = await load('miniapps.lol/app/manifast/eco-manifest-e1', storeF, /0\.0002 usdc/);
    set({ cap: '1 · manifast, an agent under a different owner, published eco-manifest, also at 0.0002 USDC.' });
    await mark(f, /^0\.0002 usdc/); await point(marked(f)); await wait(3.5);

    f = await load('miniapps.lol/app/fc-studio/eco-board-e1', storeF, /0\.002 usdc/);
    set({ cap: '2 · FC Studio, a company two agents formed, bought both components, paying each author 0.0002, and published eco-board, which includes them, at 0.002 USDC.' });
    await mark(f, /^0\.002 usdc/); await point(marked(f)); await wait(3);
    if (await mark(f, /^eco board: A board built/)) { await point(marked(f)); await wait(2.5); }

    f = await load('miniapps.lol/app/handoff-claude/eco-market-e1', storeF, /0\.01 usdc/);
    set({ cap: '3 · handoff-claude bought eco-board, so FC Studio got 0.0016 and each component author 0.0002, then built eco-market on it at 0.01.' });
    await mark(f, /^0\.01 usdc/); await point(marked(f)); await wait(4.5);

    f = await load('miniapps.lol/app/Henrich/handoff-capital', storeF, /Back a company of AI agents/);
    set({ cap: '4 · handoff capital is a miniapp in the same store. Press open and it runs in the page.' });
    await wait(1.5);
    const openBtn = f.locator('button').filter({ hasText: /^\s*open\s*$/i }).first();
    await click(openBtn);
    let a = now(); let cf = await until(capF, /block \d+/, 60000); await wait(1.5); fast.push([a, now()]);
    set({ cap: '4 · It opens on FC Studio. Its members are two agents, funny and charisma, both officers. The company is itself an agent on handoff, with no owner.' });
    await mark(cf, /^Members$/); await point(marked(cf)); await wait(3.5);
    await mark(cf, /^Who pays fc-studio/);
    await point(marked(cf), 900);
    await mark(cf, /^handoff-claude\/eco-market-e1$/);
    await point(marked(cf));
    set({ cap: '4 · Who pays it: every sale of eco-market pays FC Studio 10%, and pays pixelshift and manifast 5% each, one step further up.' });
    await wait(5);
    await mark(cf, /^For sale/); await point(marked(cf), 900);
    set({ cap: '5 · FC Studio raised through a share contract handoff deployed for it: 2 shares at 0.001 USDC. Both are sold and the raise is closed.' });
    await wait(5);
    await mark(cf, /^0xfbfc…7b42 bought 1 for 0\.001 USDC$/, /^0xfbfc…7b42 claimed 0\.000166 USDC$/); await point(marked(cf, 0), 900);
    set({ cap: '6 · At 00:49 UTC on 2026-10-13, notben_agent, a backer under a sixth owner, bought the last share. The page lists it from the chain.' });
    await wait(4.5);
    const blk = cf.getByRole('link', { name: 'block 48042151' }).first();
    await point(blk); await wait(0.3); await cur(true); await wait(0.6);
    set({ cap: '6 · That block links to the transaction. Here it is on Blockscout, an open Base Sepolia explorer.' }); await wait(1.5);

    f = await load(`base-sepolia.blockscout.com/tx/${TX.buy}`, top, /Status and method/, 1.5);
    set({ cap: '6 · On Base Sepolia, notben_agent’s wallet called buy(1). It paid 0.001 USDC to FC Studio’s treasury and got 1 FC Studio share.' });
    await mark(f, /^Swap 0\.0010 USDC for 1 FCS$/, /^buy$/, /^0xfbFc3b23EAB590E7F67422649097826b8D817B42$/); await point(marked(f, 0)); await wait(2.5); await point(marked(f, 1)); await wait(2); await point(marked(f, 2)); await wait(2);

    f = await load(`base-sepolia.blockscout.com/tx/${TX.pay}`, top, /Status and method/, 1.5);
    set({ cap: '7 · notben_agent then paid 0.01 for eco-market on handoff, crediting FC Studio 0.001. FC Studio paid an equal 0.001 USDC from its wallet into the share contract.' });
    if (await mark(f, /^Tokens transferred/)) await point(marked(f)); await wait(5.5);

    f = await load(`base-sepolia.blockscout.com/tx/${TX.claim}`, top, /Status and method/, 1.5);
    set({ cap: '8 · notben_agent called claim(). The contract booked that 0.001 over all 6 shares and paid notben_agent 0.000166 USDC.' });
    await mark(f, /^claim$/, /^Tokens transferred/); await point(marked(f, 0)); await wait(2.2); await point(marked(f, 1)); await wait(3.3);

    f = await load('miniapps.lol/app/Henrich/handoff-capital', storeF, /Back a company of AI agents/);
    set({ cap: 'Back in handoff capital, which reads the contract again.' });
    await click(f.locator('button').filter({ hasText: /^\s*open\s*$/i }).first());
    a = now(); cf = await until(capF, /block \d+/, 60000); await wait(1.2); fast.push([a, now()]);
    await mark(cf, /^Revenue and holders$/); await point(marked(cf), 1200);
    await mark(cf, /^Booked to holders/, /^Claimed$/, /^Holders/); await point(marked(cf, 0));
    set({ cap: 'Now: 0.002 USDC booked to holders and 0.000366 claimed, across 4 wallets and 6 shares.' });
    await wait(5);

    set({ cap: '' });
    await card(`Every agent shown is run by the founder, in test USDC on Base Sepolia.<br><span style="color:#aaa;font-size:20px">Sale ids and transactions: github.com/34r7h/handoff-pay, demo/ecosystem.</span>`);
    await wait(4.5);
  } catch (e) { console.log('ERROR', e.stack); }
  finally {
    const v = page.video(); await ctx.close(); await b.close();
    const src = await v.path();
    fs.writeFileSync(path.join(__dirname, 'out', 'walk.json'), JSON.stringify({ src, end: now(), ev, fast }, null, 1));
    console.log(src, now().toFixed(1), ev.length, fast.length);
  }
})();
