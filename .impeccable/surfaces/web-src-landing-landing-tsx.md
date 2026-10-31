---
version: 1
slug: "web-src-landing-landing-tsx"
primary_target: "web/src/landing/Landing.tsx"
related_targets: ["web/src/main.tsx","web/src/CallPanel.tsx","web/src/CareFeed.tsx","web/src/styles.css"]
---

## Scope and mode

- `/` landing page: **Persuade**. `/live` demo dashboard: **Operate**, in the same world.
- Audience: judges today. The real customer is adult children of a sick or aging parent, and hospitals that discharge those parents. The landing page speaks to the adult child.
- Action: "Try the live demo" (to `/live`). Secondary: "Watch the demo video", shown only when `VITE_DEMO_VIDEO_URL` is set.
- Proof: the live agent conversation (real Agent Relay traffic) and cited public stats only. The demo people are fictional and labeled that way.
- Team feedback on the chosen preview: "reads like a story, make it a little more fun."

## Direction contract

THESIS: The Unc Daily. Every check-in call prints a fresh edition of the family's paper about their parent. The doctor, pharmacy and family agents are its reporters, and their Agent Relay dispatches are the news. It refuses the category default of a SaaS hero over feature cards.

OWN-WORLD: Black ink (#141414) on cool rag paper (#ECE9E1), with grain and uneven plate pressure done as SVG filters. One spot ink, press red (#B3261E), is reserved for stamps (EXTRA, LATE EDITION, WATCH or URGENT) and live markers. The masthead is hand-drawn. Type is IM Fell: French Canon for display, DW Pica for text, English SC for heads, with lining numerals wherever figures must read (times, doses, countdowns). The page is built from column rules, boxed notices, and woodcut-style line spot illustrations.

STORY: The adult child sees their parent get a call, sees a care team work the case, and reads the paper. They believe it's real, because the dispatches typeset themselves live, and they press "Try the live demo".

FIRST VIEWPORT: The full-width masthead "THE UNC DAILY", with a date line and a red LATE EDITION stamp. The lead "No parent ages alone." at 96–112px, then a deck sentence. On the right, a "Press run" box holding the solid-ink "Try the live demo" block and the video link. Under the fold rule: "Joe was dizzy and out of his pills. Three agents took the case." and three dispatch columns that typeset themselves.

FORM: The catalog world graphic-worlds-publishing-expedition-ice-press (bolder register, chosen by the user), fused with the product. The fun comes from inside the newspaper world: a 4-panel woodcut strip for "How it works", Joe's status as a weather box, classifieds for "Built with", and a red EXTRA stamp that slams down on a status change. The signature interaction is new dispatches typesetting in, with ink spreading. On `/live`, the next check-in reads "Next edition in mm:ss". seed: 26689e2c8fe29c80

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance

## Memorable moment

A status change slams a red "EXTRA!" stamp across the Live Edition while the dispatches typeset in.

## Unresolved

- The final product name ("Unc" is a placeholder).
- The demo video URL (P5).
