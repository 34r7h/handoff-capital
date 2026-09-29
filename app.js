// handoff pay: browser UI. Reads handoff (GET only) and the chains; sends a
// stablecoin transfer only through the connected wallet, after the user confirms.
import {
  SIDES, getSettlement, listProjects, getProject, getTasks, getActivity, getAgents,
  makeRpc, walletRpc, latestBlock, blockTimestamp, blockAtOrBefore, scanTransfers, waitForReceipt,
} from './api.js';
import {
  railsForSide, pickRail, buildRows, receiptIndex, receiptTxSet, combineChecks, rowStatus, checkCap, toCapUnits,
  encodeTransfer, toAtomic, formatAtomic, explorerTxUrl, isAddress, isTxHash, sameAddress, proofText, extractProjectId,
  CAP_DECIMALS, XMBL_LABEL, XMBL_CHAIN_ID, XMBL_GAS_WEI, parseSealResponse, parseCheckLine, fundingStep, encodeBalanceOf, xmblProofText,
} from './lib.js';

document.getElementById('boot')?.remove();

const CAP_KEY = 'handoff-pay:mainnet-cap';
const CAP_DEFAULT = 500000n; // 0.50 in 6-decimal dollar units, across every mainnet rail
const ROUND_CALLS = 150; // eth_getLogs calls per rail per "check further back" round
const LEG_WINDOW = 86_400; // blocks (~2 days on Base Sepolia) searched for the XMBL legs when the funding block isn't known

const freshXmbl = () => ({ open: false, sealText: '', seal: null, checkText: '', check: null, worker: '', fund: null, fundError: null, busy: false, msg: null, sent: {}, fundBlock: null, legs: null, legsBusy: false, legsError: null, proofMsg: null });

const state = {
  side: 'testnet',
  settlement: null,
  rails: [],
  payRail: null,
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
  scans: new Map(), // rail name -> { key, low, high, coveredFromMs, transfers, calls, tsCache }
  scanErrors: new Map(), // rail name -> message
  scanProgress: new Map(), // rail name -> text
  scanBusy: false,
  check: null, // combineChecks() over the rails that must be checked
  pending: new Map(), // task id -> { hash, state, rail }
  sending: false,
  payMsg: null,
  cap: loadCap(),
  capMsg: null,
  filter: 'all',
  proofMsg: null,
  proofFallback: null,
  xmbl: freshXmbl(), // XMBL sealed release (testnet only)
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
const tokenAmount = (atomic, rail) => `${formatAtomic(atomic, rail?.decimals ?? 6)} ${rail?.symbol ?? ''}`.trim();
const railByName = (name) => state.rails.find((r) => r.name === name) || null;
const api = () => SIDES[state.side].api;
const eth = () => window.ethereum;

// Mainnet checks every rail before paying, so nothing is paid twice across
// chains. Testnet checks only the rail you pay on.
const checkRails = () => (state.side === 'mainnet' ? state.rails : state.payRail ? [state.payRail] : []);

// ---------------------------------------------------------------- cap (mainnet only, one total across rails)

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
const capUnit = () => [...new Set(state.rails.map((r) => r.symbol))].join('+') || 'USDC';

// ---------------------------------------------------------------- loading

async function loadSide(side) {
  state.side = side;
  state.settlement = null; state.rails = []; state.payRail = null; state.railError = null;
  state.projects = null; state.projectsError = null;
  state.xmbl = freshXmbl();
  clearProject();
  render();
  try {
    state.settlement = await getSettlement(api());
    state.rails = railsForSide(side, state.settlement); // throws unless handoff's rails load, so app rails never stand alone
    state.payRail = state.rails.find((r) => r.name === pickRail(state.settlement).name) || state.rails[0];
  } catch (e) {
    state.rails = []; state.payRail = null;
    state.railError = `Couldn't load the payment rails from ${api()}/config/settlement: ${e.message}`;
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
  resetScans();
}

function resetScans() {
  state.scans = new Map(); state.scanErrors = new Map(); state.scanProgress = new Map(); state.check = null;
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
  if (!state.payRail) { state.projectError = 'The payment rails aren\'t loaded yet.'; render(); return; }
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
  if (!state.project || !state.payRail) { state.rows = []; return; }
  state.rows = buildRows({ request: state.project, tasks: state.tasks, agents: state.agents, receipts: state.receipts, payRail: state.payRail, rails: state.rails });
  recomputeCheck();
}

function recomputeCheck() {
  state.check = state.scans.size ? combineChecks({ rows: state.rows, scans: state.scans, rails: checkRails(), handoffTxs: state.handoffTxs }) : null;
}

function setHash() {
  const p = new URLSearchParams({ side: state.side });
  if (state.project) p.set('project', state.project.id);
  if (state.payRail && state.settlement && state.payRail.name !== pickRail(state.settlement).name) p.set('network', state.payRail.name);
  history.replaceState(null, '', `#${p}`);
}

function selectPayRail(name) {
  const rail = railByName(name);
  if (!rail || rail === state.payRail) return;
  state.payRail = rail;
  state.payMsg = null;
  rebuildRows(); // candidates don't depend on the pay rail, so mainnet checks stay valid
  setHash();
  render();
  (async () => {
    if (state.wallet.account) await switchChain();
    if (canScan()) checkPayments({ back: true }); // testnet checks the newly chosen rail
  })();
}

// ---------------------------------------------------------------- wallet

function walletError(e) {
  const code = e?.code ?? e?.data?.originalError?.code;
  if (code === 4001) return 'You declined the request in your wallet.';
  if (code === -32002) return 'Your wallet already has a request waiting. Open the wallet to answer it.';
  return e?.message || String(e);
}

const onPayChain = () => state.wallet.account && state.payRail && state.wallet.chainId === state.payRail.chainId;
const candidates = () => state.rows.filter((r) => r.candidate);
const canScan = () => !!(state.wallet.account && state.project && candidates().length && checkRails().length);

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
  if (!sameAddress(account, state.wallet.account)) resetScans();
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
  });
}

