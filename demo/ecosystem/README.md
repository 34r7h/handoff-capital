# Ecosystem mechanics on handoff testnet

One run on handoff.lol and Base Sepolia on 2026-10-12, from 15:21 to 15:28 UTC and with amounts of 0.0002 to 0.01 test USDC, shows the whole loop in one pass. Two agents publish components at 0.0002 USDC, two agents form a company, and the company buys both components and publishes an app that includes them. A third agent buys the company's app, which pays the component authors, and the company deploys a share contract in which an agent outside the company buys a share. A buyer then pays for the downstream app, which pays everyone up the chain, and the company pays an amount equal to its royalty into the share contract, from which the shareholder claims its part.

`proof.txt` is the result, read back live from handoff and the chain by `verify.mjs`, `handoff-mechanics-proof.mp4` shows the same text as a 47-second video, and `run.log` is the log written as each step ran. `handoff-capital-demo.mp4` (147 seconds) is one continuous browser session recorded on 2026-10-13 from 04:48 UTC with the cursor and each click shown. It opens the components and apps on miniapps.lol, then handoff capital in the store on FC Studio's raise with its members, who pays the company, the terms and the holders, follows the [live steps](#recorded-live-2026-10-13) to their transactions on Blockscout, and returns to handoff capital for the totals. Page loads play at 5x speed, and because a headless browser has no address bar, the bar and the captions are drawn in afterwards from the recorder's log. `walk.cjs` records the session, and `render.py` followed by `cards.py` assemble the video.

Every agent in the run is operated from the founder's machine. The agents sit under five handoff owner accounts, which handoff's royalty rules treat as separate principals. SirKit, the shareholder, shares an owner with handoff-claude, but neither is a member of fc-studio. notben_agent, the backer in the live recording, is under a sixth.

## What it proves

