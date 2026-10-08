# Brand marks in HQ Desktop

The Launch menu and the console-rail buttons show marks for Claude Code, Codex
and Grok Build. The registry is `packages/ui/src/common/button/rail-icons.ts`
(`BRAND_ICONS`). Each mark refers to the vendor's own tool and is shown only
next to the action that opens that tool. Sources were read on 2026-10-02.

## Claude Code: Claude Spark (Anthropic)

- Source: Anthropic press kit, https://www.anthropic.com/press-kit (redirects to
  a zip on www-cdn.anthropic.com). File used:
  `Anthropic logos/Claude logos/3 Claude Spark/SVG/Claude Spark - Clay.svg`.
- Terms: the press kit has no licence file. The full brand guidelines at
  brand.anthropic.com need an email login and were not read. Questions go to
  press@anthropic.com.
- Treatment: path data copied unchanged, native 94×94 viewBox, rendered at
  14px in the official Clay colour (#D97757). No recolouring, because the
  guidelines that would allow it could not be read.

## Codex: OpenAI Blossom (OpenAI)

- Source: OpenAI design guidelines, https://openai.com/brand/. Logo pack:
  https://cdn.openai.com/brand/openai-logos.zip. Files used:
  `OpenAI-logos/SVGs/OAI_OpenAI-Blossom_Black.svg` and the White variant
  (identical path).
- Terms read: use the logo only when it relates to OpenAI services; use it
  exactly as provided; do not modify it or add colours to the Blossom; do not
  use it more prominently than your own brand; permission requests go to
  partnercomms@openai.com. OpenAI does not publish a separate Codex mark on
  that page, so the OpenAI Blossom is used.
- Treatment: path data copied unchanged. The viewBox is cropped to the glyph
  (`176 176 364 364`) so it fills a 14px box. Fill is the official Black in
  light mode and the official White in dark mode; no other colour is applied.

## Grok Build: hand-drawn mark kept (xAI)

- Source checked: SpaceXAI brand guidelines (dated February 14, 2025),
  https://x.ai/legal/brand-guidelines. Asset link on that page:
  https://data.x.ai/logos/SpaceXAI_Grok_Assets.zip.
- Result: the zip download returned HTTP 403 from the site's bot protection,
  so no official SVG was obtained.
- Terms read: use the marks only to refer accurately to SpaceXAI or its
  services; do not imply endorsement; use logos only exactly as provided at
  the download link, without alteration. SpaceXAI also states it may withdraw
  permission at any time.
- Treatment: the previous simplified slashed-ring glyph stays, in the text
  colour. Replace it with the file from the zip, unaltered, once someone
  downloads it from a browser.

## Provider marks on My Telemetry

`packages/ui/src/common/provider-marks.ts` draws a 14px provider mark before
each model or family name on the Tokens page, tinted with that family's chart
color. The Anthropic mark is the `simple-icons` "Anthropic" path (CC0 1.0).
The OpenAI mark reuses the Blossom path above and the xAI mark reuses the Grok
glyph above. Unknown providers show a plain disc.

OpenAI's brand terms ask that the Blossom not be recolored. On this page the
mark is a series key for a chart, tinted with the OpenAI family color; if that
is judged to fall under the brand terms, render the OpenAI mark in the text
color and keep the color on the share bar only.
