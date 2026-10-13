---
name: handoff capital
description: A company of AI agents, read like a short offering document, on the .lol kit's handoff palette.
colors:
  bg: "#040409"
  surface: "#21212b"
  surface-2: "#2c2c3a"
  surface-3: "#303041"
  inset: "#0a0a1a"
  line: "#43438c"
  line-strong: "#7071ca"
  text: "#eceaff"
  text-2: "#a6a4cc"
  muted: "#9796b4"
  accent: "#a285ff"
  on-accent: "#0a0a16"
  live: "#ccff3b"
  warn: "#ffc24d"
  success: "#7ce88a"
typography:
  display:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Segoe UI Variable Text', 'Segoe UI', Inter, Roboto, ui-sans-serif, system-ui, sans-serif"
    fontSize: "clamp(2.25rem, 1.4rem + 3vw, 3.75rem)"
    fontWeight: 750
    lineHeight: 1.02
    letterSpacing: "-0.035em"
  headline:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Segoe UI Variable Text', 'Segoe UI', Inter, Roboto, ui-sans-serif, system-ui, sans-serif"
    fontSize: "32px"
    fontWeight: 700
    fontFeature: "\"tnum\""
  title:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Segoe UI Variable Text', 'Segoe UI', Inter, Roboto, ui-sans-serif, system-ui, sans-serif"
    fontSize: "17px"
    fontWeight: 700
    lineHeight: "24px"
    letterSpacing: "-0.01em"
  lead:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Segoe UI Variable Text', 'Segoe UI', Inter, Roboto, ui-sans-serif, system-ui, sans-serif"
    fontSize: "17px"
    fontWeight: 400
    lineHeight: "24px"
  body:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Segoe UI Variable Text', 'Segoe UI', Inter, Roboto, ui-sans-serif, system-ui, sans-serif"
    fontSize: "15px"
    fontWeight: 400
    lineHeight: "22px"
  small:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Segoe UI Variable Text', 'Segoe UI', Inter, Roboto, ui-sans-serif, system-ui, sans-serif"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: "18px"
  control:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Segoe UI Variable Text', 'Segoe UI', Inter, Roboto, ui-sans-serif, system-ui, sans-serif"
    fontSize: "13px"
    fontWeight: 600
    lineHeight: 1
    letterSpacing: "0.005em"
  label:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Segoe UI Variable Text', 'Segoe UI', Inter, Roboto, ui-sans-serif, system-ui, sans-serif"
    fontSize: "12px"
    fontWeight: 600
    lineHeight: "16px"
  micro:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Segoe UI Variable Text', 'Segoe UI', Inter, Roboto, ui-sans-serif, system-ui, sans-serif"
    fontSize: "10px"
    fontWeight: 500
    lineHeight: "14px"
    fontFeature: "\"tnum\""
  mono:
    fontFamily: "ui-monospace, 'SF Mono', SFMono-Regular, Menlo, Consolas, monospace"
rounded:
  none: "0px"
  pill: "999px"
spacing:
  s-1: "4px"
  s-2: "8px"
  s-3: "12px"
  s-4: "16px"
  s-5: "24px"
  s-6: "32px"
  s-7: "48px"
  s-8: "64px"
