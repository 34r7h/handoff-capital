// The ecosystem demo on handoff.lol (Base Sepolia testnet), one step per argument:
//   node run.mjs components company apps downstream sale proof
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { call, must, log, usdc, state, save, signRaw, balanceOf } from './lib.mjs';

const R = 'e1';                                   // run suffix: buys are once per owner, so a retake needs new names
const A = { author: 'pixelshift', name: `eco-palette-${R}` };
const B = { author: 'manifast', name: `eco-manifest-${R}` };
const CO = 'fc-studio';
const FOUNDERS = ['funny', 'charisma'];
const C = { author: CO, name: `eco-board-${R}` };
const D = { author: 'handoff-claude', name: `eco-market-${R}` };
const BUYER = 'certified-trainer';
const ref = (x) => `${x.author}/${x.name}`;
const b64 = (s) => Buffer.from(s).toString('base64');

const page = (title, line, comps = []) => `<!doctype html><meta charset="utf-8"><title>${title}</title>
<body style="font:16px system-ui;padding:2rem;background:#040409;color:#ecebf7">
<h1>${title}</h1><p>${line}</p>${comps.length ? `<p>Includes: ${comps.join(', ')}</p>` : ''}
<p>Testnet stub for the handoff capital ecosystem demo.</p></body>`;

async function publish(as, app, title, line, comps = []) {
  const files = { 'index.html': b64(page(title, line, comps)) };
  if (comps.length) files['components.json'] = b64(JSON.stringify({ components: comps }));
  const r = must(await call(as, 'POST', '/api/v1/apps', {
    name: app.name, version: '0.1.0', entry: 'index.html', files, license: 'MIT', price: 0, permissions: [],
    description: `${title}: ${line} A testnet stub for the handoff capital ecosystem demo.`,
    notes: comps.length ? `Includes ${comps.join(' and ')} through components.json.` : 'A component other apps can include.',
  }), `publish ${ref(app)}`);
  const hash = r.hash || r.app?.hash;
  log(`${as} published ${ref(app)}${comps.length ? ` including ${comps.join(' + ')}` : ''}  hash ${hash}`, { hash });
  return hash;
}
async function price(as, app, p) {
  const r = must(await call(as, 'PUT', `/api/v1/apps/${app.author}/${app.name}/terms`, { price_usdc: p, use: 'open' }), `terms ${ref(app)}`);
  log(`${as} priced ${ref(app)} at ${r.terms.price_usdc} USDC, use open, royalty ${r.terms.royalty_bps / 100}% one step down, half each further step`);
  return r.terms;
}
async function buy(as, app) {
  const r = must(await call(as, 'POST', `/api/v1/apps/${app.author}/${app.name}/buy`, {}), `${as} buys ${ref(app)}`);
  const s = r.sale;
  if (r.already_owned) { log(`${as} already owns ${ref(app)} (sale ${s?.id})`); return s; }
  const parts = [`${s.author} ${usdc(s.seller_amount)} (seller)`, ...s.splits.map((x) => `${x.agent} ${usdc(x.amount)} (royalty, ${x.ref} step ${x.depth}, ${x.bps / 100}%)`)];
  log(`${as} bought ${ref(app)} for ${usdc(s.price)} USDC, sale ${s.id}: ${parts.join(' · ')}`, { sale: s });
  state.sales = { ...(state.sales || {}), [`${as}>${ref(app)}`]: s.id }; save();
  return s;
}

async function challengeSign(signer, membership) {
  const ch = must(await call(null, 'POST', `/api/v1/agents/${signer}/challenge`, {}), `challenge ${signer}`);
  const st = must(await call(null, 'GET', `/api/v1/memberships/${membership}/statement?nonce=${encodeURIComponent(ch.nonce)}&agent_id=${signer}&action=sign`), `statement ${membership}`);
  return must(await call(null, 'POST', `/api/v1/memberships/${membership}/sign`, { agent_id: signer, nonce: ch.nonce, signature: signRaw(signer, st.statement) }), `${signer} signs ${membership}`);
}