async function ensureChain() {
  const rail = state.payRail;
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
  if (canScan() && !state.check) checkPayments({ back: true });
}

// ---------------------------------------------------------------- reading payments from the chains

// One round on every rail that must be checked (in parallel): pick up new
// blocks since the last check, then (when `back`) extend the checked range back
// toward the oldest unpaid verification, at most ROUND_CALLS queries per rail.
// Scans read the rails' public RPCs, so the wallet can be on any chain.
async function checkPayments({ back = true } = {}) {
  if (state.scanBusy || !canScan()) return;
  const payer = state.wallet.account;
  const projectId = state.project.id;
  const cands = candidates();
  const tos = [...new Set(cands.map((r) => r.wallet.toLowerCase()))].sort();
  const oldest = Math.min(...cands.map((r) => r.verifiedAt));
  const rails = checkRails();
  state.scanBusy = true; state.scanErrors = new Map(); state.scanProgress = new Map();
  render();
  await Promise.all(rails.map((rail) => scanRail(rail, { payer, projectId, tos, oldest, back })));
  state.scanBusy = false; state.scanProgress = new Map();
  if (sameAddress(state.wallet.account, payer) && state.project?.id === projectId) recomputeCheck();
  render();
}

async function scanRail(rail, { payer, projectId, tos, oldest, back }) {
  const key = `${payer.toLowerCase()}|${rail.name}|${projectId}|${tos.join(',')}`;
  const rpc = makeRpc(rail.rpcUrl);
  const show = (text) => { state.scanProgress.set(rail.name, text); progress(); };
  try {
    show('reading the latest block…');
    let scan = state.scans.get(rail.name);
    if (scan?.key !== key) scan = null;
    const latest = await latestBlock(rpc);
    let doBack = back;
    if (!scan) {
      scan = { key, low: latest + 1, high: latest, coveredFromMs: null, transfers: [], calls: 0, tsCache: new Map() };
      doBack = true;
    } else if (latest > scan.high) {
      const r = await scanTransfers({ rpc, rail, from: payer, tos, fromBlock: scan.high + 1, toBlock: latest, timestampCache: scan.tsCache, onProgress: ({ calls }) => show(`new blocks, ${calls} call${calls === 1 ? '' : 's'}`) });
      scan.transfers.push(...r.transfers);
      scan.calls += r.calls;
      scan.high = latest;
    }
    if (doBack && (scan.coveredFromMs == null || scan.coveredFromMs > oldest)) {
      show('finding where to start…');
      const stop = await blockAtOrBefore(rpc, Math.floor(oldest / 1000), latest, scan.tsCache);
      if (stop < scan.low) {
        const r = await scanTransfers({
          rpc, rail, from: payer, tos, fromBlock: stop, toBlock: scan.low - 1, maxCalls: ROUND_CALLS, timestampCache: scan.tsCache,
          onProgress: ({ low, fromBlock, toBlock, calls }) => show(`${Math.round((100 * (toBlock - low + 1)) / (toBlock - fromBlock + 1))}% of ${(toBlock - fromBlock + 1).toLocaleString()} blocks, ${calls} call${calls === 1 ? '' : 's'}`),
        });
        scan.transfers.push(...r.transfers);
        scan.calls += r.calls;
        if (r.low < scan.low) {
          scan.low = r.low;
          scan.coveredFromMs = (await blockTimestamp(rpc, r.low, scan.tsCache)) * 1000;
        }
      }
    }
    if (sameAddress(state.wallet.account, payer) && state.project?.id === projectId) state.scans.set(rail.name, scan);
  } catch (e) {
    state.scanErrors.set(rail.name, `Couldn't read your ${rail.symbol} transfers on ${rail.label} (${new URL(rail.rpcUrl).host}): ${e.message}. Tasks stay unchecked, so nothing can be paid until this works; try again in a moment.`);
  }
  state.scanProgress.delete(rail.name);
}

function progress() {
  const el = document.getElementById('scan-progress');
  if (!el) return;
  el.textContent = [...state.scanProgress].map(([name, text]) => `${railByName(name)?.label ?? name}: ${text}`).join(' · ');
}

// ---------------------------------------------------------------- paying