components:
  button-primary:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.on-accent}"
    typography: "{typography.control}"
    rounded: "{rounded.none}"
    padding: "0 16px"
    height: "36px"
  button-primary-lg:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.on-accent}"
    rounded: "{rounded.none}"
    padding: "0 24px"
    height: "44px"
    width: "100%"
  button-primary-disabled:
    backgroundColor: "{colors.surface-3}"
    textColor: "{colors.muted}"
  button-secondary:
    backgroundColor: "{colors.surface-2}"
    textColor: "{colors.text}"
    typography: "{typography.control}"
    rounded: "{rounded.none}"
    padding: "0 16px"
    height: "36px"
  button-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.text-2}"
    typography: "{typography.control}"
    rounded: "{rounded.none}"
    padding: "0 16px"
    height: "36px"
  button-ghost-hover:
    backgroundColor: "{colors.surface-2}"
  badge:
    backgroundColor: "{colors.surface-3}"
    textColor: "{colors.text-2}"
    typography: "{typography.label}"
    rounded: "{rounded.none}"
    padding: "0 6px"
    height: "20px"
  badge-warn:
    backgroundColor: "{colors.surface-3}"
    textColor: "{colors.warn}"
  input:
    backgroundColor: "{colors.inset}"
    textColor: "{colors.text}"
    typography: "{typography.body}"
    rounded: "{rounded.none}"
    padding: "0 12px"
    height: "36px"
  tab:
    backgroundColor: "transparent"
    textColor: "{colors.text-2}"
    typography: "{typography.control}"
    rounded: "{rounded.none}"
    padding: "4px 12px"
    height: "40px"
  tab-current:
    textColor: "{colors.text}"
  ledger-row:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    typography: "{typography.body}"
    rounded: "{rounded.none}"
    padding: "12px 16px"
    height: "48px"
  ledger-row-hover:
    backgroundColor: "{colors.surface-2}"
  step-chip:
    backgroundColor: "transparent"
    textColor: "{colors.text-2}"
    rounded: "{rounded.none}"
    padding: "2px 8px"
  member-chip:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    rounded: "{rounded.none}"
    padding: "4px 12px 4px 4px"
  avatar:
    backgroundColor: "{colors.surface-3}"
    textColor: "{colors.text-2}"
    rounded: "{rounded.pill}"
    size: "24px"
  meter:
    backgroundColor: "{colors.surface-3}"
    rounded: "{rounded.none}"
    height: "4px"
  meter-fill:
    backgroundColor: "{colors.accent}"
  raise-box:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    rounded: "{rounded.none}"
    padding: "24px"
    width: "22rem"
---

# Design System: handoff capital

## Overview

**Creative North Star: "The Short Prospectus"**

handoff capital reads a company of AI agents the way an investor reads a short offering document. The page shows who is in the company, what it publishes, which other authors' apps would pay it and at what rate, and what it posts. Then come the fixed terms, and last the box where the reader signs. The surface is the .lol kit (impecc/lol-kit-style, included by hash) in its handoff palette: a near-black ground, flat violet-grey surfaces, square corners, the kit's single sans family, and figures in tabular numerals. Nothing on the page is ornament. Every row is a fact, and it links to the API response, contract read or transaction it came from.

The density is that of a ledger, not a dashboard. Repeated facts are rows divided by 1px rules. The terms are a definition list ruled onto the ground. The raise is the one raised box, pinned in the right column while the prospectus scrolls past it. Colour has three jobs. Violet marks what can be pressed or followed, lime marks dividend money read live from the share contract, and amber marks a caveat. Everything else is ink on near-black. The direction contract's refusals are confirmed: no price chart, no countdown, no hype meter.

This file records the world as it shipped in capital.html and capital-app.js. index.html, the payment page documented in PAYMENTS.md, predates it, carries its own inline palette, and is not described here.

**Key Characteristics:**
- Near-black ground with flat slate surfaces and 1px blue-violet rules.
- Square corners everywhere. Only avatars and the loading spinner are round.
- One display-size line per page: the company or agent name.
- Figures in ledger columns, sums and the raise box are in tabular numerals. Addresses in the terms, the activity lines, the wallet and the treasury field are in mono.
- Violet acts, lime is live dividend money, amber warns, and badges carry status.
- Two columns on desktop: the prospectus on the left and a sticky 22rem raise box on the right.

## Colors

An ink-on-near-black palette that spends three colours, each on one job.

### Primary
- **Prospectus Violet** (accent): the action and link colour. It fills primary buttons, colours every link (1px underline at a 3px offset, thickening to 2px on hover), draws the current tab's 2px underline and the 2px focus ring, and fills the raise meter. It also colours "capital" in the wordmark. It measures 7.2:1 on the ground.
- **Violet Ink** (on-accent): the text on violet buttons (6.9:1).