const steps = {
  async snapshot() {
    const who = [A.author, B.author, CO, ...FOUNDERS, D.author, BUYER, 'notben_agent'];
    const out = {};
    for (const id of who) { try { const a = await balanceOf(id); out[id] = { balance: a.balance, earned: a.earned }; } catch { out[id] = null; } }
    state.snapshots = { ...(state.snapshots || {}), [process.env.SNAP || 'before']: { at: new Date().toISOString(), ...out } }; save();
    log(`balances (${process.env.SNAP || 'before'}): ${Object.entries(out).map(([k, v]) => `${k} ${v ? usdc(v.balance) : '—'}`).join(' · ')}`);
  },
  async components() {
    await publish(A.author, A, 'eco palette', 'Picks a color palette; a component other miniapps include.');
    await price(A.author, A, '0.0002');
    await publish(B.author, B, 'eco manifest', 'Lists what a bundle ships; a component other miniapps include.');
    await price(B.author, B, '0.0002');
  },
  async company() {
    const keyDir = join(homedir(), '.handoff', 'agents', CO);
    if (!existsSync(join(keyDir, 'crypto-keys.json'))) {
      const r = must(await call(null, 'POST', '/api/v1/companies', {
        agent_id: CO, name: 'FC Studio',
        about: 'A company of two handoff agents, funny and charisma. It builds miniapps that other miniapps include, and raises on handoff capital. Testnet demo.',
      }), 'create company');
      mkdirSync(keyDir, { recursive: true });
      writeFileSync(join(keyDir, 'crypto-keys.json'), JSON.stringify({ agent_id: CO, sig: { pub: r.sig_pubkey, priv: r.sig_privkey }, agent_key: r.agent_key }, null, 2), { mode: 0o600 });
      log(`company ${CO} founded (an agent of type company, no owner, its own principal); wallet ${r.agent?.wallet_address || '?'}`, { agent: r.agent, company: r.company });
    }
    state.memberships = state.memberships || {};
    for (const m of FOUNDERS) {
      if (state.memberships[m]) continue;
      const p = must(await call(CO, 'POST', `/api/v1/companies/${CO}/members`, {
        agent_id: m, rank: 'officer', role: 'founder', responsibilities: ['builds the studio\'s miniapps'],
        payout: { rule: 'none' }, ends_at: '2027-10-01T00:00:00Z', scope: 'governance',
      }), `propose ${m}`);
      const id = (p.membership || p.contract).id;
      await challengeSign(CO, id);
      const s = await challengeSign(m, id);
      state.memberships[m] = id; save();
      log(`${m} joined ${CO} as officer: membership ${id} signed by both with their own Ed25519 keys, active ${!!(s.contract || s.membership)?.active || s.active}`);
    }
    const co = await call(CO, 'GET', `/api/v1/companies/${CO}`);
    log(`${CO}: ${co.company?.members?.length ?? co.members?.length} live members; treasury balance ${usdc(co.company?.treasury?.balance ?? co.treasury?.balance ?? 0)} USDC`, { company: co });
  },
  async fund() {
    if (state.funded) return log('fund: already done');
    const co = (await call(CO, 'GET', `/api/v1/agents/${CO}/wallet`)).wallet.address;
    for (const m of FOUNDERS) {
      const r = must(await call(m, 'POST', `/api/v1/agents/${m}/wallet/spend`, { to: co, amount_usdc: '0.02' }), `${m} funds ${CO}`);
      log(`${m} sent 0.02 USDC from its wallet to ${CO}'s wallet ${co} (gasless EIP-3009): tx ${r.tx}`, { spend: r });
    }
    state.funded = true; save();
  },
  async apps() {
    await buy(CO, A);
    await buy(CO, B);
    await publish(CO, C, 'eco board', 'A board built from eco palette and eco manifest.', [ref(A), ref(B)]);
    await price(CO, C, '0.002');
  },
  async downstream() {
    await buy(D.author, C);
    await publish(D.author, D, 'eco market', 'A market page built on FC Studio\'s eco board.', [ref(C)]);
    const t = await price(D.author, D, '0.01');
    log(`terms of ${ref(D)} now preview a ${t.sale_preview.price / 1e6} USDC sale: ${t.sale_preview.splits.map((x) => `${x.agent} ${usdc(x.amount)} (step ${x.depth})`).join(' · ')} · seller ${usdc(t.sale_preview.seller_amount)}`);
  },
  async sale() { await buy(BUYER, D); },
  async proof() {
    for (const id of [A.author, B.author, CO, D.author, BUYER]) {
      const r = await call(id, 'GET', `/api/v1/apps/licensing/${id}`);
      const t = r.totals || {};
      const roy = (r.royalties || []).filter((x) => /eco-/.test(x.sold)).map((x) => `${usdc(x.amount)} on ${x.sold} (via ${x.ref}, step ${x.depth})`);
      const sold = (r.sold || []).filter((x) => /eco-/.test(x.ref)).map((x) => `${usdc(x.seller_amount)} from ${x.buyer}`);
      log(`app_licensing ${id}: sold ${sold.join(', ') || 'none'} · royalties ${roy.join(', ') || 'none'} · spent ${t.spent_usdc}`, { licensing: r });
    }
  },
};

for (const s of process.argv.slice(2)) {
  if (!steps[s]) throw new Error(`no step ${s}`);
  await steps[s]();
}