async function pay(row) {
  if (state.sending) return;
  state.sending = true; // lock every Pay button before the first await
  state.payMsg = null;
  render();
  const rail = state.payRail;
  const amount = row.amountAtomic;
  let reserved = 0n;
  let pending = null;
  try {
    const accounts = await eth().request({ method: 'eth_accounts' });
    if (!sameAddress(accounts?.[0], state.wallet.account)) throw new Error('Your wallet account changed since the last check. Check payments again before paying.');
    const chain = Number.parseInt(await eth().request({ method: 'eth_chainId' }), 16);
    if (chain !== rail.chainId) throw new Error(`Your wallet is on chain ${chain}. Switch it to ${rail.label} first.`);

    // Re-read every rail right before paying, in case this task was paid elsewhere since the last check.
    if (state.scanBusy) throw new Error('A payment check is running. Wait for it to finish, then pay.');
    await checkPayments({ back: false });
    if (state.scanErrors.size) throw new Error('Couldn\'t re-read every rail just now, so nothing was sent. Try again in a moment.');
    const status = rowStatus(row, state.check);
    if (!state.rows.includes(row) || state.payRail !== rail || !state.check
      || !(row.payable && status.kind === 'unpaid' && status.checked) || state.pending.has(row.id)) {
      throw new Error('This task isn\'t confirmed unpaid on every rail, so nothing was sent.');
    }
    if (capApplies()) {
      const c = checkCap({ cap: state.cap.cap, spent: state.cap.spent, amount, decimals: rail.decimals, unit: capUnit() });
      if (!c.ok) throw new Error(`Refused: ${c.reason} Raise the cap only if you mean to.`);
    }
    if (!isAddress(rail.token) || !isAddress(row.wallet)) throw new Error('The token or worker address is missing, so nothing was sent.');
    const ok = window.confirm(
      `Send ${tokenAmount(amount, rail)} on ${rail.label}\n`
      + `to ${row.worker} (${row.wallet})\n`
      + `for "${row.title.slice(0, 120)}"?\n`
      + (row.payNote ? `This is ${row.payNote}.\n` : '')
      + `\nFrom your wallet ${state.wallet.account}. Your wallet will ask you to confirm again.`,
    );
    if (!ok) return;

    const data = encodeTransfer(row.wallet, amount);
    if (capApplies()) { reserved = toCapUnits(amount, rail.decimals); state.cap.spent += reserved; saveCap(); } // before the wallet can broadcast
    render();
    const hash = await eth().request({ method: 'eth_sendTransaction', params: [{ from: state.wallet.account, to: rail.token, data, value: '0x0' }] });
    pending = { hash: isTxHash(hash) ? hash : null, state: 'waiting', rail: rail.name };
    state.pending.set(row.id, pending);
  } catch (e) {
    if (reserved) { state.cap.spent -= reserved; saveCap(); reserved = 0n; }
    state.payMsg = { kind: 'error', text: walletError(e) };
  } finally {
    if (!pending) { state.sending = false; render(); }
  }
  if (!pending) return;

  state.payMsg = { kind: 'info', text: `Sent. Waiting for ${rail.label} to include it…` };
  render();
  const receipt = pending.hash ? await waitForReceipt([makeRpc(rail.rpcUrl), walletRpc(eth())], pending.hash) : null;
  if (!receipt) {
    pending.state = 'timeout';
    state.payMsg = { kind: 'warn', text: 'The payment hasn\'t confirmed yet. Follow the transaction link; this task stays locked so it can\'t be paid twice.' };
  } else if (receipt.status === '0x1') {
    pending.state = 'mined';
    state.payMsg = { kind: 'ok', text: `Confirmed on ${rail.label} in block ${Number(BigInt(receipt.blockNumber)).toLocaleString()}.` };
  } else {
    pending.state = 'reverted';
    if (reserved) { state.cap.spent -= reserved; saveCap(); }
    state.payMsg = { kind: 'error', text: 'The transaction failed on chain (reverted), so nothing moved. You can try again.' };
  }
  state.sending = false;
  render();
  if (pending.state === 'mined') await checkPayments({ back: false });
}

// ---------------------------------------------------------------- proof

async function copyProof() {
  const text = proofText({ side: state.side, rails: state.rails, project: state.project, payer: state.wallet.account, rows: state.rows, check: state.check });
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
  root.replaceChildren(...[railSection(), walletSection(), projectSection(), ...resultsSection(), xmblSection()].filter(Boolean));
  progress();
}

function railSection() {
  const title = h('h2', { text: state.rails.length > 1 ? 'Payment rails' : 'Payment rail' });
  if (state.railError) return h('section', { class: 'card' }, title, msg('error', state.railError), h('button', { class: 'btn', type: 'button', onclick: () => loadSide(state.side) }, 'Try again'));
  if (!state.payRail) return h('section', { class: 'card' }, title, h('p', { class: 'muted' }, 'Loading the rails from handoff…'));
  const list = h('ul', { class: 'rails' }, state.rails.map((r) => h('li', {},
    h('div', {}, h('b', {}, r.label), ` · chain ${r.chainId} · ${r.symbol}${r.testnet ? ' · test money' : ''}`,
      r.source === 'app' ? h('span', { class: 'tag' }, 'added by this app') : h('span', { class: 'tag muted-tag' }, 'from handoff')),
    h('div', { class: 'small muted' }, h('span', { class: 'mono' }, r.token),
      r.source === 'app' ? ' · handoff doesn\'t settle or watch this chain; the app reads it itself' : ''))));
  const picker = state.rails.length > 1
    ? h('div', { class: 'row', style: 'margin-top:10px' },
      h('label', { class: 'small muted', for: 'payrail' }, 'Pay with'),
      h('select', { id: 'payrail', style: 'width:auto', onchange: (e) => selectPayRail(e.target.value) },
        state.rails.map((x) => h('option', { value: x.name, selected: x.name === state.payRail.name }, `${x.symbol} on ${x.label}`))))
    : null;
  const note = state.side === 'mainnet' && state.rails.length > 1
    ? h('p', { class: 'small muted', style: 'margin:8px 0 0' }, 'Before any Pay button appears, your payments on every rail above are checked, so a task is never paid twice.')
    : null;
  return h('section', { class: 'card' }, title, list, picker, note);
}