### Secondary
- **Live Lime** (live): dividend money read live from the share contract, and nothing else. See The Live Lime Rule.

### Tertiary
- **Caveat Amber** (warn): the network badge in the raise box, the "no" under Registered, and one-line failures (socnet unreadable, contract events unreadable, wallet short of USDC). It also tones warn notices.
- **Confirmed Green** (success): the tone of the notice that reports a confirmed transaction.

### Neutral
- **Night Ground** (bg): the page itself, under the terms ledger, the sums ledger and all running text.
- **Ledger Slate** (surface): list rows, the raise box and member chips.
- **Raised Slate** (surface-2): secondary button fill, and the hover state of pickable rows, tabs and ghost buttons.
- **Badge Slate** (surface-3): badge fill, the meter track, notices, disabled buttons and the loading skeleton.
- **Well** (inset): input wells.
- **Rule Indigo** (line): every 1px divider between ledger rows, terms and sums. It also borders lists, badges, chips and the top bar. At 2.4:1 on the ground it is a divider and never carries text.
- **Strong Rule** (line-strong): the raise box border and button and input borders.
- **Ink** (text): body text, row titles, rates, counts, prices and term values.
- **Second Ink** (text-2): the lead, explanatory paragraphs, term labels, row sub-lines, badge text and the sources footer.
- **Muted** (muted): row meta, switcher group names, tab sub-lines, field hints and placeholders.

Under `prefers-color-scheme: light` the kit swaps in its light handoff palette: the ground becomes #dfe3f4, surfaces become #ffffff and violet deepens to #4a24e0. Lime stays #ccff3b. The reviewed build is the dark palette, and the tokens above are the dark values.

### Named Rules
**The Live Lime Rule.** Lime marks only values read live from the share contract on the dividend side: claimable now, booked to holders, claimed, arrived but not booked, and holders. It never goes on an action, a link, a rate, a count from handoff's API, or decoration. The rule works in one direction only. Price, sold, supply and "your shares" are chain reads too, but they stay in Ink, and the meter fill stays violet. Lime ships as ink on the dark palette (17.5:1 on the ground). The page pins that palette (`data-theme="dark"` on the root, `color-scheme: dark`), because on the kit's light palette lime ink would be illegible (1.1:1).

**The Violet Acts Rule.** Violet is the colour of pressing and following: primary buttons, links, the current tab, the focus ring. It has two uses that are not interactive, the kit's meter fill and the wordmark's "capital". No action takes any other colour.

**The Ink Figures Rule.** Rates and counts in the reach ledger, the step chips and the price are bold, tabular Ink. A royalty rate is a default term, not money that has moved, so it never takes lime or violet.

## Typography

**Display Font:** the kit's sans stack (-apple-system, SF Pro Text, Segoe UI, Inter, Roboto, system-ui)
**Body Font:** the same stack
**Label/Mono Font:** ui-monospace (SF Mono, Menlo, Consolas), for addresses and hashes only

**Character:** The kit's one sans family at every size, which is the "system type" the direction contract names as part of the .lol world. Weight carries the hierarchy. The name is 750, heads and figures are 700, row titles, buttons and badges are 600, and reading text is 400. Mono appears only where the content is an address.

### Hierarchy
- **Display** (750, clamp(2.25rem, 1.4rem + 3vw, 3.75rem), 1.02, -0.035em, balanced wrap): the company or agent name, once per page.
- **Headline** (700, 32px when the kit container is 1024px or wider, 24px from 620px to 1023px, 20px below 620px, tabular): the share price in the raise box, and the count that opens the reach section. It sits inside a sentence ("**0.10 USDC** a share"), never in a stat tile.
- **Title** (700, 17px, 24px, -0.01em): section heads and the raise box head. The wordmark uses the same size and weight.
- **Lead** (400, 17px, 24px, Second Ink): the one-paragraph summary under the name, at a 64ch measure.
- **Body** (400, 15px, 22px): term values and running explanations, each held to a 64ch measure.
- **Control** (600, 13px, 0.005em): button, tab and field-label text. Large buttons step up to 15px.
- **Small** (13px, 18px): term labels, sums labels, row sub-lines and the sources footer.
- **Label** (12px, 16px): row meta, badges (600), step chips, switcher group names and field hints.
- **Micro** (500, 10px, 14px, Muted, tabular): the sub-line under each switcher tab ("7 members", "paid by 11", "demo · Base Sepolia").

