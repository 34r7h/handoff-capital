// handoff pay: browser UI. Reads handoff (GET only) and the chain; sends USDC
// only through the connected wallet after the user confirms each payment.
import {
  SIDES, getSettlement, listProjects, getProject, getTasks, getActivity, getAgents,
  makeRpc, walletRpc, latestBlock, blockTimestamp, blockAtOrBefore, scanTransfers, waitForReceipt, logChunkFor,
} from './api.js';
import {
  railsFrom, pickRail, buildRows, receiptIndex, matchPayments, rowStatus, checkCap, encodeTransfer,
  toAtomic, formatAtomic, explorerTxUrl, isTxHash, sameAddress, proofText, extractProjectId, receiptTxSet,
} from './lib.js';

document.getElementById('boot')?.remove();

const CAP_KEY = 'handoff-pay:mainnet-cap';
const CAP_DEFAULT = 500000n; // 0.50 USDC in atomic units
const SCAN_ROUND_CHUNKS = 150; // eth_getLogs calls per "check" round

const state = {
  side: 'testnet',
  settlement: null,
  rails: [],
  rail: null,
  railError: null,
  projects: null,
  projectsError: null,
  projectInput: '',
  loading: null,
  project: null,
  tasks: [],
  agents: new Map(),
  receipts: new Map(),
  handoffTxs: new Set(),
  activityError: null,
  rows: [],
  projectError: null,
  wallet: { account: null, chainId: null, error: null, busy: false },
  scan: null,
  scanBusy: false,
  scanError: null,
  scanProgress: null,
  pending: new Map(),
  sending: false,
  payMsg: null,
  cap: loadCap(),
  capMsg: null,
  filter: 'all',
  proofMsg: null,
  proofFallback: null,
};
let activityCache = { side: null, at: 0, data: null };
let listenersAttached = false;

// ---------------------------------------------------------------- tiny DOM helper (text only, never innerHTML)

function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'text') el.textContent = v;
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}
const link = (href, text) => (href ? h('a', { href, target: '_blank', rel: 'noopener noreferrer' }, text) : null);
const msg = (kind, ...text) => h('div', { class: `msg ${kind}` }, ...text);
const when = (ms) => (ms == null ? 'unknown time' : new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }));
const usdc = (atomic) => `${formatAtomic(atomic, state.rail?.decimals ?? 6)} USDC`;
const api = () => SIDES[state.side].api;
const eth = () => window.ethereum;

// ---------------------------------------------------------------- cap (mainnet only)

function loadCap() {
  try {
    const raw = sessionStorage.getItem(CAP_KEY);
    if (raw) {
      const o = JSON.parse(raw);
      return { cap: BigInt(o.cap), spent: BigInt(o.spent) };
    }
  } catch { /* storage unavailable: fall back to the default */ }
  return { cap: CAP_DEFAULT, spent: 0n };
}
function saveCap() {
  try { sessionStorage.setItem(CAP_KEY, JSON.stringify({ cap: String(state.cap.cap), spent: String(state.cap.spent) })); } catch { /* ignore */ }
}
const capApplies = () => state.side === 'mainnet';

// ---------------------------------------------------------------- loading

async function loadSide(side) {
  state.side = side;
  state.settlement = null; state.rails = []; state.rail = null; state.railError = null;
  state.projects = null; state.projectsError = null;
  clearProject();
  render();
  try {
    state.settlement = await getSettlement(api());
    state.rails = railsFrom(state.settlement);
    state.rail = pickRail(state.settlement);
  } catch (e) {
    state.railError = `Couldn't load the payment rail from ${api()}/config/settlement: ${e.message}`;
  }
  render();
  try {
    const list = await listProjects(api(), 200);
    list.sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));
    state.projects = list;
  } catch (e) {
    state.projectsError = `Couldn't list projects: ${e.message}`;
  }
  render();
}

function clearProject() {
  state.project = null; state.tasks = []; state.rows = []; state.agents = new Map();
  state.projectError = null; state.activityError = null;
  state.pending = new Map(); // sent payments stay locked until the project changes
  resetScan();
}

function resetScan() {
  state.scan = null; state.scanError = null; state.scanProgress = null;
  state.payMsg = null; state.proofMsg = null; state.proofFallback = null;
}

async function activity() {
  if (activityCache.side === state.side && Date.now() - activityCache.at < 60000) return activityCache.data;
  const data = await getActivity(api());
  activityCache = { side: state.side, at: Date.now(), data };
  return data;
}

