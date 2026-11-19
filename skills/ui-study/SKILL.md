---
name: anticodex-ui-study
description: The ANTICODEX 2.7 design language - centered editorial chat column, serif hero, soft user pills, hover actions, token-only colour. Keep new UI consistent with it.
---
# ANTICODEX design language (2.7)
- Conversation: centered max-width 48rem, prose 1rem/1.75, user turns as a soft
  right-aligned pill (bg-elev, 18px radius), assistant flat full-width.
- Hero: serif display (Georgia), clamp(1.8rem,4vw,2.6rem), centered, quiet subtext.
- Composer: floating card, 24px radius, border + shadow, bg-composer.
- Actions: hover-revealed, focus-within visible; never glow, never gradient text.
- Colour: ONLY existing CSS tokens. Light theme is a variable swap; never bake
  hex into a surface rule.
- Motion: 150ms ease; prefers-reduced-motion disables it.
- Every static className needs a CSS rule; every input needs an accessible name.
