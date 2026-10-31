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
- Team feedback: "reads like a story, make it a little more fun"; then: compassionate for adult children with a parent in the hospital, readable, not AI slop, real photos, no fake demo story (a real demo video exists).

## Direction contract

THESIS: The Unc Daily. Every check-in call prints a fresh edition of the family's paper about their parent. The doctor, pharmacy and family agents are its reporters, and their Agent Relay dispatches are the news. It refuses the category default of a SaaS hero over feature cards.

OWN-WORLD: Black ink (#141414) on cool rag paper (#ECE9E1), with grain and uneven plate pressure done as SVG filters. One spot ink, press red (#B3261E), is reserved for stamps (EXTRA, LATE EDITION, WATCH or URGENT) and live markers. The masthead is hand-drawn. IM Fell only for the masthead and display headlines. All body and UI text uses one clean, highly readable face with lining figures, at 18–20px body. Readability first: crisp, generous, and texture never behind body text. The page is built from column rules, boxed notices, and woodcut-style line spot illustrations.

STORY: The adult child sees their parent get a call, sees a care team work the case, and reads the paper. They believe it's real, because the dispatches typeset themselves live, and they press "Try the live demo".

FIRST VIEWPORT: The full-width masthead "THE UNC DAILY", with a date line and a red LATE EDITION stamp. The lead "No parent ages alone." at 96–112px and a deck written to the adult child. The lead photo (Joe on his morning call, a newspaper-printed AI illustration, captioned and credited). A "Press run" box holding the solid-ink "Try the live demo" block and the video link. One calm focal point. No scripted demo story: the team's real demo video gets its own "See it work" section.

FORM: The catalog world graphic-worlds-publishing-expedition-ice-press (bolder register, chosen by the user), fused with the product. Compassion and fun come from inside the newspaper world: documentary photos printed newspaper-style, a 4-panel strip for "How it works", classifieds for "Built with", letters to the editor for the FAQ, and a red EXTRA stamp that slams down on a status change. The signature interaction is new dispatches typesetting in, with ink spreading. On `/live`, the next check-in reads "Next edition in mm:ss". seed: 26689e2c8fe29c80

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance

## Memorable moment

A status change slams a red "EXTRA!" stamp across the Live Edition while the dispatches typeset in.

## Unresolved

- The final product name ("Unc" is a placeholder).
- The demo video URL (P5).