async function loadProject(raw) {
  const id = extractProjectId(raw);
  if (!id) {
    state.projectError = 'That doesn\'t look like a project id. Paste the id (like 2af16779-4c0f-…) or a link that contains it.';
    render();
    return;
  }
  if (!state.rail) { state.projectError = 'The payment rail isn\'t loaded yet.'; render(); return; }
  clearProject();
  state.projectInput = id;
  state.loading = 'Loading project…';
  render();
  const side = state.side;
  try {
    const [project, tasks] = await Promise.all([getProject(api(), id), getTasks(api(), id)]);
    let receipts = new Map();
    let handoffTxs = new Set();
    try {
      const feed = await activity();
      receipts = receiptIndex(feed);
      handoffTxs = receiptTxSet(feed);
    } catch (e) {
      state.activityError = `Couldn't read handoff's activity feed, so some "paid by handoff" payouts may not show: ${e.message}`;
    }
    state.loading = 'Looking up workers…';
    render();
    const workers = tasks.filter((t) => t.status === 'verified').map((t) => t.assignee).filter((a) => typeof a === 'string' && a);
    const agents = await getAgents(api(), workers);
    if (side !== state.side) return; // the side changed while loading
    state.project = { ...project, id: project.id || id };
    state.tasks = tasks;
    state.agents = agents;
    state.receipts = receipts;
    state.handoffTxs = handoffTxs;
    rebuildRows();
    setHash();
  } catch (e) {
    state.projectError = e.status === 404
      ? `There's no project ${id} on ${SIDES[state.side].label.toLowerCase()}. Check the id, or switch sides.`
      : e.status === 401 || e.status === 403
        ? 'This project isn\'t public, so the app can\'t read it.'
        : `Couldn't load the project: ${e.message}`;
  }
  state.loading = null;
  render();
  if (canScan()) checkPayments({ back: true });
}

function rebuildRows() {
  if (!state.project || !state.rail) { state.rows = []; return; }
  state.rows = buildRows({ request: state.project, tasks: state.tasks, agents: state.agents, receipts: state.receipts, rail: state.rail, rails: state.rails });
}

function setHash() {
  const p = new URLSearchParams({ side: state.side });
  if (state.project) p.set('project', state.project.id);
  if (state.rail && state.settlement && state.rail.name !== pickRail(state.settlement).name) p.set('network', state.rail.name);
  history.replaceState(null, '', `#${p}`);
}

// ---------------------------------------------------------------- wallet

function walletError(e) {
  const code = e?.code ?? e?.data?.originalError?.code;
  if (code === 4001) return 'You declined the request in your wallet.';
  if (code === -32002) return 'Your wallet already has a request waiting. Open the wallet to answer it.';
  return e?.message || String(e);
}

const onRightChain = () => state.wallet.account && state.rail && state.wallet.chainId === state.rail.chainId;
const canScan = () => onRightChain() && state.project && state.rows.some((r) => r.payable);

async function connectWallet() {
  state.wallet.error = null;
  if (!eth()) {
    state.wallet.error = 'No browser wallet found. Install or enable one (MetaMask, Coinbase Wallet, Rabby…), then reload this page.';
    render();
    return;
  }
  state.wallet.busy = true;
  render();
  try {
    const accounts = await eth().request({ method: 'eth_requestAccounts' });
    setAccount(accounts?.[0] ?? null);
    attachListeners();
    await ensureChain();
  } catch (e) {
    state.wallet.error = walletError(e);
  }
  state.wallet.busy = false;
  render();
  if (canScan()) checkPayments({ back: true });
}

function setAccount(account) {
  if (!sameAddress(account, state.wallet.account)) resetScan();
  state.wallet.account = account || null;
}

function attachListeners() {
  if (listenersAttached || !eth()?.on) return;
  listenersAttached = true;
  eth().on('accountsChanged', (accounts) => {
    setAccount(accounts?.[0] ?? null);
    render();
    if (canScan()) checkPayments({ back: true });
  });
  eth().on('chainChanged', (hex) => {
    state.wallet.chainId = Number.parseInt(hex, 16);
    render();
    if (canScan() && !state.scan) checkPayments({ back: true });
  });
}