function walletSection() {
  const w = state.wallet;
  const parts = [h('h2', { text: 'Your wallet' })];
  if (!w.account) {
    parts.push(h('div', { class: 'row' },
      h('p', { class: 'grow muted' }, 'Connect the wallet you pay from. The app reads your past stablecoin transfers to see what you already paid.'),
      h('button', { class: 'btn primary', type: 'button', disabled: w.busy || !state.payRail, onclick: connectWallet }, w.busy ? 'Connecting…' : 'Connect wallet')));
  } else {
    const right = onPayChain();
    parts.push(h('div', { class: 'row' },
      h('div', { class: 'grow' }, h('span', { class: 'mono' }, w.account), h('div', { class: 'small muted' }, right ? `on ${state.payRail.label}` : `on chain ${w.chainId ?? '?'}; paying needs ${state.payRail?.label ?? 'the pay rail'}`)),
      right ? null : h('button', { class: 'btn primary', type: 'button', onclick: switchChain }, `Switch to ${state.payRail?.label ?? 'the rail'}`)));
  }
  if (w.error) parts.push(msg('error', w.error));
  parts.push(capBlock());
  return h('section', { class: 'card' }, parts);
}

function capBlock() {
  if (!capApplies()) return h('p', { class: 'small muted', style: 'margin:10px 0 0' }, 'No spending cap on testnet (test money). Mainnet has one session cap.');
  const { cap, spent } = state.cap;
  const left = cap > spent ? cap - spent : 0n;
  const unit = capUnit();
  const input = h('input', { type: 'text', inputmode: 'decimal', placeholder: 'New cap in dollars', 'aria-label': 'New session cap in dollars', autocomplete: 'off' });
  const setCap = () => {
    try {
      const v = toAtomic(input.value, CAP_DECIMALS);
      state.cap.cap = v;
      saveCap();
      state.capMsg = { kind: 'ok', text: `Session cap set to ${formatAtomic(v, CAP_DECIMALS)} ${unit}.` };
    } catch (e) {
      state.capMsg = { kind: 'error', text: `Type an amount like 0.50 (${e.message}).` };
    }
    render();
  };
  return h('div', { id: 'cap', style: 'margin-top:12px' },
    h('div', { class: 'stats' },
      h('span', {}, 'Session cap ', h('b', {}, `${formatAtomic(cap, CAP_DECIMALS)} ${unit}`)),
      h('span', {}, 'spent ', h('b', {}, formatAtomic(spent, CAP_DECIMALS))),
      h('span', {}, 'left ', h('b', {}, formatAtomic(left, CAP_DECIMALS)))),
    h('p', { class: 'small muted' }, `One total for every mainnet rail (${unit.replace('+', ' and ')} count dollar for dollar). Any payment that would go over it is refused. To change it, type a new number.`),
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
      h('button', { class: 'btn primary', type: 'submit', disabled: !!state.loading || !state.payRail }, 'Load')),
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
  const s = rowStatus(row, state.check);
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
  out.push(h('section', { class: 'card' },
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
    state.proofFallback ? h('textarea', { class: 'proof', readonly: true, 'aria-label': 'Payment proof' }, state.proofFallback) : null));

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
  if (!candidates().length) return h('p', { class: 'small muted', style: 'margin-top:8px' }, 'None of these tasks can be paid from your wallet here, so there is nothing to check on chain.');
  const rails = checkRails();
  const parts = [];
  if (!state.wallet.account) parts.push(h('p', { class: 'small muted' }, 'Connect your wallet to see which of these you already paid. Until then, "unpaid" means handoff hasn\'t paid it, not that you haven\'t.'));
  const lines = rails.map((rail) => {
    const s = state.scans.get(rail.name);
    if (!s) return null;
    const mine = s.transfers.length;
    return h('li', {}, h('b', {}, rail.label), `: blocks ${s.low.toLocaleString()}–${s.high.toLocaleString()}`,
      s.coveredFromMs != null ? ` (back to ${when(s.coveredFromMs)})` : '',
      `, ${s.calls} quer${s.calls === 1 ? 'y' : 'ies'}, ${mine} ${rail.symbol} transfer${mine === 1 ? '' : 's'} to these workers`);
  }).filter(Boolean);
  if (lines.length) parts.push(h('p', { class: 'small', style: 'margin-bottom:4px' }, rails.length > 1 ? 'Checked your payments on every rail:' : 'Checked your payments:'), h('ul', { class: 'small checked' }, lines));
  const unchecked = statuses.filter(([, s]) => s.kind === 'unchecked').length;
  if (state.check) {
    parts.push(h('p', { class: 'small' },
      `${state.check.match.size} task${state.check.match.size === 1 ? '' : 's'} matched to your transfers.`,
      state.check.handoffOwned ? ` ${state.check.handoffOwned} transfer${state.check.handoffOwned === 1 ? ' was' : 's were'} handoff's own payout${state.check.handoffOwned === 1 ? '' : 's'} and ${state.check.handoffOwned === 1 ? "doesn't" : "don't"} count.` : '',
      unchecked ? ` ${unchecked} task${unchecked === 1 ? ' is' : 's are'} not checked on every rail back to ${unchecked === 1 ? 'its' : 'their'} verification yet, so ${unchecked === 1 ? 'it' : 'they'} can't be paid until you check further back.` : ''));
  }
  const label = !state.check ? 'Check my payments' : unchecked ? 'Check further back' : 'Check again';
  parts.push(h('div', { class: 'row' },
    h('button', { class: 'btn', type: 'button', disabled: state.scanBusy || !canScan(), onclick: () => checkPayments({ back: true }) }, state.scanBusy ? 'Checking…' : label),
    h('span', { id: 'scan-progress', class: 'small muted' })));
  for (const [name, text] of state.scanErrors) parts.push(msg('error', railByName(name) ? text : `${name}: ${text}`));
  return h('div', { style: 'margin-top:8px' }, parts);
}

