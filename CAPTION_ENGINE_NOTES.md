# Caption Engine Notes

## Initial Assessment

This service is a compact Node.js caption-burn server built around:

- `Express` for the API
- `Whisper` transcription via a Supabase Edge Function
- `ASS subtitles` for caption styling
- `FFmpeg` for final burn-in
- `Supabase Storage` for output upload
- `Supabase DB sync` for post-processing updates

At the start of the review, the code already supported:

- authenticated `POST /render`
- remote video download from `cleanVideoUrl`
- optional auto-transcription when `segments` are missing
- caption burn-in through an `.ass` subtitle file
- basic style inputs:
  - `fontFamily`
  - `fontSize`
  - `fontColor`
  - `backgroundColor`
  - `position`
- upload of the rendered output to Supabase Storage
- DB updates for `scheduled_posts` and `media_library`
- temp file cleanup

Main limitations identified initially:

1. subtitle canvas was fixed at `720x1280`
2. auto-segmentation was hardcoded to `3 words per caption`
3. no per-word highlighting, karaoke, or richer visual effects
4. style model was too small for advanced caption looks

## What We Achieved So Far

### 1. Added word-level karaoke support

Original behavior:

- one subtitle event was created for the whole caption line
- captions were rendered as plain line text
- there was no true active-word behavior

Upgraded behavior:

- segments now preserve per-word timing data
- the renderer now creates one timed ASS dialogue event per active spoken word
- each event still shows the full caption line
- only the currently spoken word gets highlight styling
- plain text remains as a fallback when word timing is unavailable

Implemented:

- preservation of per-word timing in generated segments
- active-word scoped ASS rendering
- fallback to plain text when word timing is not available

Supported `wordEffect` values:

- `karaoke-fill`
- `karaoke`
- `karaoke-outline`

These map to ASS behavior using:

- `\kf`
- `\k`
- `\ko`

### 2. Added simple caption animation support

Implemented:

- `fade`
- `pop`

Original behavior:

- there was no animation support

Upgraded behavior:

- `fade` can be applied to caption events
- `pop` now applies only to the active spoken word, not the entire line

Notes:

- `fade` remains line/event scoped
- `pop` is now word scoped

Supported `animation` values:

- `fade`
- `pop`

### 3. Added highlight color support

Implemented:

- `highlightColor`

Original behavior:

- only a base font color existed

Upgraded behavior:

- a separate `highlightColor` is now supported
- active-word highlighting uses this color
- if not supplied, it falls back to `fontColor`

### 4. Replaced fixed 3-word auto-segmentation

Original behavior:

- transcription words were grouped in fixed `3-word` chunks
- segments did not break on pauses, punctuation, or reading rhythm

Upgraded behavior:

- the hardcoded `3-word` split has been removed for auto-transcribed captions
- segmentation is now rule-based and automatic for all transcription requests

It now uses a built-in smart segmentation approach that automatically breaks on:

- around `5` words max
- around `28` characters max
- pauses of `350ms+`
- punctuation such as `. , ! ? : ;`
- caption duration around `2200ms`

This improved natural phrasing without requiring any new API parameters.

### 5. Added dynamic subtitle canvas sizing

Original behavior:

- ASS subtitles were always authored against a fixed `720x1280` canvas
- margins were fixed for that assumed frame size

Upgraded behavior:

- the input video is now probed with `ffprobe`
- `PlayResX` and `PlayResY` are now set from the real video dimensions
- horizontal and vertical margins scale from the actual frame size
- if probing fails, the server falls back to `720x1280`

This makes caption placement more reliable across portrait and landscape videos.

### 6. Added variant definition layer

Original behavior:

- `variant` could be present in incoming requests, but there was no formal server-side meaning for it
- the caption server did not define which variant values were supported

Upgraded behavior:

- the server now has a central variant registry
- incoming `captionStyle.variant` values are normalized
- each supported variant now has:
  - an intended visual meaning
  - an implementation tier
  - an ASS strategy name
  - a fallback target
- unknown variants safely fall back to `none`

Implemented:

- central variant definition file
- request-time variant normalization
- request-time variant config resolution

Current supported variant names:

- `box`
- `bubble`
- `subtitles`
- `outline`
- `bold-outline`
- `neon`
- `gradient`
- `shadow-pop`
- `glitch`
- `extrude`
- `underline`
- `frosted`
- `comic`
- `fire`
- `ice`
- `colored-stroke`
- `neon-box`
- `retro`
- `split-color`
- `none`

Notes:

- this step defines the mapping layer only
- it does not yet implement full visual behavior for every variant
- current rendering remains compatible while variant-specific rendering is built incrementally

### 7. Implemented ASS-basic variant rendering

Original behavior:

- `variant` was classified but did not change rendering behavior yet

Upgraded behavior:

- the first group of ASS-friendly variants now changes the generated subtitle style
- these variants now apply concrete ASS overrides at render time

Implemented variants in this step:

- `box`
- `bubble` approximate
- `subtitles` approximate
- `outline`
- `bold-outline`
- `shadow-pop`
- `underline`
- `colored-stroke`
- `none`

How they are currently implemented:

- `box`: boxed background with padding
- `bubble`: box-style approximation with larger padding
- `subtitles`: wider boxed subtitle-band approximation
- `outline`: medium outline text
- `bold-outline`: heavier outline plus bold text
- `shadow-pop`: stronger shadow plus heavier text treatment
- `underline`: ASS underline plus outlined text treatment
- `colored-stroke`: colored outline derived from the background/accent color
- `none`: plain text-oriented styling with transparent background

Notes:

- `bubble` and `subtitles` are currently approximations inside ASS limitations
- more advanced/layered variants are still pending

### 8. Implemented first layered ASS variant rendering

Original behavior:

- layered variants were defined in the registry, but they still rendered like the default/basic path

Upgraded behavior:

- layered variants now emit multiple ASS dialogue layers for the same caption moment
- this allows approximations for glow, RGB split, extrude, thicker comic-style strokes, and similar looks

Implemented variants in this step:

- `neon`
- `glitch`
- `extrude`
- `comic`
- `retro`
- `split-color`
- `neon-box`

How they are currently implemented:

- `neon`: blurred glow layers plus main text
- `glitch`: cyan/magenta offset layers plus main text
- `extrude`: stacked dark offset layers plus main text
- `comic`: thick accent stroke layer, black stroke layer, then main text
- `retro`: warm stroke layer, black stroke layer, then main text
- `split-color`: clipped upper/lower color approximation
- `neon-box`: glowing box approximation plus glowing text layers

Notes:

- these are ASS approximations of the old canvas intent
- `split-color` is currently an approximate clipped implementation
- hard variants like `gradient`, `frosted`, `fire`, and `ice` are still pending

### 9. Implemented ASS-first approximations for the hard variant group

Original behavior:

- hard variants were classified, but they had no dedicated rendering behavior yet

Upgraded behavior:

- the hard group now renders through ASS-first approximations
- these implementations keep the current pipeline simple while providing immediate usable output

Implemented variants in this step:

- `gradient`
- `frosted`
- `fire`
- `ice`

How they are currently implemented:

- `gradient`: clipped multi-band color fill approximation
- `frosted`: soft panel/glass-style approximation with layered border and fill
- `fire`: warm glow and warm fill approximation
- `ice`: cool glow and cool fill approximation

Notes:

- these are not full FFmpeg overlay implementations yet
- they are intentionally ASS-based approximations of the old canvas intent
- a future FFmpeg path can still improve these variants further

### 10. Reworked caption timing architecture for stable backgrounds and cleaner overlays

Original behavior:

- every active-word state re-rendered the full styled line
- boxed/panel variants could visually morph as the active word changed
- styles like `box` and `fire` could feel jittery because the whole caption treatment was tied to per-word redraws

Upgraded behavior:

- each segment now renders through a stable base caption layer for the full segment duration
- active-word emphasis is rendered as a separate timed overlay
- backgrounds and full-line treatments stay stable while the spoken word changes

Benefits:

- more stable `box` / panel-like variants
- cleaner active-word pop behavior
- better foundation for `fire`, `ice`, `frosted`, and `neon-box`
- less visual jitter caused by word-by-word full-line redraws

## Current CaptionStyle Support

The code currently supports these `captionStyle` inputs:

- `fontFamily`
- `fontSize`
- `fontColor`
- `highlightColor`
- `backgroundColor`
- `outlineColor`
- `outlineWidth`
- `shadowSize`
- `bold`
- `italic`
- `spacing`
- `borderStyle`
- `position`
- `wordEffect`
- `animation`
- `variant`

Notes:

- styling is driven directly by the incoming `captionStyle` request body
- `variant` is now accepted and normalized against a central registry
- variant-specific visual rendering is not fully implemented yet
- there is no preset registry in the current code

Supported enum-like values:

- `position`: `top`, `middle`, `bottom`
- `wordEffect`: `karaoke-fill`, `karaoke`, `karaoke-outline`
- `animation`: `fade`, `pop`

Supported `variant` values:

- `box`
- `bubble`
- `subtitles`
- `outline`
- `bold-outline`
- `neon`
- `gradient`
- `shadow-pop`
- `glitch`
- `extrude`
- `underline`
- `frosted`
- `comic`
- `fire`
- `ice`
- `colored-stroke`
- `neon-box`
- `retro`
- `split-color`
- `none`

## What Is Still Needed

### 1. Expanded style model

To support richer caption styles, `captionStyle` can still grow with more fields such as:

- `outlineColor`
- `outlineWidth`
- `shadowColor`
- `shadowSize`
- `blur`
- `bold`
- `italic`
- `spacing`
- `scaleX`
- `scaleY`
- `lineSpacing`
- `textTransform`

### 2. More advanced ASS tags

Needed for broader style coverage:

- `\bord`
- `\shad`
- `\blur`
- `\be`
- `\fsp`
- `\fscx`
- `\fscy`
- `\b1`
- `\i1`
- `\pos`
- `\move`
- `\t(...)`

This would allow better support for:

- outline variants
- shadow variants
- comic-style captions
- bubble approximations
- title-style captions
- neon approximations

### 3. FFmpeg filtergraph-based effects for styles ASS cannot do well

Some styles discussed earlier do not map cleanly to plain ASS.

These include:

- `Glitch White`
- `Fire`
- `Ice`
- `Frosted Glass`
- `Cinema Blur`
- strong gradient-driven styles

To support those properly, further work is needed:

- FFmpeg filtergraph overlays
- blur/mask effects behind caption areas
- pre-rendered overlay assets or text textures
- multi-pass rendering for complex looks

### 4. Variant classification and rollout plan

Variants are now formally classified into implementation groups:

- easy with ASS only
- medium with layered ASS
- hard and need FFmpeg effects

Recommended rollout order:

1. dynamic canvas sizing
2. define `variant` meaning and mapping rules
3. implement ASS-basic variants
4. implement layered ASS variants
5. expand style fields where needed
6. improve hard variants with FFmpeg effects where needed

## Practical Status Summary

Current status:

- the server is no longer limited to fixed `3-word` transcription chunks
- active-word highlighting is now supported instead of full-line highlighting
- `pop` animation is now active-word scoped
- `fade` animation is supported
- highlight color is now supported
- dynamic subtitle canvas sizing is now supported
- styling is driven by raw `captionStyle` request fields
- `variant` is now normalized and resolved through a central registry
- each variant now has a documented intent, strategy, and fallback
- the ASS-basic variant group is now implemented
- the first layered ASS variant group is now implemented
- the hard variant group now has ASS-first approximations
- the renderer now uses a stable segment base plus active-word overlay architecture
- the API contract remains simple

Not done yet:

- advanced glow / blur / glitch / fire / ice styles
- FFmpeg-quality implementations for the hard variants
- FFmpeg-based cinematic effects

## Files Changed During This Work

- [index.js](D:\caption-server\index.js:1)
- [caption-variants.js](D:\caption-server\caption-variants.js:1)
