# handoff pay

A handoff miniapp: pay AI agents in dollar stablecoins (USDC on Base, USDG on Robinhood Chain), from your own wallet, only for work someone other than the worker verified.

## Hackathon

Entry for the [Colosseum Crypto World's Fair](https://www.colosseum.com/worldsfair) ([rules](https://colosseum.com/legal/Crypto%20World's%20Fair%20Hackathon%20Rules.pdf)).

- **Window:** 2026-09-14 06:00 PT to 2026-10-12 23:59 PT. Only work done in the window is judged, and earlier work must be disclosed.
- **Submission:** product name and description, blockchains and tools used, team, location, logo, this repo (private is fine if hackathon@colosseum.com has access), a 2–3 minute presentation video, a demo video of at most 3 minutes, and go-to-market plans.
- **Prizes:** Grand $30,000; $15,000 to each of the next 20; Public Good $5,000; University $5,000; ecosystem track pools on top, including Base and Robinhood Chain.

### Current request (2026-09-29)

Build further for **Base, Robinhood Chain and XMBL** directly.

- **Base:** Base mainnet USDC is the real-money rail; Base Sepolia is for testing. Both come from handoff's settlement config.
- **Robinhood Chain:** add Robinhood Chain mainnet (chain 4663) as a rail, paying in USDG (`0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168`, 6 decimals), with "paid" proven from USDG Transfer logs. A task priced in USDC and paid in USDG is labelled as such. A task that names its network is payable only there.
- **Across rails:** before a Pay button appears, the requester's payments on every mainnet rail are checked, so a task is never paid twice. The mainnet cap (0.50 by default) is one total across all rails.
- **XMBL:** scope to be decided.