function taskCard(row, s) {
  const payRail = state.payRail;
  const facts = h('dl', { class: 'facts' },
    h('dt', {}, 'Worker'),
    h('dd', {}, row.worker ?? 'none assigned', row.wallet ? h('span', { class: 'mono muted', title: row.wallet }, ` · ${row.wallet}`) : null,
      row.custodial ? h('span', { class: 'muted' }, ' · custodial') : null),
    h('dt', {}, 'Amount'),
    h('dd', {}, row.amountText != null ? `${row.amountText} ${row.priceCurrency}` : 'unreadable', row.onlyRail ? h('span', { class: 'muted' }, ` · on ${railByName(row.onlyRail)?.label ?? row.onlyRail} only`) : null),
    h('dt', {}, 'Verified'),
    h('dd', {}, `by ${row.verifier ?? 'unknown'}${row.viaRequester ? ' (requester)' : ''} · ${when(row.verifiedAt)}`),
    h('dt', {}, 'Task'),
    h('dd', {}, h('span', { class: 'mono' }, row.id)));

  const actions = [];
  if (s.kind === 'wallet') {
    const rail = railByName(s.transfer.rail);
    actions.push(link(rail ? explorerTxUrl(rail.explorer, s.tx) : null, `View your payment on ${rail?.label ?? s.transfer.rail} ↗`),
      h('span', { class: 'small muted' }, `${tokenAmount(s.transfer.amount, rail)} on ${when(s.transfer.timestamp * 1000)}`));
  } else if (s.kind === 'handoff') {
    actions.push(s.url ? link(s.url, 'View handoff\'s payout ↗') : h('span', { class: 'small muted' }, `handoff marks it paid${row.handoffPaid.receiptId ? ` (receipt ${row.handoffPaid.receiptId})` : ''}; the tx isn't in its public feed.`));
  } else if (s.kind === 'pending') {
    const rail = railByName(s.pending.rail);
    actions.push(h('span', { class: 'small' }, s.pending.state === 'mined' ? `Confirmed on ${rail?.label ?? 'chain'}.` : s.pending.state === 'timeout' ? 'Not confirmed yet.' : 'Waiting for confirmation…'),
      link(rail ? explorerTxUrl(rail.explorer, s.pending.hash) : null, 'View transaction ↗'));
  } else if (s.kind === 'unpaid') {
    if (s.checked && row.payable) {
      let reason = null;
      if (state.sending) reason = 'Another payment is in progress.';
      else if (!onPayChain()) reason = `Switch your wallet to ${payRail.label}.`;
      else if (capApplies() && !checkCap({ cap: state.cap.cap, spent: state.cap.spent, amount: row.amountAtomic, decimals: payRail.decimals }).ok) reason = 'This would go over your session cap.';
      actions.push(h('button', { class: 'btn primary pay', type: 'button', disabled: !!reason, onclick: () => pay(row) },
        `Pay ${tokenAmount(row.amountAtomic, payRail)}`,
        row.payNote ? h('span', { class: 'btn-note' }, row.payNote) : null));
      if (reason) actions.push(h('span', { class: 'small muted' }, reason));
    } else {
      actions.push(h('span', { class: 'small muted' }, state.wallet.account ? 'Check your payments to pay this.' : 'Connect a wallet to check and pay.'));
    }
  } else if (s.kind === 'unchecked') {
    actions.push(h('span', { class: 'small muted' }, 'Verified before the checked range on at least one rail. Use "Check further back" first.'));
  } else if (s.kind === 'none') {
    actions.push(h('span', { class: 'small muted' }, 'The task\'s amount is 0.'));
  }
  const failedBefore = state.pending.get(row.id)?.state === 'reverted';
  const flags = s.kind === 'handoff' || s.kind === 'wallet' ? [] : [...row.blocks, ...row.railBlocks.map((b) => `On ${payRail.label}: ${b}`)];

  return h('li', { class: `task${s.kind === 'blocked' ? ' is-blocked' : ''}` },
    h('div', { class: 'task-head' }, h('h3', {}, row.title), h('span', { class: `pill ${s.kind}` }, LABEL[s.kind])),
    facts,
    flags.length ? h('ul', { class: 'flags' }, flags.map((b) => h('li', {}, b))) : null,
    failedBefore ? msg('warn', 'Your last payment for this task reverted.') : null,
    actions.length ? h('div', { class: 'actions' }, actions) : null);
}

