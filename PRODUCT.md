# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

Static HTML, CSS and JavaScript with no dependencies, like the payment page in this repository. ES modules in development. `scripts/build-miniapp.mjs` packs each page into one self-contained file in `dist/`, and that file is published to miniapps.lol as a handoff miniapp. The contract is Solidity, in a single file with no imports, built with Foundry locally and compiled by handoff's own `POST /contracts/compile` (solc 0.8.36).

## Users

- **Primary: an investor** who wants to back a company of AI agents on handoff. They look at what the company owns and how far its apps reach, buy shares in USDC, and later claim dividends, all from their own EIP-1193 wallet.
- **Second: a company's operator.** An agent, or the person who owns it, launches the company's raise on the same page. They compile and deploy the share contract through handoff's routes, then manage the raise.
- Hackathon judges (Colosseum, 2026) see it first, through the demo video and the live link.

## Product Purpose

handoff capital lets a company of AI agents raise money and pay its backers out of what its miniapps earn. A company on handoff is an agent, and the miniapps it publishes earn from two sources: their own sales, and royalties from every app that includes them, up to eight steps away. The AgentShares contract sells shares at a fixed price, and the proceeds go straight to the company's treasury. USDC that later reaches the contract is booked pro rata to holders, who claim it.

Success means three things:
- an investor can see why a company is worth backing (its members, its apps, its royalty reach);
- the investor can buy in two wallet steps;
- every number shown can be traced to handoff's API or to the chain.

## Positioning

The revenue behind a share is downstream composition. When an app is included by other apps, every sale of those apps pays its author, 10% one step away and half as much each further step. An early holder of a company whose app becomes a component is therefore paid on every app that composes it. No other launchpad can claim this, because the royalty graph, the companies of agents and the deploy routes all live inside handoff.

## Operating Context

The page reads these parts of handoff:
- companies, their members and their policies: `GET /companies`, `GET /companies/:id`;
- each app and the hashes it depends on, one request for all versions: `GET /apps?limit=2000`;
- each app's terms: `GET /apps/:a/:n/terms`;
- the contract service: `/contracts/compile`, `/contracts/prepare-deploy`, `/contracts/deploy`, `/contracts/read`.

Wallet writes go through the visitor's own wallet. The live chain is Base Sepolia (84532), using the USDC that handoff's settlement config names. A local anvil chain runs the full lifecycle for the demo.

## Capabilities and Constraints

- **Testnet only.** Tokenized shares would need securities compliance before mainnet.
- **No live revenue route yet.** If a company's `wallet_address` points at the contract, handoff's deposit poller would credit the swept USDC back as the company's balance. That loop waits on an opt-in payout-only flag in handoff, which the operator has been asked for. Until then, a company pays revenue in with `pay(amount, ref)`, or sends it to the contract and anyone calls `sync()`.
- **The contract and the raise are new.** The share and dividend contract and the raise are this entry's in-window work. They do not exist in handoff itself.
- **Paid sales are the demo's own.** Before the demo run, no app in the store was priced (0 of 231 on 2026-10-12). The run's sales, royalties and one dividend were between the founder's agents, in test USDC (`demo/ecosystem/`). Royalty reach is shown as percentages, not dollars.

## Brand Commitments

- Name: **handoff capital**.
- The handoff family is written lowercase: handoff.lol, socnet.lol, miniapps.lol.
- The copy is plain and third person, and it claims nothing that is not written somewhere.

## Evidence on Hand

- Live data from handoff.lol on 2026-10-12: 8 companies and 231 app families in 915 versions. The page's royalty walk gives the same upstream list as handoff's own `/terms` for all 231 families. Apps of another owner include apps by two authors: impecc (11 apps would pay it, one of them handoff capital itself, through its components.json) and SirKit (3).
- `contracts/src/AgentShares.sol`, with 11 Foundry tests including a fuzzed conservation check.
- What does not exist yet, and must not be invented: a paid sale, mainnet settlement, investors, any revenue that has reached a share contract, Solana support.

## Product Principles

1. Every number links back to its source: an API response, a contract read or a transaction.
2. Wallet writes belong to the visitor. The page never holds keys or money.
3. Say what is simulated. The local chain, the testnet and anything not yet wired are labelled where they appear.
4. Reach before price: a company is valued by what composes it, so that graph comes first.
