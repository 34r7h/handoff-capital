// Signed calls to handoff.lol as any agent whose key is on this machine, plus a run log.
import { createHash, createPrivateKey, sign as edSign } from 'node:crypto';
import { readFileSync, readdirSync, appendFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

export const BASE = 'https://handoff.lol';
export const DIR = new URL('.', import.meta.url).pathname;
const STATE = join(DIR, 'state.json');
export const state = existsSync(STATE) ? JSON.parse(readFileSync(STATE, 'utf8')) : {};
export const save = () => writeFileSync(STATE, JSON.stringify(state, null, 2));

const keys = new Map();
export function keyOf(id) {
  if (keys.has(id)) return keys.get(id);
  const agents = join(homedir(), '.handoff', 'agents');
  for (const d of readdirSync(agents)) {
    for (const f of ['crypto-keys.json', 'config.json']) {
      try {
        const j = JSON.parse(readFileSync(join(agents, d, f), 'utf8'));
        const priv = j.sig?.priv || j.sig_privkey;
        if (String(j.agent_id).toLowerCase() === id.toLowerCase() && priv) { keys.set(id, priv); return priv; }
      } catch { /* next */ }
    }
  }
  throw new Error(`no signing key for ${id}`);
}

export function signRaw(id, message) {
  const pk = createPrivateKey({ key: Buffer.from(keyOf(id), 'base64'), format: 'der', type: 'pkcs8' });
  return edSign(null, Buffer.from(message, 'utf8'), pk).toString('base64');
}

export async function call(id, method, path, body) {
  const buf = body === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(body));
  const headers = { 'user-agent': 'eco-demo/1' };
  if (id) {
    const ts = Date.now();
    const p = path.split('?')[0];
    const stmt = `handoff-signed-req\n${id}\n${method}\n${p}\n${ts}\n${createHash('sha256').update(buf).digest('hex')}`;
    Object.assign(headers, { 'x-agent-id': id, 'x-signature': signRaw(id, stmt), 'x-timestamp': String(ts) });
  }
  if (buf.length) headers['content-type'] = 'application/json';
  const res = await fetch(BASE + path, { method, headers, body: buf.length ? buf : undefined });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = { raw: text.slice(0, 400) }; }
  return { status: res.status, ...json };
}

export const usdc = (atomic) => (Number(atomic) / 1e6).toFixed(6);
export function log(line, data) {
  const at = new Date().toISOString();
  console.log(line);
  appendFileSync(join(DIR, 'run.log'), `${at}  ${line}\n`);
  appendFileSync(join(DIR, 'ledger.jsonl'), JSON.stringify({ at, line, ...(data ? { data } : {}) }) + '\n');
}
export function must(r, what) {
  if (r.success === false || r.status >= 400) throw new Error(`${what}: HTTP ${r.status} ${JSON.stringify(r).slice(0, 600)}`);
  return r;
}
export const balanceOf = async (id) => (await call(id, 'GET', `/api/v1/social/account/${id}`)).account;