// ---------------------------------------------------------------- XMBL sealed release (testnet only)
//
// The one place this app involves a private key outside the requester's wallet: the handoff broker
// mints a one-time EVM key and seals it to the worker's Cubic-LWE key. The page never sees that key.
// It checks the broker's response, the worker's own address check, funds the one-time address with
// exactly the amount plus gas (two confirmed transactions), then shows both Transfer legs.

const xmblRail = () => (state.side === 'testnet' ? state.rails.find((r) => r.chainId === XMBL_CHAIN_ID) || null : null);
const xmblReady = () => !!(state.xmbl.seal?.ok && state.xmbl.check?.ok && onPayChain() && state.payRail?.chainId === XMBL_CHAIN_ID);
const fmtEth = (wei) => `${Number(wei) / 1e18} ETH`;

async function xmblReadAddress() {
  const x = state.xmbl;
  const rail = xmblRail();
  if (!x.seal?.ok || !rail) return;
  x.fundError = null; x.busy = true; render();
  try {
    const rpc = makeRpc(rail.rpcUrl);
    const a = x.seal.fund.address;
    const [ethHex, nonceHex, balHex] = await Promise.all([
      rpc('eth_getBalance', [a, 'latest']),
      rpc('eth_getTransactionCount', [a, 'latest']),
      rpc('eth_call', [{ to: rail.token, data: encodeBalanceOf(a) }, 'latest']),
    ]);
    const fund = { usdc: BigInt(balHex && balHex !== '0x' ? balHex : '0x0'), eth: BigInt(ethHex), nonce: Number(BigInt(nonceHex)), at: Date.now() };
    fund.step = fundingStep({ ...fund, amountAtomic: x.seal.fund.amountAtomic });
    x.fund = fund;
  } catch (e) {
    x.fundError = `Couldn't read the one-time address from ${new URL(rail.rpcUrl).host}: ${e.message}`;
  }
  x.busy = false; render();
}

async function xmblFund(kind) {
  const x = state.xmbl;
  if (state.sending) return;
  state.sending = true; x.msg = null; render();
  const rail = xmblRail();
  try {
    if (!rail || !xmblReady()) throw new Error('Check the seal response and the worker\'s line, and connect your wallet on Base Sepolia first.');
    const accounts = await eth().request({ method: 'eth_accounts' });
    if (!sameAddress(accounts?.[0], state.wallet.account)) throw new Error('Your wallet account changed. Reconnect it first.');
    const chain = Number.parseInt(await eth().request({ method: 'eth_chainId' }), 16);
    if (chain !== rail.chainId) throw new Error(`Your wallet is on chain ${chain}. Switch it to ${rail.label} first.`);
    await xmblReadAddress(); // read the address again right before sending
    const want = kind === 'usdc' ? 'fund-usdc' : 'fund-gas';
    if (x.fund?.step.step !== want) throw new Error(x.fund?.step.reason || `The one-time address isn't at this step (it's at "${x.fund?.step.step ?? 'unknown'}").`);
    const to = x.seal.fund.address;
    const what = kind === 'usdc' ? `${x.seal.fund.amountText} USDC` : `${fmtEth(XMBL_GAS_WEI)} for the sweep's gas`;
    const ok = window.confirm(`Send ${what} on ${rail.label}\nto the one-time address ${to}?\n\n${XMBL_LABEL}\n\nThe worker's check line named this address. From your wallet ${state.wallet.account}.`);
    if (!ok) return;
    const tx = kind === 'usdc'
      ? { from: state.wallet.account, to: rail.token, data: encodeTransfer(to, x.seal.fund.amountAtomic), value: '0x0' }
      : { from: state.wallet.account, to, value: `0x${XMBL_GAS_WEI.toString(16)}` };
    if (!isAddress(tx.to)) throw new Error('The destination address is missing, so nothing was sent.');
    const hash = await eth().request({ method: 'eth_sendTransaction', params: [tx] });
    x.sent[kind] = hash;
    x.msg = { kind: 'info', text: `Sent. Waiting for ${rail.label} to confirm it before the next step…` };
    render();
    const receipt = isTxHash(hash) ? await waitForReceipt([makeRpc(rail.rpcUrl), walletRpc(eth())], hash) : null;
    if (!receipt) x.msg = { kind: 'warn', text: 'Not confirmed yet. Don\'t send the next step until it confirms; follow the link.' };
    else if (receipt.status === '0x1') {
      x.msg = { kind: 'ok', text: `${kind === 'usdc' ? 'USDC' : 'Gas'} confirmed in block ${Number(BigInt(receipt.blockNumber)).toLocaleString()}.` };
      if (kind === 'usdc') x.fundBlock = Number(BigInt(receipt.blockNumber));
    } else x.msg = { kind: 'error', text: 'The transaction reverted, so nothing moved.' };
  } catch (e) {
    x.msg = { kind: 'error', text: walletError(e) };
  } finally {
    state.sending = false;
  }
  await xmblReadAddress();
}

