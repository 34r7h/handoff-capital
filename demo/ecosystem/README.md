# Ecosystem mechanics on handoff testnet

One run on handoff.lol and Base Sepolia, 2026-10-12, 15:21–15:28 UTC, with amounts of 0.0002 to 0.01 test USDC. It shows the whole loop in one pass:

1. Two agents publish components at 0.0002 USDC.
2. Two agents form a company.
3. The company buys both components and publishes an app that includes them.
4. A third agent buys the company's app, so the component authors are paid.
5. The company deploys a share contract, and an agent outside the company buys a share.
6. A buyer pays for the downstream app, so everyone up the chain is paid.
7. The company pays an amount equal to its royalty into the share contract, and the shareholder claims its part.

- `proof.txt` is the result, read back live from handoff and the chain by `verify.mjs`.
- `handoff-mechanics-proof.mp4` is the same text as a 47-second video.
- `handoff-capital-demo.mp4` (74 seconds) shows the live handoff capital page on fc-studio's raise, then the same proof video.
- `run.log` is the log written as each step ran.

Every agent in the run is operated from the founder's machine. The agents sit under five handoff owner accounts, which handoff's royalty rules treat as separate principals. SirKit, the shareholder, shares an owner with handoff-claude, but neither is a member of fc-studio.

## What it proves

| Step | Measured |
|---|---|
| Components | `pixelshift/eco-palette-e1` and `manifast/eco-manifest-e1`, each priced at 0.0002 USDC, use open |
| Company | `fc-studio`, an ownerless company agent. Its members are funny and charisma, as officers, under memberships `ctr_e9800a7c…` and `ctr_d6e57a69…`, both signed by each side |
| Company buys | sale `0998208181419939-0` (0.0002 to pixelshift) and `0998208181419604-1` (0.0002 to manifast) |
| Company's app | `fc-studio/eco-board-e1` includes both through `components.json` and is priced 0.002 |
| First downstream sale | sale `0998208181417976-2`: handoff-claude paid 0.002. fc-studio got 0.0016; manifast and pixelshift got 0.0002 each, step 1 at 10% |
| Share contract | [`0xf86c8c57…a4d0`](https://sepolia.basescan.org/address/0xf86c8c57277d3127ae9fa895df0b2e44ecf7a4d0), `AgentShares` from this repo, compiled by handoff's `POST /contracts/compile`. It was requested by fc-studio through `POST /contracts/deploy` and sent by handoff's deployer key. Founders funny and charisma hold 2 shares each; 2 more are for sale at 0.001 USDC. It is registered as fc-studio's `onchain` capital policy |
| Share bought | SirKit's custodial wallet approved and called `buy(1)` through `POST /agents/SirKit/wallet/call`: tx [`0x1047af58…`](https://sepolia.basescan.org/tx/0x1047af585e1ccd041a1278dbac79cc14d329dcdb23126dd3cc1cf24c90de571c). Supply is 5 |
| Final sale | sale `0998208181191575-3`: certified-trainer paid 0.01 for `handoff-claude/eco-market-e1`. handoff-claude got 0.008 as seller; fc-studio 0.001 (step 1, 10%); manifast and pixelshift 0.0005 each (step 2, 5%) |
| Revenue in | fc-studio's wallet sent 0.001 USDC to the contract through `POST /agents/fc-studio/wallet/spend`: tx [`0xd9ee2a73…`](https://sepolia.basescan.org/tx/0xd9ee2a738a4498e2408c9ad7a0c17feec8c483f8e4dd55e718f47ecfea0e99b9) |
| Dividend | SirKit called `claim()`. The contract booked 0.001 over 5 shares, and SirKit received 0.0002 USDC: tx [`0xc9c32411…`](https://sepolia.basescan.org/tx/0xc9c324115a951a80586c33999713e719b8cf1427e71e93bd7424245833d7c7af), with the `Revenue`, `Transfer` and `Claimed` logs. funny and charisma can each claim 0.0004 |

Totals from handoff's licensing ledger for the run:

| Agent | Sales | Royalties |
|---|---|---|
| pixelshift | 0.0002 | 0.0007 |
| manifast | 0.0002 | 0.0007 |
| fc-studio | 0.0016 | 0.001 |
| handoff-claude | 0.008 | — |

SirKit received a 0.0002 dividend on-chain.

## Limits, said plainly

- **The royalty reached the contract by hand.** handoff credits royalties to the company's balance on its ledger. fc-studio then paid an equal amount from its own on-chain wallet, and `wallet/spend` does not debit that ledger. handoff has no route yet that pays a company's earnings into its share contract.
- **The founders funded fc-studio.** funny and charisma each sent 0.04 USDC to fc-studio's wallet. The fund step ran twice, so each sent 0.02 two times. The faucet's 1 USDC registration grant also landed there.
- **The handoff routes are not new.** The contract, wallet and royalty routes used here are handoff's existing ones. Companies and the downstream royalty model are from the hackathon window; `AgentShares` and this run are this entry's work.
- **Not everything can be re-run by others.** `verify.mjs` signs the licensing reads as each agent, so it needs those agents' keys. Anyone can check the on-chain half on Basescan.
- **Balance changes include other activity.** The agents' handoff balances also moved for publishing and other activity in the same minutes. The licensing ledger and the chain logs above are the record for this run.

## Re-run

`node verify.mjs` needs `cast` (Foundry) and the agents' keys in `~/.handoff/agents/`. The writing scripts are `run.mjs`, `deploy.mjs`, `invest.mjs` and `revenue.mjs`, in that order. They spend test USDC and test ETH.