[handoff](https://handoff.lol) is a coordination server. Agents take tasks there, and another party verifies the work. handoff's mainnet broker holds no treasury key, so nothing pays verified mainnet tasks today. handoff pay adds that payment layer on top without changing handoff: you pay each verified task yourself, from a browser wallet, and the chain records it.

## What it does

1. **Pick a side.**
   - **Testnet** (`https://handoff.lol`) uses the rails in handoff's `GET /api/v1/config/settlement`: Base Sepolia by default, plus Arc Testnet and Ethereum Sepolia. It checks and pays on the rail you pick.
   - **Mainnet** (`https://mainnet.handoff.lol`) has two rails:
     - **Base** (USDC), from handoff's settlement config;
     - **Robinhood Chain** (chain 4663, USDG `0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168`, 6 decimals). The app adds this rail itself; handoff doesn't list, settle on or watch this chain.
   - There is no Robinhood testnet rail, because no testnet stablecoin address is published.
   - Each rail records its chain id, name, token address, symbol, decimals, RPC, explorer and log-scan strategy. The rail list is shown on screen, with a "Pay with" picker.
2. **Load a project.** Paste its id, or a link that contains the id, or pick one from `GET /requests`.
3. **Review the verified tasks.** Each one shows:
   - the title;
   - the worker (assignee) and the worker's `wallet_address` from `GET /agents/:id`;
   - the amount and its currency;
   - who verified it, and when;
   - a status:
     - **unpaid**;
     - **paid (your wallet)**, with a tx link on whichever rail paid it;
     - **paid by handoff**, with a tx link;
     - **not checked yet**;
     - **can't pay**, with the reasons.
4. **Connect your wallet.** This uses any EIP-1193 browser wallet (`window.ethereum`). The app asks for your account and switches the wallet to the pay rail's chain, adding the chain first if the wallet doesn't know it.
5. **Check your payments.** The app reads your wallet's past token `Transfer` logs to each worker from each rail's public RPC, and matches them to tasks. On mainnet it checks **every** rail, Base USDC and Robinhood USDG, before any Pay button appears.
6. **Pay.** For a task confirmed unpaid on every rail, the app sends `token.transfer(workerWallet, amount)` on the pay rail through your wallet. It waits for the receipt, then re-reads the chains, so the task shows as paid with an explorer link.
   - A USDC-priced task paid in USDG says **"paid in USDG (task priced in USDC)"** on its Pay button and in the proof.
7. **Copy proof.** This produces plain text for each paid task: task id, worker, amount, token, chain, tx and explorer link. Paste it into the project on handoff yourself.

## Run it

This is plain HTML, CSS and JavaScript, with no dependencies and no build step. Serve the folder over http and open `index.html`:

```sh
python3 -m http.server 8000
# then open http://localhost:8000/
```

Any static server works, and so does hosting the folder anywhere. Opening `index.html` straight from disk (`file://`) doesn't work, for two reasons: browsers refuse to load the page's ES modules from a file, and wallet extensions don't connect to file pages. The page says so if you try.

The URL remembers what you're looking at, e.g. `#side=testnet&project=<id>`.

## How "paid" is decided

**The chains are the source of truth.** The app keeps no record of what you paid. For each task, it works the status out like this:

- **Paid by handoff.** handoff's `GET /activity` lists a settled receipt for `task:<id>` with a tx, or the task carries handoff's own `paid: true`. The link uses the receipt's own network. The public activity feed is truncated (it shows about 1,470 of 2,400+ receipts), so a task can show `paid: true` without a visible tx.
- **Paid (your wallet).** On each rail, the app queries `eth_getLogs` on the rail's token for `Transfer(from = your wallet, to = any worker wallet)`. It then pools the transfers from every checked rail and matches tasks to them:
  - A transfer counts for a task only if all of these hold:
    - it went to that task's worker wallet;
    - it was for at least the task amount, compared after scaling each by its own decimals;
    - it was mined after the task's verification time.
  - Transfers from different chains are ordered by time, since block numbers of different chains can't be compared. Each transfer's time comes from its block, not from the log alone (see the data notes below).
  - Tasks are matched oldest-verified first, each to the oldest transfer that fits. A task gets at most one transfer, and a transfer never counts twice.
  - A payment on **any** rail counts, including for a task that names its network. The network rule limits where the app will pay, not which payments count.
  - Transfers that handoff's activity feed reports as its own payouts are left out.
- **Not checked yet.** The app reads history in rounds of at most 150 `eth_getLogs` calls per rail. Each round starts from the newest block and works back toward the oldest unpaid verification.
  - A task is checked only when **every** rail that must be checked has been read back to its verification time. On mainnet that means Base and Robinhood Chain; on testnet, the rail you pay on.
  - Until then the task shows "not checked yet" and has no Pay button. Only checked tasks take part in matching.
  - If a rail's RPC fails, that rail's tasks stay unchecked and the error is shown. Nothing is marked unpaid because of an error.
- **Unpaid.** None of the above applies. Before a wallet is connected, "unpaid" only means handoff hasn't paid it. Pay buttons appear only after a check covers the task on every rail.

**Scanning adapts to each RPC.** Queries always filter by the Transfer topic and your address as sender, plus the worker addresses where there are any.

- On a range or result-limit error (for example `-32000 … exceeds limit of 10000` or `-32602 … only 10000000 are allowed`), the range shrinks to the stated cap or to half, then retries.
- After two successes in a row, the range doubles again, up to the rail's max.
- Rate limits are retried with backoff, never treated as a reason to shrink.
- The per-rail limits:

| rail | per query | why |
| --- | --- | --- |
| Base | 2,000 blocks | its public RPC's range cap |
| Base Sepolia | 1,000 blocks | its public RPC's range cap |
| Robinhood Chain | up to 10,000,000 blocks (~11.5 days) | its RPC caps blocks per query and 10,000 matching logs, not a small block range |

For a typical payer, two weeks of Robinhood history takes about 2 calls.

## Trust model

- **No writes to handoff.** The app only makes GET requests to handoff's public API. Paying here does not change handoff's own "paid" flag. The proof text is for you to paste by hand.
- **No keys.** The app never sees a private key. Every payment is a normal `eth_sendTransaction` to the pay rail's token contract, which your wallet shows you and you approve.
  - Calldata is hand-encoded: selector `0xa9059cbb`, then the address padded to 32 bytes, then the amount as a uint256.
  - The app also asks you to confirm first.
  - It re-checks your account and chain, re-reads **every** rail, and asserts the token address before sending.
  - It sends one payment at a time.
  - A task stays locked after its payment is sent, even if you switch rails, so it can't be paid twice while the payment confirms.
- **Rails.** handoff's rails come from its settlement config. The app adds one rail of its own, Robinhood Chain USDG, on the mainnet side only.
  - If handoff's config can't be loaded, the side has no rails at all, so a check can never skip a rail handoff knows about.
  - handoff doesn't watch Robinhood Chain. Payments there are proven only by USDG `Transfer` logs, which this app reads.
- **Mainnet session cap.** There is one hard cap for the browser session across every mainnet rail: 0.50 by default, where USDC and USDG count dollar for dollar. It is shown once.
  - The amount is reserved against the cap when you submit, and released only if the wallet rejects the payment or the transaction reverts.
  - Any payment that would go over the cap is refused, whichever rail it's on.
  - To change the cap, type a new number.
  - Testnet has no cap; it's test money.
- **Only payable tasks get a Pay button.** "Can't pay" is shown with its reasons.
  - Task-level reasons, which apply on every rail:
    - there's no worker, or the worker isn't a registered agent;
    - the worker has no valid wallet;
    - the verifier is the worker, or the task was self-signed without a co-signer;
    - no verifier or verification time is on record;
    - handoff marks the task `unpayable`;
    - the amount is missing, isn't in a dollar stablecoin (USDC or USDG), is zero, or has no units;
    - the task names a network that isn't a rail on this side;
    - the task names a `pay_to` other than the worker's wallet.
  - Pay-rail reasons, which apply only on the rail you picked:
    - the task names a different network; a task that names its network is payable only there;
    - the worker's wallet is custodial (`wallet_custodial: true`) and the rail isn't in handoff's settlement config. The reason shown is "custodial wallet; handoff doesn't watch this chain".

  The app never guesses a payee or a unit.

## Files

| file | what it holds |
| --- | --- |
| `index.html` | the page and its styles (light and dark follow `prefers-color-scheme`; works at phone width) |
| `app.js` | UI, wallet connection, payment flow |
| `api.js` | read-only handoff API client, JSON-RPC client with backoff, per-rail Transfer-log scanner, receipt polling |
| `lib.js` | pure functions: the rail registry, calldata encoding, decimal ↔ atomic units, log decoding, the adaptive range walker, task rows and flags, cross-rail task ↔ transfer matching, the cap check, proof text |
| `tests/lib.test.js` | `node:test` unit tests for `lib.js` |
| `scripts/smoke.mjs` | read-only smoke test against the live API |

## Tests

```sh
node --test "tests/**/*.test.js"      # or: npm test (no dependencies to install)
```

The smoke test prints what the app would show for a real project, with no wallet connected:

```sh
node scripts/smoke.mjs --project 2af16779-4c0f-4c93-94b7-6a0281fc6846 --chain-check
```

- **`--chain-check`** picks a settled handoff payout on Base Sepolia from `/activity`, then scans for it with the app's own scanner. It checks that the decoded sender, recipient and amount match, and that the matching rule accepts the payout for a task verified before it and rejects it for one verified after.
- **`--robinhood`** (`node scripts/smoke.mjs --side mainnet --robinhood`) does the same on Robinhood Chain mainnet.
  - It picks a real recent USDG transfer from a quiet sender.
  - It scans the 14 days before it with the app's adaptive scanner, filtered by that sender only.
  - It checks the decoded from, to and amount against the raw log and the transaction receipt, and prints how many calls and blocks it took.
  - It then scans a busy sender over 200,000 blocks, to exercise the result-count halving.

Both only read; neither sends nor signs anything.

## Notes on handoff's data

- `payment` appears in several forms:
  - `{ amount, currency }`, where `amount` is a number (`1e-6`) or a string (`"0.050000"`);
  - the same object with `network` and `pay_to`;
  - a bare string (`"80"`) or a bare number (`10000`).

  The bare forms have no units, so the app won't pay them.
- `verified_by` may be `"requester"`, which the app resolves to the project's requester, or an id followed by prose. The verification time is the last `verified` entry in `status_history`; there is no `verified_at` field.
- Some verified tasks have no `assignee`.
- Receipt amounts in `/activity` come in two unit styles: `"0.05"` (USDC) and `"400000"` (atomic).
- Robinhood Chain's RPC returns `blockTimestamp: "0x0"` on some logs. The app treats a zero or missing log time as unknown and reads the time from the block. It also checks one claimed time per scan against its block, and if that doesn't match, reads every time from its block.
- Almost every worker wallet is custodial. On testnet, 56 of the 58 workers with a wallet have `wallet_custodial: true`; the other two have no `wallet_custodial` field. So most real tasks can be paid on Base but not on Robinhood Chain.

## Licence

MIT. See [LICENSE](LICENSE).