async function xmblLegs() {
  const x = state.xmbl;
  const rail = xmblRail();
  x.legsBusy = true; x.legsError = null; x.proofMsg = null; render();
  try {
    if (!state.wallet.account) throw new Error('Connect the wallet that funded the one-time address.');
    const rpc = makeRpc(rail.rpcUrl);
    const latest = await latestBlock(rpc);
    const from = x.fundBlock ?? Math.max(0, latest - LEG_WINDOW);
    const one = await scanTransfers({ rpc, rail, from: state.wallet.account, tos: [x.seal.fund.address], fromBlock: from, toBlock: latest });
    const leg1 = one.transfers[0] || null;
    const worker = isAddress(x.worker) ? x.worker : null;
    const two = await scanTransfers({ rpc, rail, from: x.seal.fund.address, tos: worker ? [worker] : [], fromBlock: leg1 ? leg1.blockNumber : from, toBlock: latest });
    x.legs = { leg1, leg2: two.transfers[0] || null, fromBlock: from, toBlock: latest, calls: one.calls + two.calls };
  } catch (e) {
    x.legsError = `Couldn't read the legs from ${new URL(rail.rpcUrl).host}: ${e.message}`;
  }
  x.legsBusy = false; render();
}

async function xmblCopyProof() {
  const x = state.xmbl;
  const text = xmblProofText({ seal: x.seal, requester: state.wallet.account, worker: x.worker, leg1: x.legs?.leg1, leg2: x.legs?.leg2, explorer: xmblRail().explorer });
  try { await navigator.clipboard.writeText(text); x.proofMsg = 'Proof copied.'; } catch { x.proofMsg = text; }
  render();
}

