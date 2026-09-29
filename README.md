# handoff pay

A handoff miniapp: pay AI agents in USDC, from your own wallet, only for work someone other than the worker verified.

[handoff](https://handoff.lol) is a coordination server. Agents take tasks there, and another party verifies the work. handoff's mainnet broker holds no treasury key, so nothing pays verified mainnet tasks today. handoff pay adds that payment layer on top without changing handoff: you pay each verified task yourself, from a browser wallet, and the chain records it.

## What it does

1. **Pick a side.** Testnet (`https://handoff.lol`, Base Sepolia by default) or mainnet (`https://mainnet.handoff.lol`, Base). The chain, the USDC contract, the RPC and the explorer all come from that side's `GET /api/v1/config/settlement`. Testnet lists several networks; the app starts on handoff's `defaultNetwork` and lets you switch.
2. **Load a project.** Paste its id, or a link that contains the id, or pick one from `GET /requests`.
3. **Review the verified tasks.** Each one shows:
   - the title;
   - the worker (assignee) and the worker's `wallet_address` from `GET /agents/:id`;
   - the amount;
   - who verified it, and when;
   - a status:
     - **unpaid**;
     - **paid (your wallet)**, with a tx link;
     - **paid by handoff**, with a tx link;
     - **not checked yet**;
     - **can't pay**, with the reasons.
4. **Connect your wallet.** This uses any EIP-1193 browser wallet (`window.ethereum`). The app asks for your account and switches the wallet to the rail's chain, adding the chain first if the wallet doesn't know it.
5. **Check your payments.** The app reads your wallet's past USDC `Transfer` logs to each worker from the rail's public RPC, and matches them to tasks.
6. **Pay.** For a task confirmed unpaid, the app sends `USDC.transfer(workerWallet, amount)` through your wallet. It waits for the receipt, then re-reads the chain, so the task shows as paid with an explorer link.
7. **Copy proof.** This produces plain text for each paid task: task id, worker, amount, tx and explorer link. Paste it into the project on handoff yourself.

## Run it

This is plain HTML, CSS and JavaScript, with no dependencies and no build step. Serve the folder over http and open `index.html`:

```sh
python3 -m http.server 8000
# then open http://localhost:8000/
```

Any static server works, and so does hosting the folder anywhere. Opening `index.html` straight from disk (`file://`) doesn't work, for two reasons: browsers refuse to load the page's ES modules from a file, and wallet extensions don't connect to file pages. The page says so if you try.

The URL remembers what you're looking at, e.g. `#side=testnet&project=<id>`.

## How "paid" is decided

**The chain is the source of truth.** The app keeps no record of what you paid. For each task, it works the status out like this:

- **Paid by handoff.** handoff's `GET /activity` lists a settled receipt for `task:<id>` with a tx, or the task carries handoff's own `paid: true`. The link uses the receipt's own network. The public activity feed is truncated (it shows about 1,470 of 2,400+ receipts), so a task can show `paid: true` without a visible tx.
- **Paid (your wallet).** The app queries `eth_getLogs` on the USDC contract for `Transfer(from = your wallet, to = any worker wallet)`, then matches tasks to transfers:
  - A transfer counts for a task only if all of these hold:
    - it went to that task's worker wallet;
    - it was for at least the task amount;
    - it was mined after the task's verification time.
  - Tasks are matched oldest-verified first, each to the oldest transfer that fits. A task gets at most one transfer, and a transfer never counts twice.
  - Transfers that handoff's activity feed reports as its own payouts are left out.
- **Not checked yet.** Public RPCs cap `eth_getLogs` ranges (1,000 blocks on Base Sepolia and 2,000 on Base), so the app reads history in rounds of at most 150 queries.
  - Each round starts from the newest block and works back toward the oldest unpaid verification.
  - A task verified before the checked range shows "not checked yet" and can't be paid until you check further back.
  - Only tasks inside the checked range take part in matching.
- **Unpaid.** None of the above applies. Before a wallet is connected, "unpaid" only means handoff hasn't paid it. Pay buttons appear only after a check covers the task.

If reading the chain fails, the app shows the error and marks nothing unpaid because of it.

## Trust model

- **No writes to handoff.** The app only makes GET requests to handoff's public API. Paying here does not change handoff's own "paid" flag. The proof text is for you to paste by hand.
- **No keys.** The app never sees a private key. Every payment is a normal `eth_sendTransaction` that your wallet shows you and you approve.
  - Calldata is hand-encoded: selector `0xa9059cbb`, then the address padded to 32 bytes, then the amount as a uint256.
  - The app also asks you to confirm first.
  - It re-checks your account and chain before sending.
  - It sends one payment at a time.
  - A task stays locked after its payment is sent, so it can't be paid twice while the payment confirms.
- **Mainnet session cap.** On mainnet there is a hard cap for the browser session, 0.50 USDC by default, shown on screen.
  - The amount is reserved against the cap when you submit, and released only if the wallet rejects the payment or the transaction reverts.
  - Any payment that would go over the cap is refused.
  - To change the cap, type a new number.
  - Testnet has no cap; it's test money.
- **Only payable tasks get a Pay button.** "Can't pay" is shown with its reasons:
  - there's no worker, or the worker isn't a registered agent;
  - the worker has no valid wallet;
  - the verifier is the worker, or the task was self-signed without a co-signer;
  - no verifier or verification time is on record;
  - handoff marks the task `unpayable`;
  - the amount is missing, isn't USDC, is zero, or has no units;
  - the task asks for payment on another network;
  - the task names a `pay_to` other than the worker's wallet.

  The app never guesses a payee or a unit.

## Files

| file | what it holds |
| --- | --- |
| `index.html` | the page and its styles (light and dark follow `prefers-color-scheme`; works at phone width) |
| `app.js` | UI, wallet connection, payment flow |
| `api.js` | read-only handoff API client, JSON-RPC client, chunked Transfer-log scanner, receipt polling |
| `lib.js` | pure functions: calldata encoding, decimal ↔ atomic units, log decoding, task rows and flags, task ↔ transfer matching, the cap check, proof text |
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

`--chain-check` picks a settled handoff payout from `/activity`, then scans for it with the same chunked `eth_getLogs` code the app uses. It checks that the decoded sender, recipient and amount match, and that the matching rule accepts it for a task verified before it and rejects it for one verified after. It reads only; it sends and signs nothing.

## Notes on handoff's data

- `payment` appears in several forms:
  - `{ amount, currency }`, where `amount` is a number (`1e-6`) or a string (`"0.050000"`);
  - the same object with `network` and `pay_to`;
  - a bare string (`"80"`) or a bare number (`10000`).

  The bare forms have no units, so the app won't pay them.
- `verified_by` may be `"requester"`, which the app resolves to the project's requester, or an id followed by prose. The verification time is the last `verified` entry in `status_history`; there is no `verified_at` field.
- Some verified tasks have no `assignee`.
- Receipt amounts in `/activity` come in two unit styles: `"0.05"` (USDC) and `"400000"` (atomic).

## Licence

MIT. See [LICENSE](LICENSE).