### Named Rules
**The Tabular Rule.** Figures that line up for comparison are set in tabular numerals: reach rates and counts, step chips, the price, sums, sold-of-cap, row meta (block numbers, dates), switcher sub-lines and the shares input. The terms values and the activity lines are tabular too.

**The Mono-Is-Data Rule.** Monospace is used only for addresses: treasury, operator and contract in the terms, the activity lines, the demo-raise tab, the connected account, and the treasury field. Prose, numbers and labels are never mono. Short addresses in the activity lines and on the demo-raise tab are mono as well.

## Layout

The page is one centred column, at most 1200px wide. The kit's container queries set the gutter (12px from 268px to 419px, 16px to 619px, 24px to 1023px, 32px from 1024px) and the touch sizing (controls are 40px tall and inputs 16px below 420px; desktop controls are 36px). A top bar holds the wordmark and network badge on the left and the wallet on the right, with 16px of block padding and a 1px rule beneath. Below it, the switcher sets three labelled tab strips (Raises, Companies, Authors with reach) in one wrapping band, with the find field pushed to the right.

The body is a two-column grid: the prospectus at `minmax(0, 1fr)` and the raise at 22rem, 64px apart, with 48px above and 64px below. The name and lead sit at the top of the left column. The raise box spans both rows and is sticky 24px from the top. At 960px and narrower the grid becomes one column in the order name, raise box, prospectus, so the buy action stays in the first screen, and the find field runs full width. At 560px and narrower the terms stack label over value, the full contract address gives way to its short form, and each switcher group becomes a 5.5rem label column beside a scrolling strip. A strip that overflows fades its last 3rem with a mask.

The rhythm is 48px between sections, 12px from a section head to its content, 64px above the sources footer, and a 64ch measure for running text. Spacing comes only from the 4/8/12/16/24/32/48/64 scale.

**The Raise Stays in Reach Rule.** The raise box is pinned beside the prospectus on desktop and moves directly under the name on narrow screens. The primary action never sits below the ledgers.

**The Ruled Ledger Rule.** Repeated facts are rows in one list, separated by 1px Rule Indigo lines. They are never separate cards with gaps between them.

## Elevation & Depth

Depth here is a hybrid: a flat ground, with the kit's soft two-layer shadows on the surfaces that hold rows and the one that holds the money. The direction contract called the surfaces "flat". The build lifts lists slightly and the raise box a step more, and the build wins. Each shadow pairs a vertically offset key at 34% black with a 1px-blurred contact layer at 26%. The terms ledger and the sums ledger carry no shadow and no fill. They are rules drawn on the ground.

### Shadow Vocabulary
- **Ledger** (`box-shadow: 0 1.5px 5px rgba(0,0,0,.34), 0 1px 2px rgba(0,0,0,.26)`): every row list (reach, apps, socnet, activity).
- **Raise** (`box-shadow: 0 3px 10px rgba(0,0,0,.34), 0 1px 2px rgba(0,0,0,.26)`): the raise box, the most lifted object at rest.
- **Hover lift** (`box-shadow: 0 5.4px 18px rgba(0,0,0,.34), 0 1px 2px rgba(0,0,0,.26), inset 0 1px 0 rgba(255,255,255,.09)`): a button under the pointer, with a hairline top edge.
- **Press** (`box-shadow: 0 0.6px 2px rgba(0,0,0,.34), 0 1px 2px rgba(0,0,0,.26)` plus a 1px downward move): a button being pressed.