async function ensureChain() {
  const rail = state.rail;
  if (!rail) return false;
  const want = `0x${rail.chainId.toString(16)}`;
  let current = await eth().request({ method: 'eth_chainId' });
  if (Number.parseInt(current, 16) !== rail.chainId) {
    try {
      await eth().request({ method: 'wallet_switchEthereumChain', params: [{ chainId: want }] });
    } catch (e) {
      const code = e?.code ?? e?.data?.originalError?.code;
      if (code !== 4902 && !/unrecognized chain|not been added|unknown chain/i.test(e?.message || '')) throw e;
      await eth().request({
        method: 'wallet_addEthereumChain',
        params: [{
          chainId: want,
          chainName: rail.label,
          nativeCurrency: { name: rail.nativeSymbol, symbol: rail.nativeSymbol, decimals: 18 },
          rpcUrls: [rail.rpcUrl],
          blockExplorerUrls: [rail.explorer.replace(/tx\/?$/, '')],
        }],
      });
    }
    current = await eth().request({ method: 'eth_chainId' });
  }
  state.wallet.chainId = Number.parseInt(current, 16);
  return state.wallet.chainId === rail.chainId;
}

async function switchChain() {
  state.wallet.error = null;
  try { await ensureChain(); } catch (e) { state.wallet.error = walletError(e); }
  render();
  if (canScan()) checkPayments({ back: true });
}

// ---------------------------------------------------------------- reading payments from the chain

// One round: pick up new blocks since the last check, then (when `back`)
// extend the checked range back toward the oldest unpaid verification, at most
// SCAN_ROUND_CHUNKS log queries per round.
async function checkPayments({ back = true } = {}) {
  if (state.scanBusy || !canScan()) return;
  const rail = state.rail;
  const payer = state.wallet.account;
  const projectId = state.project.id;
  const candidates = state.rows.filter((r) => r.payable);
  const tos = [...new Set(candidates.map((r) => r.wallet.toLowerCase()))].sort();
  const key = `${payer.toLowerCase()}|${rail.name}|${projectId}|${tos.join(',')}`;
  const rpc = makeRpc(rail.rpcUrl);
  const chunk = logChunkFor(rail.chainId);
  state.scanBusy = true; state.scanError = null; state.scanProgress = { phase: 'Reading the latest block…' };
  render();
  try {
    let scan = state.scan?.key === key ? state.scan : null;
    const latest = await latestBlock(rpc);
    if (!scan) {
      scan = { key, payer, rail: rail.name, tos, low: latest + 1, high: latest, coveredFromMs: null, transfers: [], match: new Map(), tsCache: new Map() };
      back = true;
    } else if (latest > scan.high) {
      state.scanProgress = { phase: 'Checking new blocks' };
      progress();
      const fresh = await scanTransfers({ rpc, token: rail.usdc, from: payer, tos, fromBlock: scan.high + 1, toBlock: latest, chunk, timestampCache: scan.tsCache, onProgress: progressOf('Checking new blocks') });
      scan.transfers.push(...fresh);
      scan.high = latest;
    }
    const oldest = Math.min(...candidates.map((r) => r.verifiedAt));
    const needBack = scan.coveredFromMs == null || scan.coveredFromMs > oldest;
    if (back && needBack) {
      state.scanProgress = { phase: 'Finding where to start' };
      progress();
      const stop = await blockAtOrBefore(rpc, Math.floor(oldest / 1000), latest, scan.tsCache);
      const low = Math.max(stop, scan.low - SCAN_ROUND_CHUNKS * chunk, 0);
      if (low < scan.low) {
        const older = await scanTransfers({ rpc, token: rail.usdc, from: payer, tos, fromBlock: low, toBlock: scan.low - 1, chunk, timestampCache: scan.tsCache, onProgress: progressOf('Checking your past transfers') });
        scan.transfers.push(...older);
        scan.low = low;
        scan.coveredFromMs = (await blockTimestamp(rpc, low, scan.tsCache)) * 1000;
      }
    }
    // Only tasks verified inside the checked range take part in matching, so a
    // task outside it can never claim a transfer that belongs to one inside it.
    const inRange = candidates.filter((r) => scan.coveredFromMs != null && r.verifiedAt >= scan.coveredFromMs);
    // Transfers handoff itself reported as payouts (e.g. settled from a custodial
    // requester wallet) paid other tasks, so they don't count here.
    const own = scan.transfers.filter((x) => !state.handoffTxs.has(String(x.txHash).toLowerCase()));
    scan.handoffOwned = scan.transfers.length - own.length;
    scan.match = matchPayments(inRange.map((r) => ({ id: r.id, wallet: r.wallet, amount: r.amountAtomic, verifiedAt: r.verifiedAt })), own);
    if (state.wallet.account === payer && state.project?.id === projectId && state.rail === rail) state.scan = scan;
  } catch (e) {
    state.scanError = `Couldn't read your transfers from ${new URL(rail.rpcUrl).host}: ${e.message}. Nothing was marked unpaid because of this; try again in a moment.`;
  }
  state.scanBusy = false; state.scanProgress = null;
  render();
}