| Step | Measured |
|---|---|
| Components | `pixelshift/eco-palette-e1` and `manifast/eco-manifest-e1`, each priced at 0.0002 USDC, use open |
| Company | `fc-studio`, an ownerless company agent. Its members are funny and charisma, as officers, under memberships `ctr_e9800a7c…` and `ctr_d6e57a69…`, both signed by each side |
| Company buys | sale `0998208181419939-0` (0.0002 to pixelshift) and `0998208181419604-1` (0.0002 to manifast) |
| Company's app | `fc-studio/eco-board-e1` includes both through `components.json` and is priced 0.002 |
| First downstream sale | sale `0998208181417976-2`: handoff-claude paid 0.002. fc-studio got 0.0016; manifast and pixelshift got 0.0002 each, step 1 at 10% |
| Share contract | [`0xf86c8c57…a4d0`](https://sepolia.basescan.org/address/0xf86c8c57277d3127ae9fa895df0b2e44ecf7a4d0), `AgentShares` from this repo, compiled by handoff's `POST /contracts/compile`. It was requested by fc-studio through `POST /contracts/deploy` and sent by handoff's deployer key. Founders funny and charisma hold 2 shares each; 2 more were offered at 0.001 USDC. It is registered as fc-studio's `onchain` capital policy |
| Share bought | SirKit's custodial wallet approved and called `buy(1)` through `POST /agents/SirKit/wallet/call`: tx [`0x1047af58…`](https://sepolia.basescan.org/tx/0x1047af585e1ccd041a1278dbac79cc14d329dcdb23126dd3cc1cf24c90de571c). Supply was then 5 |
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

## Recorded live, 2026-10-13

These steps ran on 2026-10-13 from 00:49 UTC, while `live.mjs` recorded handoff capital re-reading the contract after each. notben_agent is under a sixth owner account, outside FC Studio and the earlier run.

| Time (UTC) | Step | Measured |
|---|---|---|
| 00:49:51 | Share bought | notben_agent's custodial wallet called `buy(1)` through `POST /agents/notben_agent/wallet/call`: tx [`0xcd14aae4…`](https://sepolia.basescan.org/tx/0xcd14aae4b5ac5a410bc4b9320091a4a264f2ba878ee94af3c6ef1318db3fb58e), block 48042151. The raise is 2 of 2 sold; supply is 6 |
| 00:50:09 | Downstream sale | sale `0998208147390405-0`: notben_agent paid 0.01 for `handoff-claude/eco-market-e1`. handoff-claude got 0.008 as seller; fc-studio 0.001 (step 1, 10%); manifast and pixelshift 0.0005 each (step 2, 5%) |
| 00:50:25 | Revenue in | fc-studio's wallet sent 0.001 USDC to the contract through `wallet/spend`: tx [`0x1170cd11…`](https://sepolia.basescan.org/tx/0x1170cd111ec63253deec54e3a241f08831fa4b23c592bfb947780b527a2ffcbe), block 48042169. handoff capital showed it as arrived, not booked |
| 00:50:45 | Dividend | notben_agent called `claim()`, which booked the 0.001 over 6 shares and paid it 0.000166 USDC: tx [`0x187da326…`](https://sepolia.basescan.org/tx/0x187da326dec1b2dab29717bb9d1f21c454109f847c538e801ee076e78323f9a6), block 48042179 |

After it, the contract reads 0.002 USDC booked to holders and 0.000366 claimed, across 4 wallets and 6 shares. notben_agent's USDC went from 3.218202 to 3.217368: 0.001 for the share, then 0.000166 back.

With no shares left, fc-studio closed the raise at 01:05:28 UTC so the page stops offering a buy that would revert: `closeRaise()` through `wallet/call`, tx [`0x491ac737…`](https://sepolia.basescan.org/tx/0x491ac737c010e250b58f46daae7b591426115b263c0bc7c79378348b859fa90f), after SirKit sent fc-studio 0.0001 test ETH for gas ([`0xe4c4d8c4…`](https://sepolia.basescan.org/tx/0xe4c4d8c45822e40623c5e7328bc6a0dd99664c98b5a4ebcd2e905dac81123359)).

Before recording, SirKit sent notben_agent 0.0004 test ETH for gas ([`0x7832ca73…`](https://sepolia.basescan.org/tx/0x7832ca73334ff3d16e234545d54fcf094acb40d649dde30bd544bf9975fb7f5a)), and notben_agent approved the contract for 0.001 USDC ([`0x07d634bc…`](https://sepolia.basescan.org/tx/0x07d634bce8a9236a899042b7e75e7f9fd76604f4122ca5fd08941657657b38e1)). `live.mjs` is the recorder that ran these steps.

## Limits

The royalty reached the contract by hand. handoff credits royalties to the company's balance on its ledger, fc-studio then paid an equal amount from its own on-chain wallet, and `wallet/spend` does not debit that ledger, because handoff has no route yet that pays a company's earnings into its share contract.

The founders funded fc-studio. funny and charisma each sent 0.04 USDC to fc-studio's wallet, in two transfers of 0.02 each because the funding step ran twice, and the faucet's 1 USDC registration grant also landed there.

The handoff routes used here are not new. The contract, wallet and royalty routes are handoff's existing ones, companies and the downstream royalty model come from the hackathon window, and `AgentShares` and this run are this entry's work.

Not everything can be re-run by others, because `verify.mjs` signs the licensing reads as each agent and so needs those agents' keys, although anyone can check the on-chain half on Basescan. The agents' handoff balances also moved for publishing and other activity in the same minutes, so the licensing ledger and the chain logs above, rather than balance changes, are the record for this run.

## Re-run

`node verify.mjs` needs `cast` (Foundry) and the agents' keys in `~/.handoff/agents/`. The writing scripts are `run.mjs`, `deploy.mjs`, `invest.mjs` and `revenue.mjs`, in that order. They spend test USDC and test ETH. `live.mjs` also needs `playwright-core` and Chrome; it cannot run again as written, because the raise is closed. `walk.cjs` needs the same and only reads; `render.py` and `cards.py` need Pillow and ffmpeg, and write to `out/`.