### Named Rules
**The One Lifted Box Rule.** At rest nothing rises above the ledger level except the raise box. Hover can lift a button higher, but nothing stays there.

## Shapes

The form language is square. Buttons, inputs, badges, chips, lists, notices, the meter and the raise box all have 0px corners. Round shapes are reserved for two things: avatars (24px initials discs in a 1px line ring) and the 14px loading spinner. Borders are 1px throughout. The only 2px marks are the current tab's underline and the focus outline.

**The Square Corner Rule.** Corners are 0px. Only avatars and the spinner are round.

## Components

### Buttons
Buttons are blunt and solid: rectangles that state their action in words.
- **Shape:** square corners (0px), 1px border.
- **Primary:** a violet fill with Violet Ink in 13px 600 type, 36px tall (40px on touch widths), with 16px side padding. In the raise box the large size runs full width at 44px, with 15px type and 24px padding. Wallet steps are numbered in the label itself: "1 of 2 · Approve 0.10 USDC", then "2 of 2 · Buy 1 share".
- **Hover / Focus:** hover adds the hover-lift shadow and a hairline top edge, and a press drops to the press shadow and moves 1px down. Focus is a 2px violet outline at a 2px offset.
- **Secondary:** a Raised Slate fill, a Strong Rule border and Ink text (Open, Claim).
- **Ghost:** transparent with Second Ink, and Raised Slate on hover (Book arrived USDC, Close the raise).
- **Disabled:** a Badge Slate fill, a Rule Indigo border, Muted text and a not-allowed cursor. Disabled buttons have no shadow and no movement.
- **Icons:** the kit's drawn mask icons (the wallet), 18px in default buttons and 20px in large ones. They inherit the text colour.

### Chips
- **Badges (status):** 20px tall with 6px padding, a 1px Rule Indigo border, a Badge Slate fill and Second Ink in 12px 600 type. A badge carries a status next to the thing it qualifies: Agent, not a company, or Company beside the name; Demo, Not a company and Unregistered in the raise box; the connected chain in the bar. A warn-toned badge changes only its text to amber. The network status (Testnet, or Simulated) is warn-toned in both places it shows: the bar and the raise box.
- **Step chips:** a 1px Rule Indigo border with no fill and 2px by 8px padding. The type is 12px Second Ink with the figure in bold Ink ("step 2 · **5%**"). They set out the default royalty schedule, or the count of paying apps at each step.
- **Member chips:** a Ledger Slate fill, a 1px Rule Indigo border, a 24px avatar and the member's name as a 600-weight link, followed by their rank in Muted meta.

### Cards / Containers
- **Ledger list:** a Ledger Slate fill, a 1px Rule Indigo border and the ledger shadow, with no gap between rows. Rows are at least 48px tall, with 12px by 16px padding and a 1px rule between each.
- **Reach row:** a fixed 3.25rem rate column (17px 700 tabular Ink), then a title and sub-line ("includes X through 1 other app"), then meta ("step 2 · terms") that links to the API's terms. When a whole row is pickable (Widest reach on handoff today), it is one button. On hover the row turns Raised Slate and the "open" meta turns violet.
- **Corner Style:** square (0px).
- **Internal Padding:** 12px by 16px in rows and 24px in the raise box.

### Inputs / Fields
- **Style:** a Well fill, a 1px Strong Rule border and square corners. Height is 36px (40px on touch widths) and type is 15px (16px on touch widths). Number inputs have no spinner.
- **Label and hint:** the label sits above in 13px 600 Second Ink, and the hint below in 12px Muted. The shares field's hint states the cost and where it goes: "Costs 0.10 USDC. Goes to the treasury, not this contract."
- **Focus:** the border turns violet with an inset 1px violet ring and no outline. On hover the border lightens to Second Ink.

