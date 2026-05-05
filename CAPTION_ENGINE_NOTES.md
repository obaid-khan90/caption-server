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
4. no named caption presets such as `MrBeast Yellow`, `Frosted Glass`, etc.
5. style model was too small for advanced caption looks

## What We Achieved So Far

### 1. Added word-level karaoke support

The render pipeline now supports word-timed ASS output instead of only plain line text.

Implemented:

- preservation of per-word timing in generated segments
- ASS karaoke tag generation
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

These are injected as ASS override tags per subtitle line.

Supported `animation` values:

- `fade`
- `pop`

### 3. Added highlight color support

Implemented:

- `highlightColor`

This is used as the ASS `SecondaryColour`, which works with karaoke styling.

### 4. Replaced fixed 3-word auto-segmentation

The original hardcoded segmentation logic has been removed for auto-transcribed captions.

It now uses a built-in smart segmentation approach that automatically breaks on:

- around `5` words max
- around `28` characters max
- pauses of `350ms+`
- punctuation such as `. , ! ? : ;`
- caption duration around `2200ms`

This improved natural phrasing without requiring any new API parameters.

## Current CaptionStyle Support

The code currently supports these `captionStyle` inputs:

- `fontFamily`
- `fontSize`
- `fontColor`
- `highlightColor`
- `backgroundColor`
- `position`
- `wordEffect`
- `animation`

Supported enum-like values:

- `position`: `top`, `middle`, `bottom`
- `wordEffect`: `karaoke-fill`, `karaoke`, `karaoke-outline`
- `animation`: `fade`, `pop`

## What Is Still Needed

### 1. Dynamic subtitle canvas sizing

Still needed:

- detect actual input video dimensions with `ffprobe`
- set `PlayResX` and `PlayResY` dynamically
- scale margins and font sizing more reliably for landscape and portrait videos

Without this, captions are still authored against a fixed `720x1280` ASS canvas.

### 2. Preset-based caption styles

To support named styles like:

- `MrBeast Yellow`
- `Outline White`
- `Neon Cyan`
- `Minimal`
- `Cinema Black`

the code needs:

- a preset registry in code
- mapping from preset name to ASS style values
- merging logic so presets and explicit overrides can coexist cleanly

### 3. Expanded style model

To support richer visual presets, `captionStyle` needs more fields such as:

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

### 4. Multi-layer ASS rendering

Many advanced looks cannot be achieved with a single `Style: Default` and one subtitle layer.

Needed:

- support for multiple ASS styles
- support for multiple `Dialogue` layers per caption
- layered text rendering for:
  - fake glow
  - fake 3D
  - heavier outline treatments
  - split-color looks

### 5. More advanced ASS tags

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

### 6. FFmpeg filtergraph-based effects for styles ASS cannot do well

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

### 7. Preset classification and rollout plan

The remaining styles should be split into implementation groups:

- easy with ASS only
- medium with layered ASS
- hard and need FFmpeg effects

Recommended rollout order:

1. dynamic canvas sizing
2. preset registry with ASS-friendly styles
3. expanded style fields
4. layered ASS rendering
5. FFmpeg effects for hard presets

## Practical Status Summary

Current status:

- the server is no longer limited to fixed `3-word` transcription chunks
- karaoke-style per-word highlighting is now supported
- basic line animation is now supported
- highlight color is now supported
- the API contract has only lightly changed and remains simple

Not done yet:

- preset caption themes
- dynamic subtitle canvas
- advanced glow / blur / glitch / fire / ice styles
- layered text rendering
- FFmpeg-based cinematic effects

## Files Changed During This Work

- [index.js](D:\caption-server\index.js:1)