function progressOf(phase) {
  return ({ scanned, total }) => { state.scanProgress = { phase, scanned, total }; progress(); };
}
function progress() {
  const el = document.getElementById('scan-progress');
  if (!el) return;
  const p = state.scanProgress;
  el.textContent = !p ? '' : p.total ? `${p.phase}: ${Math.round((100 * p.scanned) / p.total)}% of ${p.total.toLocaleString()} blocks` : `${p.phase}…`;
}

// ---------------------------------------------------------------- paying

async function pay(row) {
  state.payMsg = null;
  const rail = state.rail;
  const scan = state.scan;
  const status = rowStatus(row, scan);
  if (state.sending) return;
  if (!(row.payable && status.kind === 'unpaid' && status.checked) || state.pending.has(row.id)) {
    state.payMsg = { kind: 'error', text: 'This task isn\'t confirmed unpaid yet. Check payments first.' };
    render();
    return;
  }
  try {
    const accounts = await eth().request({ method: 'eth_accounts' });
    if (!sameAddress(accounts?.[0], scan.payer)) throw new Error('Your wallet account changed since the last check. Check payments again before paying.');
    const chain = Number.parseInt(await eth().request({ method: 'eth_chainId' }), 16);
    if (chain !== rail.chainId) throw new Error(`Your wallet is on chain ${chain}. Switch it to ${rail.label} first.`);
  } catch (e) {
    state.payMsg = { kind: 'error', text: walletError(e) };
    render();
    return;
  }
  const amount = row.amountAtomic;
  if (capApplies()) {
    const c = checkCap({ cap: state.cap.cap, spent: state.cap.spent, amount, decimals: rail.decimals });
    if (!c.ok) {
      state.payMsg = { kind: 'error', text: `Refused: ${c.reason} Raise the cap only if you mean to.` };
      render();
      return;
    }
  }
  const ok = window.confirm(
    `Send ${usdc(amount)} on ${rail.label}\n`
    + `to ${row.worker} (${row.wallet})\n`
    + `for "${row.title.slice(0, 120)}"?\n\n`
    + `From your wallet ${scan.payer}. Your wallet will ask you to confirm again.`,
  );
  if (!ok) return;

  const data = encodeTransfer(row.wallet, amount);
  state.sending = true;
  if (capApplies()) { state.cap.spent += amount; saveCap(); } // reserve before the wallet can broadcast
  render();
  let hash;
  try {
    hash = await eth().request({ method: 'eth_sendTransaction', params: [{ from: scan.payer, to: rail.usdc, data, value: '0x0' }] });
  } catch (e) {
    if (capApplies()) { state.cap.spent -= amount; saveCap(); }
    state.sending = false;
    state.payMsg = { kind: 'error', text: walletError(e) };
    render();
    return;
  }
  const pending = { hash: isTxHash(hash) ? hash : null, state: 'waiting' };
  state.pending.set(row.id, pending);
  state.payMsg = { kind: 'info', text: `Sent. Waiting for ${rail.label} to include it…` };
  render();

  const receipt = pending.hash ? await waitForReceipt([makeRpc(rail.rpcUrl), walletRpc(eth())], pending.hash) : null;
  if (!receipt) {
    pending.state = 'timeout';
    state.payMsg = { kind: 'warn', text: 'The payment hasn\'t confirmed yet. Follow the transaction link; this task stays locked so it can\'t be paid twice.' };
  } else if (receipt.status === '0x1') {
    pending.state = 'mined';
    state.payMsg = { kind: 'ok', text: `Confirmed in block ${Number(BigInt(receipt.blockNumber)).toLocaleString()}.` };
  } else {
    pending.state = 'reverted';
    if (capApplies()) { state.cap.spent -= amount; saveCap(); }
    state.payMsg = { kind: 'error', text: 'The transaction failed on chain (reverted), so no USDC moved. You can try again.' };
  }
  state.sending = false;
  render();
  if (pending.state === 'mined') await checkPayments({ back: false });
}

// ---------------------------------------------------------------- proof

