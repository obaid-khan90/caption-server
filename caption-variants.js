const CAPTION_VARIANTS = {
  box: {
    tier: 'ass-basic',
    intent: 'Rounded caption box behind text.',
    assStrategy: 'box',
    fallback: 'box'
  },
  bubble: {
    tier: 'ass-basic',
    intent: 'Pill-shaped bubble background behind text.',
    assStrategy: 'box-rounded',
    fallback: 'box'
  },
  subtitles: {
    tier: 'ass-basic',
    intent: 'Wide subtitle band behind the caption area.',
    assStrategy: 'subtitle-band',
    fallback: 'box'
  },
  outline: {
    tier: 'ass-basic',
    intent: 'Text with a medium black outline.',
    assStrategy: 'outline',
    fallback: 'none'
  },
  'bold-outline': {
    tier: 'ass-basic',
    intent: 'Text with a heavier black outline.',
    assStrategy: 'outline-heavy',
    fallback: 'outline'
  },
  neon: {
    tier: 'ass-layered',
    intent: 'Bright text with glow around the letters.',
    assStrategy: 'glow',
    fallback: 'outline'
  },
  gradient: {
    tier: 'ffmpeg-advanced',
    intent: 'Text filled with a left-to-right or top-to-bottom gradient.',
    assStrategy: 'gradient-approx',
    fallback: 'outline'
  },
  'shadow-pop': {
    tier: 'ass-basic',
    intent: 'Text with a visible offset shadow and punchy presence.',
    assStrategy: 'shadow-strong',
    fallback: 'outline'
  },
  glitch: {
    tier: 'ass-layered',
    intent: 'RGB offset/glitch treatment behind main text.',
    assStrategy: 'rgb-split',
    fallback: 'outline'
  },
  extrude: {
    tier: 'ass-layered',
    intent: 'Fake 3D depth using stacked shadow layers.',
    assStrategy: 'extrude',
    fallback: 'bold-outline'
  },
  underline: {
    tier: 'ass-basic',
    intent: 'Outlined text with a strong underline bar below.',
    assStrategy: 'underline-bar',
    fallback: 'outline'
  },
  frosted: {
    tier: 'ffmpeg-advanced',
    intent: 'Semi-transparent frosted panel behind text.',
    assStrategy: 'glass-panel-approx',
    fallback: 'box'
  },
  comic: {
    tier: 'ass-layered',
    intent: 'Thick playful stroke treatment with colorful fill.',
    assStrategy: 'comic-stroke',
    fallback: 'bold-outline'
  },
  fire: {
    tier: 'ffmpeg-advanced',
    intent: 'Warm glowing fire gradient text.',
    assStrategy: 'warm-glow-approx',
    fallback: 'outline'
  },
  ice: {
    tier: 'ffmpeg-advanced',
    intent: 'Cool glowing ice gradient text.',
    assStrategy: 'cool-glow-approx',
    fallback: 'outline'
  },
  'colored-stroke': {
    tier: 'ass-basic',
    intent: 'Solid text with a colored stroke from the background/accent color.',
    assStrategy: 'colored-outline',
    fallback: 'outline'
  },
  'neon-box': {
    tier: 'ass-layered',
    intent: 'Glowing text with a glowing outlined box.',
    assStrategy: 'glow-box',
    fallback: 'box'
  },
  retro: {
    tier: 'ass-layered',
    intent: 'Vintage heavy stroke treatment with warm accent colors.',
    assStrategy: 'retro-stroke',
    fallback: 'bold-outline'
  },
  'split-color': {
    tier: 'ass-layered',
    intent: 'Single text block split into two fill colors.',
    assStrategy: 'split-fill',
    fallback: 'outline'
  },
  none: {
    tier: 'ass-basic',
    intent: 'Plain text with no special variant treatment.',
    assStrategy: 'plain',
    fallback: 'none'
  }
};

function normalizeVariantName(variant) {
  return typeof variant === 'string' ? variant.trim().toLowerCase() : '';
}

function getCaptionVariantConfig(variant) {
  const normalized = normalizeVariantName(variant);
  if (!normalized) return CAPTION_VARIANTS.none;
  return CAPTION_VARIANTS[normalized] || CAPTION_VARIANTS.none;
}

module.exports = {
  CAPTION_VARIANTS,
  getCaptionVariantConfig,
  normalizeVariantName
};