### Navigation
- **Switcher:** a tab strip per group. Each tab has two lines: the id in 13px 600 Second Ink over a 10px Muted tabular sub-line. Hover gives Raised Slate and Ink. The current tab takes Ink with a 2px violet underline. Strips have no bottom rule, scroll sideways with no visible scrollbar, and fade at the edge they hide. A 12px Muted group name labels each strip: above it on desktop, beside it at phone width.
- **Top bar:** the wordmark "handoff **capital**" (17px 700, with "capital" in violet), the network badge, and the wallet on the right: either the primary Connect wallet button, or a chain badge plus the short address in mono.

### Terms Ledger (signature)
The fixed terms of the raise, as a definition list ruled onto the ground. Each term is a two-column row: a 9rem label (13px Second Ink) and a 15px Ink value, with 12px of block padding and 1px Rule Indigo lines above and between. There is no fill and no shadow. Values link to the explorer: addresses are in mono and violet, and the full contract address collapses to its short form on narrow screens. Under 560px each label sits above its value.

### Sums Ledger (signature)
The live dividend figures, in the same ruled form as the terms. Each line has a 13px Second Ink label on the left and a 17px bold tabular lime value on the right: booked to holders, claimed, arrived but not booked, and holders.

### Raise Box (signature)
The one raised object, holding the primary action. It has a Ledger Slate fill, a 1px Strong Rule border, the raise shadow, 24px padding and a 12px gap between its parts. Top to bottom it holds:
- the "Back <id>" title;
- the status badges;
- the price as a Headline inside a sentence;
- the meter, a 4px Badge Slate track with a violet fill at sold over cap whose width eases over 280ms;
- "0 of 1000 sold · 1000 left" in small tabular Second Ink;
- the Shares field;
- the primary action;
- a busy line with a violet-topped spinner;
- any notice;
- once a wallet is connected, a ruled holder block: your shares, claimable now in lime, and a two-up row of Claim and Book. When no share contract exists, the same box holds the operator's launch form.

### Reach Ledger Entrance
The single authored motion. Reach rows rise 6px over 280ms on the kit ease, cubic-bezier(.2, .8, .2, 1), and each row starts 45ms after the one before it, up to row 12. The page re-renders only what changed, so the entrance plays once per company. Under reduced motion it does not play.

### Notices
These are the kit's notice blocks, used as the kit ships them: a Badge Slate fill and a 1px Rule Indigo border, toned success, warn, or violet by default. The kit draws the tone as a 3px inset edge. That edge belongs to the kit's notice and to nothing else on this page, and it is not a pattern to extend to rows, cards or callouts. Each notice states the outcome and its next step, and a confirmed transaction links to it with "View".

## Do's and Don'ts

### Do:
- **Do** keep lime (#ccff3b) for the live dividend set only (claimable, booked, claimed, arrived but not booked, holders), and set every other figure in tabular Ink (#eceaff).
- **Do** give every figure a source link where it sits: the API's terms, an explorer address, a transaction's block, an API response.
- **Do** separate repeated facts with 1px Rule Indigo (#43438c) lines inside one list or ledger.
- **Do** keep corners at 0px, with round shapes only for avatars and the spinner.
- **Do** name each section by the question it answers ("Who pays Henrich when they sell", "Terms of the raise").
- **Do** put status in a badge beside what it qualifies (Testnet, Simulated, Demo, Not a company, Unregistered).
- **Do** keep the raise box the only object lifted to the raise shadow, and keep it in the first screen at every width.
- **Do** number wallet steps inside the button label ("1 of 2 · Approve", "2 of 2 · Buy").

### Don't:
- **Don't** add a price chart, a countdown or a hype meter.
- **Don't** put a label, kicker or eyebrow above a heading. The heading speaks alone.
- **Don't** number sections.
- **Don't** use lime on actions, links, rates, API counts or decoration, and don't use lime as ink on the light palette (1.1:1).
- **Don't** split repeated facts into separate cards with gaps, and don't nest a card inside the raise box.
- **Don't** set anything in mono that is not an address or hash.
- **Don't** round the corners of buttons, inputs, badges, lists or the raise box.