async function copyProof() {
  const text = proofText({ side: state.side, rail: state.rail, project: state.project, payer: state.scan?.payer || state.wallet.account, rows: state.rows, scan: state.scan });
  state.proofFallback = null;
  try {
    await navigator.clipboard.writeText(text);
    state.proofMsg = 'Proof copied. Paste it into the project on handoff yourself; this app doesn\'t post it.';
  } catch {
    state.proofMsg = 'Your browser blocked the clipboard. Select the text below and copy it.';
    state.proofFallback = text;
  }
  render();
}

// ---------------------------------------------------------------- rendering

function render() {
  document.querySelectorAll('.seg button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.side === state.side)));
  const root = document.getElementById('app');
  root.replaceChildren(railSection(), walletSection(), projectSection(), ...resultsSection());
  progress();
}

function railSection() {
  if (state.railError) return h('section', { class: 'card' }, h('h2', { text: 'Payment rail' }), msg('error', state.railError), h('button', { class: 'btn', type: 'button', onclick: () => loadSide(state.side) }, 'Try again'));
  if (!state.rail) return h('section', { class: 'card' }, h('h2', { text: 'Payment rail' }), h('p', { class: 'muted' }, 'Loading the rail from handoff…'));
  const r = state.rail;
  const picker = state.rails.length > 1
    ? h('select', {
      'aria-label': 'Network',
      onchange: (e) => {
        state.rail = state.rails.find((x) => x.name === e.target.value) || state.rail;
        resetScan(); rebuildRows(); setHash(); render();
        if (state.wallet.account) switchChain();
      },
    }, state.rails.map((x) => h('option', { value: x.name, selected: x.name === r.name }, `${x.label}${x.name === state.settlement.defaultNetwork ? ' (handoff default)' : ''}`)))
    : null;
  return h('section', { class: 'card' },
    h('h2', { text: 'Payment rail' }),
    h('div', { class: 'row' },
      h('div', { class: 'grow' },
        h('div', {}, h('b', {}, r.label), ` · chain ${r.chainId}${r.testnet ? ' · test money' : ' · real money'}`),
        h('div', { class: 'small muted' }, 'USDC ', h('span', { class: 'mono' }, r.usdc))),
      picker));
}

function walletSection() {
  const w = state.wallet;
  const parts = [h('h2', { text: 'Your wallet' })];
  if (!w.account) {
    parts.push(h('div', { class: 'row' },
      h('p', { class: 'grow muted' }, 'Connect the wallet you pay from. The app reads your past USDC transfers to see what you already paid.'),
      h('button', { class: 'btn primary', type: 'button', disabled: w.busy || !state.rail, onclick: connectWallet }, w.busy ? 'Connecting…' : 'Connect wallet')));
  } else {
    const right = onRightChain();
    parts.push(h('div', { class: 'row' },
      h('div', { class: 'grow' }, h('span', { class: 'mono' }, w.account), h('div', { class: 'small muted' }, right ? `on ${state.rail.label}` : `on chain ${w.chainId ?? '?'}, not ${state.rail?.label ?? 'the rail'}`)),
      right ? null : h('button', { class: 'btn primary', type: 'button', onclick: switchChain }, `Switch to ${state.rail?.label ?? 'the rail'}`)));
  }
  if (w.error) parts.push(msg('error', w.error));
  parts.push(capBlock());
  return h('section', { class: 'card' }, parts);
}

function capBlock() {
  if (!capApplies()) return h('p', { class: 'small muted', style: 'margin:10px 0 0' }, 'No spending cap on testnet (test USDC). Mainnet has a session cap.');
  const { cap, spent } = state.cap;
  const left = cap > spent ? cap - spent : 0n;
  const input = h('input', { type: 'text', inputmode: 'decimal', placeholder: 'New cap in USDC', 'aria-label': 'New session cap in USDC', autocomplete: 'off' });
  const setCap = () => {
    try {
      const v = toAtomic(input.value, 6);
      state.cap.cap = v;
      saveCap();
      state.capMsg = { kind: 'ok', text: `Session cap set to ${formatAtomic(v, 6)} USDC.` };
    } catch (e) {
      state.capMsg = { kind: 'error', text: `Type a USDC amount like 0.50 (${e.message}).` };
    }
    render();
  };
  return h('div', { style: 'margin-top:12px' },
    h('div', { class: 'stats' },
      h('span', {}, 'Session cap ', h('b', {}, `${formatAtomic(cap, 6)} USDC`)),
      h('span', {}, 'spent ', h('b', {}, formatAtomic(spent, 6))),
      h('span', {}, 'left ', h('b', {}, formatAtomic(left, 6)))),
    h('p', { class: 'small muted' }, 'Any payment that would go over the cap is refused. To change it, type a new number.'),
    h('form', { class: 'row', onsubmit: (e) => { e.preventDefault(); setCap(); } },
      h('div', { class: 'grow' }, input),
      h('button', { class: 'btn', type: 'submit' }, 'Set cap')),
    state.capMsg ? msg(state.capMsg.kind, state.capMsg.text) : null);
}

function projectSection() {
  const input = h('input', { type: 'text', value: state.projectInput, placeholder: 'Project id or link', 'aria-label': 'Project id or link', autocomplete: 'off', spellcheck: 'false', oninput: (e) => { state.projectInput = e.target.value; } });
  const parts = [
    h('h2', { text: 'Project' }),
    h('form', { class: 'row', onsubmit: (e) => { e.preventDefault(); loadProject(state.projectInput); } },
      h('div', { class: 'grow' }, input),
      h('button', { class: 'btn primary', type: 'submit', disabled: !!state.loading || !state.rail }, 'Load')),
  ];
  if (state.projectsError) parts.push(msg('warn', state.projectsError));
  else if (state.projects == null) parts.push(h('p', { class: 'small muted', style: 'margin:8px 0 0' }, 'Loading the project list…'));
  else if (!state.projects.length) parts.push(h('p', { class: 'small muted', style: 'margin:8px 0 0' }, `No projects listed on ${SIDES[state.side].label.toLowerCase()} yet. Paste an id if you have one.`));
  else {
    parts.push(h('div', { style: 'margin-top:8px' },
      h('label', { class: 'field', for: 'pick' }, `or pick one of ${state.projects.length}`),
      h('select', { id: 'pick', onchange: (e) => { if (e.target.value) { state.projectInput = e.target.value; loadProject(e.target.value); } } },
        h('option', { value: '' }, 'Choose a project…'),
        state.projects.map((p) => h('option', { value: p.id, selected: state.project?.id === p.id }, `${String(p.title || '(untitled)').slice(0, 80)} · ${p.requester ?? '?'} · ${p.status ?? ''}`)))));
  }
  if (state.loading) parts.push(msg('info', state.loading));
  if (state.projectError) parts.push(msg('error', state.projectError));
  return h('section', { class: 'card' }, parts);
}

const LABEL = {
  wallet: 'paid (your wallet)',
  handoff: 'paid by handoff',
  unpaid: 'unpaid',
  unchecked: 'not checked yet',
  blocked: "can't pay",
  none: 'nothing due',
  pending: 'payment sent',
};

function statusFor(row) {
  const s = rowStatus(row, state.scan);
  const p = state.pending.get(row.id);
  if (p && s.kind !== 'wallet' && p.state !== 'reverted') return { kind: 'pending', pending: p };
  return s;
}

function resultsSection() {
  if (!state.project) return [];
  const rows = state.rows;
  const other = state.tasks.length - rows.length;
  const statuses = rows.map((r) => [r, statusFor(r)]);
  const count = (k) => statuses.filter(([, s]) => s.kind === k).length;
  const out = [];
  const head = h('section', { class: 'card' },
    h('h2', { text: 'Verified tasks' }),
    h('p', {}, h('b', {}, state.project.title || '(untitled project)'), h('span', { class: 'muted' }, ` · requester ${state.project.requester ?? 'unknown'}`)),
    h('div', { class: 'stats' },
      h('span', {}, h('b', {}, rows.length), ' verified'),
      h('span', {}, h('b', {}, count('unpaid')), ' unpaid'),
      h('span', {}, h('b', {}, count('wallet')), ' paid by you'),
      h('span', {}, h('b', {}, count('handoff')), ' paid by handoff'),
      h('span', {}, h('b', {}, count('blocked')), " can't pay"),
      count('unchecked') ? h('span', {}, h('b', {}, count('unchecked')), ' not checked') : null,
      count('pending') ? h('span', {}, h('b', {}, count('pending')), ' sent') : null,
      count('none') ? h('span', {}, h('b', {}, count('none')), ' nothing due') : null),
    other > 0 ? h('p', { class: 'small muted' }, `${other} other task${other === 1 ? ' is' : 's are'} not verified yet, so ${other === 1 ? 'it is' : 'they are'} not shown.`) : null,
    state.activityError ? msg('warn', state.activityError) : null,
    scanBlock(statuses),
    state.payMsg ? msg(state.payMsg.kind, state.payMsg.text) : null,
    h('div', { class: 'row', style: 'margin-top:10px' },
      h('label', { class: 'small muted', for: 'filter' }, 'Show'),
      h('select', { id: 'filter', style: 'width:auto', onchange: (e) => { state.filter = e.target.value; render(); } },
        [['all', 'All'], ['unpaid', 'Unpaid'], ['paid', 'Paid'], ['blocked', "Can't pay"], ['unchecked', 'Not checked']].map(([v, t]) => h('option', { value: v, selected: state.filter === v }, t))),
      h('span', { class: 'grow' }),
      h('button', { class: 'btn', type: 'button', disabled: !(count('wallet') + count('handoff')), onclick: copyProof }, 'Copy proof')),
    state.proofMsg ? msg(state.proofFallback ? 'warn' : 'ok', state.proofMsg) : null,
    state.proofFallback ? h('textarea', { class: 'proof', readonly: true, 'aria-label': 'Payment proof' }, state.proofFallback) : null);
  out.push(head);

  if (!rows.length) {
    out.push(h('div', { class: 'empty' }, state.tasks.length
      ? 'No verified tasks in this project yet. Payment is only for tasks someone other than the worker has verified.'
      : 'This project has no tasks yet.'));
    return out;
  }
  const keep = ([, s]) => state.filter === 'all'
    || (state.filter === 'paid' && (s.kind === 'wallet' || s.kind === 'handoff'))
    || (state.filter === 'unpaid' && (s.kind === 'unpaid' || s.kind === 'pending'))
    || s.kind === state.filter;
  const shown = statuses.filter(keep);
  if (!shown.length) out.push(h('div', { class: 'empty' }, 'Nothing matches this filter.'));
  else out.push(h('ul', { class: 'tasks' }, shown.map(([r, s]) => taskCard(r, s))));
  return out;
}

function scanBlock(statuses) {
  const payable = state.rows.filter((r) => r.payable);
  if (!payable.length) return h('p', { class: 'small muted', style: 'margin-top:8px' }, 'None of these tasks can be paid from your wallet here, so there is nothing to check on chain.');
  const parts = [];
  if (!state.wallet.account) parts.push(h('p', { class: 'small muted' }, 'Connect your wallet to see which of these you already paid. Until then, "unpaid" means handoff hasn\'t paid it, not that you haven\'t.'));
  else if (!onRightChain()) parts.push(h('p', { class: 'small muted' }, `Switch your wallet to ${state.rail.label} to check and pay.`));
  const scan = state.scan;
  const unchecked = statuses.filter(([, s]) => s.kind === 'unchecked').length;
  if (scan) {
    parts.push(h('p', { class: 'small' },
      `Checked your USDC transfers in blocks ${scan.low.toLocaleString()}–${scan.high.toLocaleString()}`,
      scan.coveredFromMs != null ? ` (back to ${when(scan.coveredFromMs)})` : '',
      `: ${scan.transfers.length} transfer${scan.transfers.length === 1 ? '' : 's'} to these workers, ${scan.match.size} matched to tasks.`,
      scan.handoffOwned ? ` ${scan.handoffOwned} of them ${scan.handoffOwned === 1 ? 'was' : 'were'} handoff's own payout${scan.handoffOwned === 1 ? '' : 's'} and ${scan.handoffOwned === 1 ? "doesn't" : "don't"} count.` : '',
      unchecked ? ` ${unchecked} task${unchecked === 1 ? ' was' : 's were'} verified earlier and ${unchecked === 1 ? "isn't" : "aren't"} checked yet, so ${unchecked === 1 ? 'it' : 'they'} can't be paid until you check further back.` : ''));
  }
  const label = !scan ? 'Check my payments' : unchecked ? 'Check further back' : 'Check again';
  parts.push(h('div', { class: 'row' },
    h('button', { class: 'btn', type: 'button', disabled: state.scanBusy || !canScan(), onclick: () => checkPayments({ back: true }) }, state.scanBusy ? 'Checking…' : label),
    h('span', { id: 'scan-progress', class: 'small muted' })));
  if (state.scanError) parts.push(msg('error', state.scanError));
  return h('div', { style: 'margin-top:8px' }, parts);
}

function taskCard(row, s) {
  const rail = state.rail;
  const facts = h('dl', { class: 'facts' },
    h('dt', {}, 'Worker'),
    h('dd', {}, row.worker ?? 'none assigned', row.wallet ? h('span', { class: 'mono muted', title: row.wallet }, ` · ${row.wallet}`) : null),
    h('dt', {}, 'Amount'),
    h('dd', {}, row.amountAtomic != null ? usdc(row.amountAtomic) : 'unreadable'),
    h('dt', {}, 'Verified'),
    h('dd', {}, `by ${row.verifier ?? 'unknown'}${row.viaRequester ? ' (requester)' : ''} · ${when(row.verifiedAt)}`),
    h('dt', {}, 'Task'),
    h('dd', {}, h('span', { class: 'mono' }, row.id)));

  const actions = [];
  if (s.kind === 'wallet') {
    actions.push(link(explorerTxUrl(rail.explorer, s.tx), 'View your payment ↗'), h('span', { class: 'small muted' }, `${usdc(s.transfer.amount)} on ${when(s.transfer.timestamp * 1000)}`));
  } else if (s.kind === 'handoff') {
    actions.push(s.url ? link(s.url, 'View handoff\'s payout ↗') : h('span', { class: 'small muted' }, `handoff marks it paid${row.handoffPaid.receiptId ? ` (receipt ${row.handoffPaid.receiptId})` : ''}; the tx isn't in its public feed.`));
  } else if (s.kind === 'pending') {
    const url = explorerTxUrl(rail.explorer, s.pending.hash);
    actions.push(h('span', { class: 'small' }, s.pending.state === 'mined' ? 'Confirmed on chain.' : s.pending.state === 'timeout' ? 'Not confirmed yet.' : 'Waiting for confirmation…'), link(url, 'View transaction ↗'));
  } else if (s.kind === 'unpaid') {
    if (s.checked && row.payable) {
      let reason = null;
      if (state.sending) reason = 'Another payment is in progress.';
      else if (!onRightChain()) reason = `Switch your wallet to ${rail.label}.`;
      else if (capApplies() && !checkCap({ cap: state.cap.cap, spent: state.cap.spent, amount: row.amountAtomic }).ok) reason = 'This would go over your session cap.';
      actions.push(h('button', { class: 'btn primary', type: 'button', disabled: !!reason, onclick: () => pay(row) }, `Pay ${usdc(row.amountAtomic)}`));
      if (reason) actions.push(h('span', { class: 'small muted' }, reason));
    } else {
      actions.push(h('span', { class: 'small muted' }, state.wallet.account ? 'Check your payments to pay this.' : 'Connect a wallet to check and pay.'));
    }
  } else if (s.kind === 'unchecked') {
    actions.push(h('span', { class: 'small muted' }, 'Verified before the checked range. Use "Check further back" first.'));
  } else if (s.kind === 'none') {
    actions.push(h('span', { class: 'small muted' }, 'The task\'s amount is 0.'));
  }
  const failedBefore = state.pending.get(row.id)?.state === 'reverted';

  return h('li', { class: `task${s.kind === 'blocked' ? ' is-blocked' : ''}` },
    h('div', { class: 'task-head' }, h('h3', {}, row.title), h('span', { class: `pill ${s.kind}` }, LABEL[s.kind])),
    facts,
    row.blocks.length && s.kind !== 'handoff' ? h('ul', { class: 'flags' }, row.blocks.map((b) => h('li', {}, b))) : null,
    failedBefore ? msg('warn', 'Your last payment for this task reverted.') : null,
    actions.length ? h('div', { class: 'actions' }, actions) : null);
}

// ---------------------------------------------------------------- boot

document.querySelectorAll('.seg button').forEach((b) => b.addEventListener('click', async () => {
  if (b.dataset.side === state.side) return;
  state.projectInput = '';
  await loadSide(b.dataset.side);
  setHash();
  if (state.wallet.account) switchChain();
}));

(async () => {
  const p = new URLSearchParams(location.hash.slice(1));
  const side = SIDES[p.get('side')] ? p.get('side') : 'testnet';
  await loadSide(side);
  const net = p.get('network');
  if (net && state.rails.some((r) => r.name === net)) { state.rail = state.rails.find((r) => r.name === net); render(); }
  if (eth()) {
    // Show an already-connected wallet without prompting.
    try {
      const accounts = await eth().request({ method: 'eth_accounts' });
      if (accounts?.[0]) {
        setAccount(accounts[0]);
        state.wallet.chainId = Number.parseInt(await eth().request({ method: 'eth_chainId' }), 16);
        attachListeners();
        render();
      }
    } catch { /* ignore: the user can connect by hand */ }
  }
  const project = p.get('project');
  if (project) { state.projectInput = project; await loadProject(project); }
})();
