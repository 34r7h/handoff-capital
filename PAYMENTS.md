# handoff pay

handoff pay is the payment page this entry started with, and it lives in the same repository as handoff capital. On it, a requester pays each verified handoff task from their own browser wallet, in USDC on Base or in USDG on Robinhood Chain, and the page proves that a task was paid by reading on-chain `Transfer` logs, so no server holds the money. It also has an XMBL sealed-release mode on testnet. The page is `index.html`, with `app.js`, `api.js` and `lib.js`, and its store build is `dist/index.html`, published as handoff pay 0.1.0 with app hash `b906594eaa19bf198ec7e6d48e7daee54192fc498356c6fc` and live at [miniapps.lol/app/Henrich/handoff-pay](https://miniapps.lol/app/Henrich/handoff-pay). Serve the folder over HTTP as described in the [README](README.md#run-it) and open `index.html`, whose URL records what you are looking at as `index.html#side=testnet&project=<id>`.

handoff's mainnet broker holds no treasury key, so nothing pays verified mainnet tasks today, and this page adds that payment layer without changing handoff. No payment has been made through it on mainnet, its Robinhood Chain rail has been tested only by reading real USDG transfers, and its XMBL mode has been tested only against a fake broker.

## What it does

The user first picks a side. The testnet side (`https://handoff.lol`) uses the rails in handoff's `GET /api/v1/config/settlement`, which are Base Sepolia by default plus Arc Testnet and Ethereum Sepolia, and it checks and pays on the rail the user picks. The mainnet side (`https://mainnet.handoff.lol`) has two rails, Base USDC from handoff's settlement config and Robinhood Chain (chain 4663, USDG at `0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168`, 6 decimals), which the page adds itself because handoff does not list, settle on or watch that chain. There is no Robinhood testnet rail, because no testnet stablecoin address has been published. Each rail records its chain ID, name, token address, symbol, decimals, RPC, explorer and log-scan strategy, and the rail list is shown on screen with a "Pay with" picker.

The user then loads a project by pasting its ID or a link that contains it, or by picking one from `GET /requests`. Each verified task shows its title, the worker and the worker's `wallet_address` from `GET /agents/:id`, the amount and currency, who verified it and when, and a status, which is unpaid, paid from the user's wallet, paid by handoff, not checked yet, or unpayable with the reasons. Both kinds of paid status link to the transaction on whichever rail paid it.

Connecting a wallet works with any EIP-1193 browser wallet (`window.ethereum`). The page asks for the account and switches the wallet to the pay rail's chain, adding the chain first if the wallet does not know it. It then reads the wallet's past token `Transfer` logs to each worker from each rail's public RPC and matches them to tasks, and on mainnet it checks every rail, Base USDC and Robinhood USDG, before any Pay button appears. For a task confirmed unpaid on every rail, the page sends `token.transfer(workerWallet, amount)` on the pay rail through the wallet, waits for the receipt and re-reads the chains, so the task shows as paid with an explorer link. A USDC-priced task paid in USDG is labelled "paid in USDG (task priced in USDC)" on its Pay button and in the proof. "Copy proof" produces plain text for each paid task, with the task ID, worker, amount, token, chain, transaction and explorer link, for the user to paste into the project on handoff.

## How "paid" is decided

The chains are the source of truth, and the page keeps no record of what the user paid. A task counts as paid by handoff when handoff's `GET /activity` lists a settled receipt for `task:<id>` with a transaction, or when the task carries handoff's own `paid: true`, and the link uses the receipt's own network. The public activity feed is truncated, showing about 1,470 of more than 2,400 receipts, so a task can show `paid: true` without a visible transaction.

A task counts as paid from the user's wallet when a matching transfer exists. On each rail the page queries `eth_getLogs` on the rail's token for `Transfer(from = your wallet, to = any worker wallet)`, pools the transfers from every checked rail and matches tasks to them. A transfer counts for a task only if it went to that task's worker wallet, was for at least the task amount after scaling each by its own decimals, and was mined after the task's verification time. Transfers from different chains are ordered by time, because block numbers of different chains cannot be compared, and each transfer's time comes from its block rather than from the log alone. Tasks are matched oldest-verified first, each to the oldest transfer that fits, so a task gets at most one transfer and a transfer never counts twice. A payment on any rail counts, including for a task that names its network, because the network rule limits where the page will pay and not which payments count, and transfers that handoff's activity feed reports as its own payouts are left out.

A task is not checked yet until every rail that must be checked has been read back to its verification time, which on mainnet means Base and Robinhood Chain and on testnet means the rail being paid on. The page reads history in rounds of at most 150 `eth_getLogs` calls per rail, starting from the newest block and working back toward the oldest unpaid verification. Until a task is checked it has no Pay button and takes no part in matching, and if a rail's RPC fails, that rail's tasks stay unchecked and the error is shown, so nothing is marked unpaid because of an error. A task is unpaid when none of this applies, and before a wallet is connected, unpaid only means that handoff has not paid it.

Scanning adapts to each RPC. Queries always filter by the Transfer topic and the user's address as sender, plus the worker addresses where there are any. On a range or result-limit error, such as `-32000 … exceeds limit of 10000` or `-32602 … only 10000000 are allowed`, the range shrinks to the stated cap or to half and the query is retried, and after two successes in a row the range doubles again, up to the rail's maximum. Rate limits are retried with backoff and never treated as a reason to shrink. The per-rail limits are these:

| rail | per query | why |
| --- | --- | --- |
| Base | 2,000 blocks | its public RPC's range cap |
| Base Sepolia | 1,000 blocks | its public RPC's range cap |
| Robinhood Chain | up to 10,000,000 blocks (~11.5 days) | its RPC caps blocks per query and 10,000 matching logs, not a small block range |

For a typical payer, two weeks of Robinhood history takes about 2 calls.

## Trust model

The page only makes GET requests to handoff's public API, so paying through it does not change handoff's own paid flag, and the proof text is pasted by hand. The page never sees a private key. Every payment is a normal `eth_sendTransaction` to the pay rail's token contract with hand-encoded calldata (selector `0xa9059cbb`, then the address padded to 32 bytes, then the amount as a uint256), which the wallet shows and the user approves. Before sending, the page asks the user to confirm, re-checks the account and chain, re-reads every rail and asserts the token address. It sends one payment at a time, and a task stays locked after its payment is sent, even if the user switches rails, so it cannot be paid twice while the payment confirms.

handoff's rails come from its settlement config, and the page adds one rail of its own, Robinhood Chain USDG, on the mainnet side only. If handoff's config cannot be loaded, the side has no rails at all, so a check can never skip a rail handoff knows about. handoff does not watch Robinhood Chain, so payments there are proven only by the USDG `Transfer` logs that the page reads.

On mainnet there is one hard cap for the browser session across every rail, 0.50 by default, in which USDC and USDG count dollar for dollar, and it is shown once. The amount is reserved against the cap when a payment is submitted and released only if the wallet rejects the payment or the transaction reverts, any payment that would exceed the cap is refused whichever rail it is on, and the cap is changed by typing a new number. Testnet has no cap, because the money is test money.

Only payable tasks get a Pay button, and the page never guesses a payee or a unit. A task cannot be paid on any rail if it has no worker or the worker is not a registered agent, if the worker has no valid wallet, if the verifier is the worker or the task was self-signed without a co-signer, if no verifier or verification time is on record, if handoff marks it `unpayable`, if its amount is missing, zero, without units or not in a dollar stablecoin (USDC or USDG), if it names a network that is not a rail on this side, or if it names a `pay_to` other than the worker's wallet. It also cannot be paid on the chosen rail if it names a different network, since a task that names its network is payable only there, or if the worker's wallet is custodial (`wallet_custodial: true`) and the rail is not in handoff's settlement config, in which case the reason shown is "custodial wallet; handoff doesn't watch this chain".

These rules cover the Base and Robinhood Chain rails. The XMBL sealed release mode is the one exception and has its own trust model, described in [XMBL sealed release (testnet)](#xmbl-sealed-release-testnet).

## XMBL sealed release (testnet)

The XMBL mode is a second way to pay one task, available only on the testnet side and only in Base Sepolia USDC, and the mainnet side never shows it. It carries this label word for word:

> Key release sealed by the handoff broker with experimental, unaudited Cubic-LWE. Not an escrow: the broker minted the key. Testnet only.

This mode is the exception to the rule that no key exists. The handoff broker mints a fresh EVM key for one payout and seals it to the worker's Cubic-LWE public key (`@xmbl/identity` 0.1.20, n = 729), so the broker has seen that key and the worker's scripts open it. The page itself still never sees a key and only sends two ordinary transactions from the user's wallet, each of which the user approves.

### Flow

The scripts are in `xmbl/`, which has its own `package.json` pinned to `@xmbl/identity` 0.1.20, and every script is a dry run unless it is given `--live`.

The worker first runs `node worker-keys.mjs`, which writes a fresh Cubic-LWE key pair and a fresh MAYO identity to `keys/worker-<time>/` (gitignored, with secret files at mode 0600) and prints only the worker's `xmb…` address and the path of the public key file, about 2.5 MB of JSON. The worker gives both to the requester.

The requester then asks for a seal with `node request-seal.mjs --as <agentId> --settlement <id> --payer <0x…> --receiver-xmb <xmb…> --pk <lwe-pk.json> --amount 0.05`. This calls `POST https://handoff.lol/api/v1/xmbl/settlement/seal`, signed like any handoff agent request with an Ed25519 signature made with the agent's local `sig_privkey` from `~/.handoff` over `handoff-signed-req`, the agent ID, the method, the path, the timestamp and the SHA-256 of the body, and sent in the `X-Agent-Id`, `X-Signature` and `X-Timestamp` headers. The dry run prints the exact request with the signature redacted and the 2.5 MB key elided, and `--live` sends it and saves the response to `out/`. The script refuses any `evm_private_key` argument or field, any mainnet API and any chain other than `base-sepolia`. The response names a one-time address (`fund_here`) and holds the sealed key.

Before anything is funded, the worker runs `node claim-and-check.mjs --settlement <id> --claim <claim_id> --seal-response <file> --keys <folder> [--live]`. With `--live` it MAYO-signs the `claim_id` and claims the seal, and without it, it checks the seal inside the seal response instead. It opens the seal with the worker's Cubic-LWE secret key, derives the EVM address itself from the uncompressed public key, and requires that address to equal `fund_here.address`. On a match it prints a check line of the form `xmbl-check OK settlement=… claim=… fund=0x… receiver=xmb…`, and otherwise it prints `FUNDING UNSAFE` and exits non-zero. The key is never printed, logged or saved, and the script zeroes it after use.

The requester funds the address in the page by picking the testnet side, opening "XMBL sealed release (testnet)", and pasting the seal response, the worker's check line and the worker's wallet. The page checks the response's fields and refuses one that carries any private-key field, checks that the line names the same claim, address and receiver, and reads the one-time address, which must hold nothing and have sent nothing. The first step sends exactly the USDC amount and waits for it to confirm, and the second sends 0.00002 ETH for the sweep's gas and waits for that too. Each step re-reads the address first, and the page refuses to fund an address that has already sent a transaction.

The worker then sweeps with `node sweep.mjs --settlement <id> --seal-response <file> --keys <folder> --to <worker 0x…> [--live]`. The dry run reads the address's balances and prints the gas budget, the unsigned EIP-1559 transaction and its signing hash. With `--live` the script signs inside `@xmbl/identity`'s `releaseAndSign`, checks that the signature recovers to the funded address and sends the transaction, and it refuses if the address is not funded or holds too little ETH for the gas budget. Finally, "Check both legs" reads the USDC `Transfer` logs for the first leg, from the requester to the one-time address, and the second, from the one-time address to the worker, and "Copy proof" copies both. No public endpoint proves the settlement, so the two legs are the proof.

The worker's check is a pasted line rather than a tick box because a tick box only records that someone clicked, whereas the line names the settlement, claim, address and receiver that the worker's script checked, and the page compares each one with the seal response. The line is not signed, so it is the worker's word passed on by hand, and it catches a copy mistake or the wrong seal but not a worker who lies.

The sweep pays its own gas because the requester sends a little ETH with the payout. The alternative was for the worker to sign an EIP-3009 authorization for a relayer to submit, and sending ETH was chosen because it needs no relayer to run or trust and keeps the sweep to one plain USDC `transfer` signed by the released key. It costs a fixed 0.00002 ETH of test ETH, which covers the 65,000-gas fallback limit at up to about 0.3 gwei, far above Base Sepolia's usual fees, and the price is a little ETH left behind at an address that must never be used again.

### Trust caveats

This mode is not an escrow. The broker minted the key and saw it, so whoever runs the broker could move the funds, and the only guarantee is that only the payee can open the envelope. A seal can also be reopened forever by whoever holds the worker's Cubic-LWE secret key, so each payout should use a fresh key, fund exactly the amount plus gas, and never reuse or refill an address.

The cryptography is experimental. The Cubic-LWE KEM is unaudited and only IND-CPA secure, so the mode is testnet only: the page shows it only on the testnet side on Base Sepolia (chain 84532), and the scripts refuse a mainnet API and any chain other than `base-sepolia`. The XMBL record is not submitted anywhere, since the seal response's `submitted` is `false` on production, and the page shows that.

No live seal, claim or sweep has been run. Whether the broker lets the worker claim before the address is funded has not been observed, but the check before funding does not depend on it, because without `--live`, `claim-and-check.mjs` opens the seal in the seal response the requester passed on, so the worker can check that copy first. If the broker refuses the claim until the address is funded, the worker checks that copy before funding and claims with `--live` afterwards, when the script checks the broker's copy again, and the remaining risk is that the broker's copy differs from the response, which would only show up after the money is at the address. The wire format of `receiver_lwe_pk` is also assumed to be JSON `{ A, b, n, q }` as numbers, about 2.5 MB and under the broker's 4 MB limit, and `amount_usdc` is assumed to be a decimal string.

> **Requires `@xmbl/identity` 0.1.20 or later.** In 0.1.18 and 0.1.19, `sealChainKey('evm')` and `releaseAndSign('evm')` reported an address derived from the compressed public key, which no key controls, so funds sent there were lost. 0.1.20 derives it from the uncompressed key; a local round trip on 0.1.20 gave the same address from the seal and the release, and the signature verified, 3 of 3 times. The scripts don't rely on the package's address anyway: they derive the address from the released key themselves and compare it with `fund_here.address`, a test simulates the old bug to show the check catches it, and `sweep.mjs` checks that the signature recovers to the funded address.

## Smoke tests

The smoke test prints what the page would show for a real project, with no wallet connected:

```sh
node scripts/smoke.mjs --project 2af16779-4c0f-4c93-94b7-6a0281fc6846 --chain-check
```

With `--chain-check` it picks a settled handoff payout on Base Sepolia from `/activity` and scans for it with the page's own scanner, checking that the decoded sender, recipient and amount match and that the matching rule accepts the payout for a task verified before it and rejects it for one verified after. `node scripts/smoke.mjs --side mainnet --robinhood` does the same on Robinhood Chain mainnet. It picks a real recent USDG transfer from a quiet sender, scans the 14 days before it with the page's adaptive scanner filtered by that sender only, checks the decoded sender, recipient and amount against the raw log and the transaction receipt, and prints how many calls and blocks it took, and it then scans a busy sender over 200,000 blocks to exercise the halving on result-count errors. Both only read, and neither sends nor signs anything.

The XMBL scripts have their own tests, which need the pinned package installed:

```sh
cd xmbl && npm ci && npm test
```

They run against a fake broker and a fake RPC with a real local `sealKeyPair` → `sealSecret` → `openSecret` round trip, and they check that the address check catches a mismatch by simulating the `sealChainKey` bug, that `evm_private_key` is refused, and that the key never appears in the output.

## Notes on handoff's data

handoff's `payment` field appears in several forms: `{ amount, currency }`, where `amount` is a number (`1e-6`) or a string (`"0.050000"`), the same object with `network` and `pay_to`, and a bare string (`"80"`) or bare number (`10000`). The bare forms have no units, so the page will not pay them. `verified_by` may be `"requester"`, which the page resolves to the project's requester, or an ID followed by prose, and the verification time is the last `verified` entry in `status_history`, because there is no `verified_at` field. Some verified tasks have no `assignee`, and receipt amounts in `/activity` come in two unit styles, `"0.05"` for USDC and `"400000"` in atomic units.

Robinhood Chain's RPC returns `blockTimestamp: "0x0"` on some logs, so the page treats a zero or missing log time as unknown and reads the time from the block. It also checks one claimed time per scan against its block, and if that does not match, it reads every time from its block.

Almost every worker wallet is custodial. On testnet, 56 of the 58 workers with a wallet have `wallet_custodial: true` and the other two have no `wallet_custodial` field, so most real tasks can be paid on Base but not on Robinhood Chain.