function xmblSection() {
  if (state.side !== 'testnet') return null; // never on mainnet
  const x = state.xmbl;
  const head = h('div', { class: 'row' },
    h('h2', { class: 'grow', style: 'margin:0' }, 'XMBL sealed release (testnet)'),
    h('button', { class: 'btn', type: 'button', id: 'xmbl-toggle', onclick: () => { x.open = !x.open; render(); } }, x.open ? 'Hide' : 'Show'));
  if (!x.open) {
    return h('section', { class: 'card', id: 'xmbl' }, head,
      h('p', { class: 'small muted', style: 'margin:6px 0 0' }, 'Pay one task through a one-time key the handoff broker seals to the worker. Experimental; testnet only.'));
  }
  const rail = xmblRail();
  const parts = [head, msg('warn', h('span', { id: 'xmbl-label' }, XMBL_LABEL))];
  if (!rail) return h('section', { class: 'card', id: 'xmbl' }, ...parts, msg('error', 'Base Sepolia isn\'t in handoff\'s settlement config, so this mode is unavailable.'));
  parts.push(h('p', { class: 'small' }, 'Unlike the rest of this app, this mode involves a private key outside your wallet: the broker minted a one-time key and saw it. Only the worker can open the sealed envelope. Fund a fresh address once, with exactly the amount plus a little gas, and never reuse it.'));

  // 1. the broker's response
  const sealBox = h('textarea', { class: 'proof', id: 'xmbl-seal', 'aria-label': 'Seal response JSON', placeholder: '{ "claim_id": …, "fund_here": { … }, "seal": { … } }', oninput: (e) => { x.sealText = e.target.value; } }, x.sealText);
  parts.push(h('h3', { class: 'step' }, '1. The broker\'s seal response'),
    h('p', { class: 'small muted' }, 'Paste the JSON that request-seal --live saved (the requester signs that request as a handoff agent).'),
    sealBox,
    h('div', { class: 'row', style: 'margin-top:6px' }, h('button', { class: 'btn', type: 'button', id: 'xmbl-check-seal', onclick: () => { x.seal = parseSealResponse(x.sealText); x.check = x.checkText ? parseCheckLine(x.checkText, x.seal) : null; x.fund = null; render(); } }, 'Check response')));
  if (x.seal) {
    if (!x.seal.ok) parts.push(msg('error', h('ul', { class: 'plain' }, x.seal.errors.map((e) => h('li', {}, e)))));
    else {
      parts.push(h('dl', { class: 'facts', id: 'xmbl-fields' },
        h('dt', {}, 'Claim'), h('dd', {}, h('span', { class: 'mono' }, x.seal.claimId)),
        h('dt', {}, 'One-time address'), h('dd', {}, h('span', { class: 'mono' }, x.seal.fund.address)),
        h('dt', {}, 'Amount'), h('dd', {}, `${x.seal.fund.amountText} USDC on Base Sepolia, plus ${fmtEth(XMBL_GAS_WEI)} for gas`),
        h('dt', {}, 'Sealed to'), h('dd', {}, h('span', { class: 'mono' }, x.seal.receiver)),
        h('dt', {}, 'XMBL record'), h('dd', {}, `${x.seal.type6 ?? 'none'}${x.seal.submitted === false ? ' (submitted: false)' : ''}`)));
      for (const n of x.seal.notes) parts.push(h('p', { class: 'small muted' }, n));
    }
  }

  // 2. the worker's own address check
  parts.push(h('h3', { class: 'step' }, '2. The worker\'s address check'),
    h('p', { class: 'small muted' }, 'The worker runs claim-and-check before you fund anything. It opens the seal and confirms the released key controls the one-time address. Paste the line it printed. The line is the worker\'s own report, not a proof; checking it here catches a line for another claim or address.'),
    h('input', { type: 'text', id: 'xmbl-line', value: x.checkText, placeholder: 'xmbl-check OK settlement=… claim=… fund=0x… receiver=xmb…', 'aria-label': 'Worker check line', oninput: (e) => { x.checkText = e.target.value; } }),
    h('div', { class: 'row', style: 'margin-top:6px' }, h('button', { class: 'btn', type: 'button', id: 'xmbl-check-line', onclick: () => { x.check = parseCheckLine(x.checkText, x.seal); render(); } }, 'Check line')));
  if (x.check) parts.push(x.check.ok ? msg('ok', `The worker confirmed the key controls ${x.check.fund}${x.seal?.ok ? ', the address in this response.' : '.'}`) : msg('error', h('ul', { class: 'plain' }, x.check.errors.map((e) => h('li', {}, e)))));

  // 3. fund
  parts.push(h('h3', { class: 'step' }, '3. Fund the one-time address'),
    h('label', { class: 'field', for: 'xmbl-worker' }, 'Worker wallet (where the worker sweeps to; used to find leg 2)'),
    h('input', { type: 'text', id: 'xmbl-worker', value: x.worker, placeholder: '0x…', oninput: (e) => { x.worker = e.target.value.trim(); } }));
  const needs = [];
  if (!x.seal?.ok) needs.push('a checked seal response');
  if (!x.check?.ok) needs.push('the worker\'s matching check line');
  if (!state.wallet.account) needs.push('your wallet connected');
  if (state.payRail?.chainId !== XMBL_CHAIN_ID) needs.push('Base Sepolia as the pay rail');
  else if (state.wallet.account && !onPayChain()) needs.push('your wallet on Base Sepolia');
  if (needs.length) parts.push(h('p', { class: 'small muted' }, `Needs ${needs.join(', ')}.`));
  if (state.payRail?.chainId !== XMBL_CHAIN_ID) parts.push(h('button', { class: 'btn', type: 'button', onclick: () => selectPayRail(rail.name) }, `Pay with ${rail.label}`));
  if (x.seal?.ok) {
    const f = x.fund;
    parts.push(h('div', { class: 'row', style: 'margin-top:8px' },
      h('button', { class: 'btn', type: 'button', id: 'xmbl-read', disabled: x.busy, onclick: xmblReadAddress }, x.busy ? 'Reading…' : 'Read the address'),
      f ? h('span', { class: 'small', id: 'xmbl-state' }, `holds ${formatAtomic(f.usdc, 6)} USDC and ${fmtEth(f.eth)}, nonce ${f.nonce}: ${({ 'fund-usdc': 'fresh, ready for step 1', 'fund-gas': 'USDC is there, ready for step 2', funded: 'funded; waiting for the worker to sweep', used: 'already used', unsafe: 'not a state this app funds from' })[f.step.step]}`) : null));
    if (f?.step.reason) parts.push(msg('warn', f.step.reason));
    const ready = xmblReady() && !state.sending;
    parts.push(h('div', { class: 'row', style: 'margin-top:8px' },
      h('button', { class: 'btn primary', type: 'button', id: 'xmbl-fund-usdc', disabled: !(ready && f?.step.step === 'fund-usdc'), onclick: () => xmblFund('usdc') }, `Step 1: send ${x.seal.fund.amountText} USDC`),
      h('button', { class: 'btn primary', type: 'button', id: 'xmbl-fund-gas', disabled: !(ready && f?.step.step === 'fund-gas'), onclick: () => xmblFund('gas') }, `Step 2: send ${fmtEth(XMBL_GAS_WEI)} for gas`)));
    for (const [k, hash] of Object.entries(x.sent)) parts.push(h('p', { class: 'small mono' }, `${k === 'usdc' ? 'USDC' : 'Gas'} transaction: `, link(explorerTxUrl(rail.explorer, hash), hash)));
  }
  if (x.fundError) parts.push(msg('error', x.fundError));
  if (x.msg) parts.push(msg(x.msg.kind, x.msg.text));

  // 4. legs
  if (x.seal?.ok) {
    parts.push(h('h3', { class: 'step' }, '4. Both legs, from Transfer logs'),
      h('p', { class: 'small muted' }, 'No public endpoint proves "task X settled to worker Y". The honest proof is two USDC Transfer legs: you to the one-time address, then the one-time address to the worker.'),
      h('div', { class: 'row' },
        h('button', { class: 'btn', type: 'button', id: 'xmbl-legs', disabled: x.legsBusy, onclick: xmblLegs }, x.legsBusy ? 'Checking…' : 'Check both legs'),
        x.legs ? h('button', { class: 'btn', type: 'button', onclick: xmblCopyProof }, 'Copy proof') : null));
    if (x.legs) {
      const leg = (label, t) => h('li', {}, h('b', {}, label), t ? [` ${formatAtomic(t.amount, 6)} USDC ${t.from} → ${t.to} `, link(explorerTxUrl(rail.explorer, t.txHash), 'tx ↗')] : ' not found yet');
      parts.push(h('ul', { class: 'small checked', id: 'xmbl-leg-list', style: 'overflow-wrap:anywhere' },
        leg('Leg 1, you → one-time address:', x.legs.leg1),
        leg(`Leg 2, one-time address → ${isAddress(x.worker) ? 'worker' : 'anyone'}:`, x.legs.leg2)),
      h('p', { class: 'small muted' }, `Searched blocks ${x.legs.fromBlock.toLocaleString()}–${x.legs.toBlock.toLocaleString()} in ${x.legs.calls} queries.`));
    }
    if (x.legsError) parts.push(msg('error', x.legsError));
    if (x.proofMsg) parts.push(x.proofMsg === 'Proof copied.' ? msg('ok', x.proofMsg) : h('textarea', { class: 'proof', readonly: true }, x.proofMsg));
  }
  return h('section', { class: 'card', id: 'xmbl' }, parts);
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
  if (net && railByName(net)) { state.payRail = railByName(net); render(); }
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
