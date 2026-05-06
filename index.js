const express = require('express');
const ffmpeg = require('fluent-ffmpeg');
// const ffmpegInstaller = require('@ffmpeg-installer/ffmpeg');
// const ffprobeInstaller = require('@ffprobe-installer/ffprobe');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const helmet = require('helmet');
const morgan = require('morgan');
const { getCaptionVariantConfig, normalizeVariantName } = require('./caption-variants');
require('dotenv').config();

// Initialize Express app
const app = express();

// --- Middleware & Security ---
app.use(helmet()); // Sets secure HTTP headers
app.use(morgan('combined')); // Professional HTTP request logging
app.use(express.json());

const PORT = process.env.PORT || 8080;
const API_KEY = process.env.API_KEY || 'default-dev-key'; // Change in production!

// Setup FFmpeg paths: Use installers for local Windows dev, 
// but use system binary for production Linux (Railway) to save memory.
// if (process.platform === 'win32') {
//   ffmpeg.setFfmpegPath(ffmpegInstaller.path);
//   ffmpeg.setFfprobePath(ffprobeInstaller.path);
// }

// Setup Supabase
if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  console.error("❌ Missing Supabase environment variables");
  process.exit(1);
}
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// --- Helpers ---

// Convert MS to ASS time format (H:MM:SS.CC)
function msToAssTime(ms) {
  const totalSeconds = ms / 1000;
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = Math.floor(totalSeconds % 60);
  const cs = Math.round((totalSeconds % 1) * 100);
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
}

// Convert Hex to ASS BGR color
function hexToAssBgr(hex) {
  if (!hex || typeof hex !== 'string') return '&H00FFFFFF';
  const h = hex.replace('#', '');
  const r = h.slice(0, 2);
  const g = h.slice(2, 4);
  const b = h.slice(4, 6);
  return `&H00${b}${g}${r}`;
}

// Convert RGBA string to ASS BackColor format
function rgbaToAssBackColor(rgba) {
  if (!rgba || typeof rgba !== 'string') return '&H80000000';
  const match = rgba.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/);
  if (!match) return '&H80000000';
  const r = parseInt(match[1]).toString(16).padStart(2, '0');
  const g = parseInt(match[2]).toString(16).padStart(2, '0');
  const b = parseInt(match[3]).toString(16).padStart(2, '0');
  const alpha = match[4] !== undefined ? Math.round((1 - parseFloat(match[4])) * 255) : 128;
  const a = alpha.toString(16).padStart(2, '0');
  return `&H${a}${b}${g}${r}`;
}

function msToAssCentiseconds(ms) {
  return Math.max(1, Math.round(ms / 10));
}

function escapeAssText(text = '') {
  return String(text)
    .replace(/\\/g, '\\\\')
    .replace(/\{/g, '\\{')
    .replace(/\}/g, '\\}')
    .replace(/\n/g, '\\N');
}

function buildAnimationTag(animation) {
  switch (animation) {
    case 'fade':
      return '{\\fad(120,120)}';
    default:
      return '';
  }
}

function buildHighlightedWordTag(captionStyle) {
  const primary = hexToAssBgr(captionStyle.highlightColor || captionStyle.fontColor);
  const outline = hexToAssBgr(captionStyle.outlineColor || '#000000');
  const effect = captionStyle.wordEffect || captionStyle.effect || 'karaoke-fill';

  if (effect === 'karaoke-outline') {
    return `{\\1c${primary}\\3c${primary}\\bord${Math.max(2, Number(captionStyle.outlineWidth || 2) + 1)}}`;
  }

  if (effect === 'karaoke') {
    return `{\\1c${primary}\\b1}`;
  }

  return `{\\1c${primary}\\3c${outline}\\b1}`;
}

function buildWordAnimationTag(animation) {
  switch (animation) {
    case 'pop':
      return '{\\fscx135\\fscy135\\t(0,160,\\fscx100\\fscy100)}';
    default:
      return '';
  }
}

function buildWordScopedText(words, activeIndex, captionStyle, continuationTag = '{\\rDefault}') {
  const activeWordTag = `${buildHighlightedWordTag(captionStyle)}${buildWordAnimationTag(captionStyle.animation)}`;

  return words.map((word, index) => {
    const escapedText = escapeAssText(word.text || '');
    if (index !== activeIndex) {
      return escapedText;
    }

    return `${activeWordTag}${escapedText}${continuationTag}`;
  }).join(' ');
}

function buildSegmentBaseEvent(seg) {
  return {
    startMs: seg.startMs,
    endMs: seg.endMs,
    text: seg.text || '',
    words: Array.isArray(seg.words) ? seg.words.filter(word => word.text) : [],
    activeIndex: -1,
    renderMode: 'base'
  };
}

function buildSegmentDialogueEvents(seg, captionStyle) {
  const words = Array.isArray(seg.words) ? seg.words.filter(word => word.text) : [];
  const minWordDurationMs = 180;

  if (words.length === 0) return [];

  return words.map((word, index) => {
    const startMs = Number(word.startMs ?? seg.startMs ?? 0);
    const nextStartMs = Number(words[index + 1]?.startMs ?? word.endMs ?? seg.endMs ?? startMs + 10);
    const naturalEndMs = Number(word.endMs ?? nextStartMs ?? seg.endMs ?? startMs + minWordDurationMs);
    const endMs = Math.max(startMs + minWordDurationMs, naturalEndMs);

    return {
      startMs,
      endMs,
      text: seg.text || '',
      words,
      activeIndex: index,
      renderMode: 'active'
    };
  });
}

function isTransparentBackground(backgroundColor) {
  if (!backgroundColor || typeof backgroundColor !== 'string') return true;
  return /rgba?\(\s*0\s*,\s*0\s*,\s*0\s*(?:,\s*0(?:\.0+)?)?\s*\)/i.test(backgroundColor);
}

function applyReadabilityBaseline(captionStyle, renderContext) {
  const resolved = { ...captionStyle };
  const strategy = captionStyle.variantConfig?.assStrategy || 'plain';
  const isBoxFamily = ['box', 'box-rounded', 'subtitle-band', 'glass-panel-approx', 'glow-box'].includes(strategy);
  const isEffectFamily = ['glow', 'rgb-split', 'extrude', 'comic-stroke', 'retro-stroke', 'split-fill', 'warm-glow-approx', 'cool-glow-approx', 'gradient-approx'].includes(strategy);

  if (!isBoxFamily && isTransparentBackground(resolved.backgroundColor) === false && !['colored-outline'].includes(strategy)) {
    resolved.backgroundColor = 'rgba(0,0,0,0)';
  }

  resolved.fontSize = Math.max(Number(resolved.fontSize || 24), isEffectFamily ? 32 : 30);
  resolved.outlineWidth = Math.max(Number(resolved.outlineWidth || 0), isBoxFamily ? 1.5 : 2.5);
  resolved.shadowSize = Math.max(Number(resolved.shadowSize || 0), isEffectFamily ? 0.75 : 0);
  resolved.spacing = Math.max(Number(resolved.spacing || 0), 0.15);
  resolved.marginHorizontalRatio = Math.max(Number(resolved.marginHorizontalRatio || 0), 0.045);
  resolved.bottomSafeRatio = Math.max(Number(resolved.bottomSafeRatio || 0), 0.1);
  resolved.topSafeRatio = Math.max(Number(resolved.topSafeRatio || 0), 0.065);

  if (isEffectFamily && resolved.animation === 'pop') {
    resolved.animation = 'fade';
  }

  return resolved;
}

function resolveBasicVariantStyle(captionStyle, renderContext) {
  const resolved = { ...captionStyle };
  const strategy = captionStyle.variantConfig?.assStrategy || 'plain';
  const defaultBoxBackground = 'rgba(0,0,0,0.72)';

  switch (strategy) {
    case 'box':
      resolved.borderStyle = 3;
      resolved.boxPadding = Math.max(Number(resolved.boxPadding || 0), 12);
      resolved.outlineWidth = Math.max(Number(resolved.outlineWidth || 0), 1.5);
      resolved.shadowSize = 0;
      if (isTransparentBackground(resolved.backgroundColor)) {
        resolved.backgroundColor = 'rgba(0,0,0,0.82)';
      }
      break;
    case 'box-rounded':
      resolved.borderStyle = 3;
      resolved.boxPadding = Math.max(Number(resolved.boxPadding || 0), 18);
      resolved.outlineWidth = Math.max(Number(resolved.outlineWidth || 0), 1.5);
      resolved.shadowSize = 0;
      if (isTransparentBackground(resolved.backgroundColor)) {
        resolved.backgroundColor = 'rgba(0,0,0,0.82)';
      }
      break;
    case 'subtitle-band':
      resolved.borderStyle = 3;
      resolved.boxPadding = Math.max(Number(resolved.boxPadding || 0), 28);
      resolved.marginHorizontalRatio = 0.05;
      resolved.outlineWidth = Math.max(Number(resolved.outlineWidth || 0), 1.25);
      resolved.shadowSize = 0;
      if (isTransparentBackground(resolved.backgroundColor)) {
        resolved.backgroundColor = 'rgba(0,0,0,0.82)';
      }
      break;
    case 'outline':
      resolved.borderStyle = 1;
      resolved.outlineWidth = Math.max(Number(resolved.outlineWidth || 0), 2.5);
      resolved.shadowSize = Number(resolved.shadowSize || 0);
      break;
    case 'outline-heavy':
      resolved.borderStyle = 1;
      resolved.bold = true;
      resolved.outlineWidth = Math.max(Number(resolved.outlineWidth || 0), 4);
      resolved.shadowSize = Math.max(Number(resolved.shadowSize || 0), 0.5);
      break;
    case 'shadow-strong':
      resolved.borderStyle = 1;
      resolved.bold = true;
      resolved.outlineWidth = Math.max(Number(resolved.outlineWidth || 0), 2);
      resolved.shadowSize = Math.max(Number(resolved.shadowSize || 0), 3);
      break;
    case 'underline-bar':
      resolved.borderStyle = 1;
      resolved.bold = true;
      resolved.underline = true;
      resolved.outlineWidth = Math.max(Number(resolved.outlineWidth || 0), 2.5);
      break;
    case 'colored-outline':
      resolved.borderStyle = 1;
      resolved.outlineColor = !isTransparentBackground(resolved.backgroundColor)
        ? resolved.backgroundColor
        : resolved.fontColor;
      resolved.backgroundColor = 'rgba(0,0,0,0)';
      resolved.outlineWidth = Math.max(Number(resolved.outlineWidth || 0), 3.5);
      break;
    case 'gradient-approx':
      resolved.borderStyle = 1;
      resolved.bold = true;
      resolved.outlineWidth = Math.max(Number(resolved.outlineWidth || 0), 2.5);
      resolved.backgroundColor = 'rgba(0,0,0,0)';
      break;
    case 'glass-panel-approx':
      resolved.borderStyle = 3;
      resolved.boxPadding = Math.max(Number(resolved.boxPadding || 0), 12);
      resolved.outlineWidth = Math.max(Number(resolved.outlineWidth || 0), 2);
      resolved.outlineColor = '#FFFFFF';
      if (isTransparentBackground(resolved.backgroundColor)) {
        resolved.backgroundColor = 'rgba(20,20,20,0.45)';
      }
      break;
    case 'warm-glow-approx':
    case 'cool-glow-approx':
      resolved.borderStyle = 1;
      resolved.bold = true;
      resolved.outlineWidth = Math.max(Number(resolved.outlineWidth || 0), 2.5);
      resolved.shadowSize = Math.max(Number(resolved.shadowSize || 0), 1);
      resolved.backgroundColor = 'rgba(0,0,0,0)';
      break;
    case 'plain':
      resolved.borderStyle = 1;
      resolved.outlineWidth = Number(resolved.outlineWidth || 0);
      resolved.shadowSize = Number(resolved.shadowSize || 0);
      resolved.backgroundColor = 'rgba(0,0,0,0)';
      break;
    default:
      break;
  }

  if (renderContext.playResY >= 1600 && ['outline-heavy', 'shadow-strong', 'colored-outline'].includes(strategy)) {
    resolved.outlineWidth = Number(resolved.outlineWidth || 0) + 0.5;
  }

  return resolved;
}

function buildLineEventText(baseEvent, captionStyle, prefixTag = '') {
  return `${prefixTag}${escapeAssText(baseEvent.text || '')}`;
}

function buildActiveWordOnlyText(baseEvent, captionStyle, prefixTag = '') {
  const lineAnimationTag = buildAnimationTag(captionStyle.animation);
  const activeWordTag = `${buildHighlightedWordTag(captionStyle)}${buildWordAnimationTag(captionStyle.animation)}`;

  if (!Array.isArray(baseEvent.words) || baseEvent.words.length === 0 || baseEvent.activeIndex < 0) {
    return '';
  }

  const text = baseEvent.words.map((word, index) => {
    const escapedText = escapeAssText(word.text || '');
    if (index === baseEvent.activeIndex) {
      return `${prefixTag}${activeWordTag}${escapedText}{\\rDefault}`;
    }

    return `{\\1a&HFF&\\2a&HFF&\\3a&HFF&\\4a&HFF&}${escapedText}{\\1a&H00&\\2a&H00&\\3a&H00&\\4a&H00&}`;
  }).join(' ');

  return `${lineAnimationTag}${text}`;
}

function buildPositionedActiveWordText(baseEvent, captionStyle, renderContext, prefixTag = '') {
  if (!Array.isArray(baseEvent.words) || baseEvent.words.length === 0 || baseEvent.activeIndex < 0) {
    return '';
  }

  const activeWord = baseEvent.words[baseEvent.activeIndex];
  const escapedText = escapeAssText(activeWord.text || '');
  const lineAnimationTag = buildAnimationTag(captionStyle.animation);
  const activeWordTag = `${buildHighlightedWordTag(captionStyle)}${buildWordAnimationTag(captionStyle.animation)}`;
  const fontScale = Math.max(1, renderContext.playResY / 1280);
  const fontSize = Math.max(24, Math.round(Number(captionStyle.fontSize || 24) * fontScale));
  const avgCharWidth = fontSize * 0.62;
  const words = baseEvent.words.map(word => String(word.text || ''));
  const fullText = words.join(' ');
  const charsBefore = words.slice(0, baseEvent.activeIndex).join(' ').length + (baseEvent.activeIndex > 0 ? 1 : 0);
  const totalWidth = Math.max(1, fullText.length * avgCharWidth);
  const activeWidth = Math.max(avgCharWidth, escapedText.length * avgCharWidth);
  const centerX = renderContext.playResX / 2;
  const leftX = centerX - totalWidth / 2;
  const activeX = Math.round(leftX + charsBefore * avgCharWidth + activeWidth / 2);

  let activeY;
  if (captionStyle.position === 'top') activeY = Math.round(renderContext.playResY * 0.12);
  else if (captionStyle.position === 'middle') activeY = Math.round(renderContext.playResY * 0.5);
  else activeY = Math.round(renderContext.playResY * 0.88);

  return `${lineAnimationTag}{\\an5\\pos(${activeX},${activeY})}${prefixTag}${activeWordTag}${escapedText}{\\rDefault}`;
}

function buildVariantDialogueEntries(baseEvent, captionStyle, renderContext) {
  const variant = captionStyle.variant;
  const primary = hexToAssBgr(captionStyle.fontColor);
  const accent = hexToAssBgr(captionStyle.highlightColor || captionStyle.fontColor);
  const outline = hexToAssBgr(captionStyle.outlineColor || '#000000');
  const darkOutline = hexToAssBgr('#000000');
  const isBase = baseEvent.renderMode !== 'active';

  if (!isBase) {
    switch (variant) {
      case 'box':
      case 'bubble':
      case 'subtitles':
      case 'frosted':
      case 'neon-box':
      case 'outline':
      case 'bold-outline':
      case 'shadow-pop':
      case 'underline':
        return [];
      case 'fire':
        return [
          { layer: 15, text: buildPositionedActiveWordText(baseEvent, { ...captionStyle, highlightColor: '#FFD36B' }, renderContext, '{\\1c&H006BFF&\\3c&H0030FF&\\bord6\\blur5\\shad0\\1a&H15\\3a&H20}') },
          { layer: 16, text: buildPositionedActiveWordText(baseEvent, { ...captionStyle, highlightColor: '#FFF199' }, renderContext, '{\\1c&H00E6FF&\\3c&H000000&\\bord2.5\\blur0\\shad0}') }
        ].filter(entry => entry.text);
      case 'ice':
        return [
          { layer: 15, text: buildPositionedActiveWordText(baseEvent, { ...captionStyle, highlightColor: '#BFEFFF' }, renderContext, '{\\1c&H00FFC8&\\3c&H00FFB7&\\bord6\\blur5\\shad0\\1a&H15\\3a&H20}') },
          { layer: 16, text: buildPositionedActiveWordText(baseEvent, { ...captionStyle, highlightColor: '#EFFFFF' }, renderContext, '{\\1c&HFFFFE0&\\3c&H7A3A00&\\bord2.5\\blur0\\shad0}') }
        ].filter(entry => entry.text);
      case 'neon':
      case 'glitch':
      case 'extrude':
      case 'comic':
      case 'retro':
      case 'split-color':
      case 'neon-box':
      case 'gradient':
      case 'colored-stroke':
      case 'none':
      default:
        return [{ layer: 12, text: buildPositionedActiveWordText(baseEvent, captionStyle, renderContext) }].filter(entry => entry.text);
    }
  }

  switch (variant) {
    case 'neon':
      return [
        { layer: 0, text: buildLineEventText(baseEvent, captionStyle, `{\\1c${primary}\\3c${primary}\\bord8\\blur10\\shad0\\1a&H55\\3a&H55}`) },
        { layer: 1, text: buildLineEventText(baseEvent, captionStyle, `{\\1c${accent}\\3c${accent}\\bord4\\blur4\\shad0\\1a&H25\\3a&H25}`) },
        { layer: 2, text: buildLineEventText(baseEvent, captionStyle) }
      ];
    case 'glitch':
      return [
        { layer: 0, text: buildLineEventText(baseEvent, captionStyle, `{\\1c&HFFFF00&\\3c&HFFFF00&\\bord3\\blur1\\xshad-3\\yshad0\\1a&H40\\3a&H40}`) },
        { layer: 1, text: buildLineEventText(baseEvent, captionStyle, `{\\1c&HFF00FF&\\3c&HFF00FF&\\bord3\\blur1\\xshad3\\yshad0\\1a&H40\\3a&H40}`) },
        { layer: 2, text: buildLineEventText(baseEvent, captionStyle) }
      ];
    case 'extrude':
      return [
        { layer: 0, text: buildLineEventText(baseEvent, captionStyle, `{\\1c${darkOutline}\\3c${darkOutline}\\bord2\\blur0\\xshad6\\yshad6\\1a&H70}`) },
        { layer: 1, text: buildLineEventText(baseEvent, captionStyle, `{\\1c${darkOutline}\\3c${darkOutline}\\bord2\\blur0\\xshad3\\yshad3\\1a&H45}`) },
        { layer: 2, text: buildLineEventText(baseEvent, { ...captionStyle, bold: true }, `{\\3c${outline}\\bord4\\shad0}`) }
      ];
    case 'comic': {
      const comicStroke = !isTransparentBackground(captionStyle.backgroundColor)
        ? hexToAssBgr(captionStyle.backgroundColor)
        : hexToAssBgr('#FFE600');
      return [
        { layer: 0, text: buildLineEventText(baseEvent, captionStyle, `{\\1c${comicStroke}\\3c${comicStroke}\\bord8\\blur0\\shad0}`) },
        { layer: 1, text: buildLineEventText(baseEvent, captionStyle, `{\\1c${darkOutline}\\3c${darkOutline}\\bord3\\blur0\\shad0}`) },
        { layer: 2, text: buildLineEventText(baseEvent, { ...captionStyle, bold: true }) }
      ];
    }
    case 'retro': {
      const retroStroke = !isTransparentBackground(captionStyle.backgroundColor)
        ? hexToAssBgr(captionStyle.backgroundColor)
        : hexToAssBgr('#F4C26B');
      return [
        { layer: 0, text: buildLineEventText(baseEvent, captionStyle, `{\\1c${retroStroke}\\3c${retroStroke}\\bord9\\blur0\\shad0}`) },
        { layer: 1, text: buildLineEventText(baseEvent, captionStyle, `{\\1c${darkOutline}\\3c${darkOutline}\\bord4\\blur0\\shad1}`) },
        { layer: 2, text: buildLineEventText(baseEvent, { ...captionStyle, bold: true, spacing: Number(captionStyle.spacing || 0) + 0.5 }) }
      ];
    }
    case 'split-color': {
      const lowerColor = !isTransparentBackground(captionStyle.backgroundColor)
        ? hexToAssBgr(captionStyle.backgroundColor)
        : accent;
      const splitY = Math.round(
        captionStyle.position === 'top'
          ? renderContext.playResY * 0.18
          : captionStyle.position === 'middle'
            ? renderContext.playResY * 0.5
            : renderContext.playResY * 0.82
      );
      return [
        { layer: 0, text: buildLineEventText(baseEvent, captionStyle, `{\\clip(0,0,${renderContext.playResX},${splitY})\\1c${primary}\\3c${outline}\\bord3\\shad0}`) },
        { layer: 1, text: buildLineEventText(baseEvent, captionStyle, `{\\clip(0,${splitY},${renderContext.playResX},${renderContext.playResY})\\1c${lowerColor}\\3c${outline}\\bord3\\shad0}`) }
      ];
    }
    case 'neon-box': {
      const neonBack = !isTransparentBackground(captionStyle.backgroundColor)
        ? rgbaToAssBackColor(captionStyle.backgroundColor)
        : rgbaToAssBackColor('rgba(0,0,0,0.75)');
      const neonBoxStyle = {
        ...captionStyle,
        borderStyle: 3,
        outlineWidth: Math.max(Number(captionStyle.boxPadding || 6), 10),
        backgroundColor: captionStyle.backgroundColor,
        boxPadding: Math.max(Number(captionStyle.boxPadding || 0), 10)
      };
      return [
        { layer: 0, text: `{\\bord10\\blur8\\shad0\\3c${accent}\\4c${neonBack}\\3a&H35}${buildLineEventText(baseEvent, neonBoxStyle)}` },
        { layer: 1, text: buildLineEventText(baseEvent, neonBoxStyle, `{\\1c${accent}\\3c${accent}\\bord5\\blur5\\shad0\\1a&H30\\3a&H30}`) },
        { layer: 2, text: buildLineEventText(baseEvent, neonBoxStyle) }
      ];
    }
    case 'gradient': {
      const topColor = primary;
      const midColor = accent;
      const bottomColor = !isTransparentBackground(captionStyle.backgroundColor)
        ? hexToAssBgr(captionStyle.backgroundColor)
        : hexToAssBgr('#FF4F9A');
      const upperY = Math.round(
        captionStyle.position === 'top'
          ? renderContext.playResY * 0.12
          : captionStyle.position === 'middle'
            ? renderContext.playResY * 0.42
            : renderContext.playResY * 0.72
      );
      const lowerY = upperY + Math.round(renderContext.playResY * 0.08);
      return [
        { layer: 0, text: buildLineEventText(baseEvent, captionStyle, `{\\clip(0,0,${renderContext.playResX},${upperY})\\1c${topColor}\\3c${outline}\\bord3\\shad0}`) },
        { layer: 1, text: buildLineEventText(baseEvent, captionStyle, `{\\clip(0,${upperY},${renderContext.playResX},${lowerY})\\1c${midColor}\\3c${outline}\\bord3\\shad0}`) },
        { layer: 2, text: buildLineEventText(baseEvent, captionStyle, `{\\clip(0,${lowerY},${renderContext.playResX},${renderContext.playResY})\\1c${bottomColor}\\3c${outline}\\bord3\\shad0}`) }
      ];
    }
    case 'frosted': {
      const frostedBack = rgbaToAssBackColor(captionStyle.backgroundColor || 'rgba(20,20,20,0.45)');
      return [
        { layer: 0, text: `{\\bord12\\blur6\\shad0\\4c${frostedBack}\\3c&H00FFFFFF&\\3a&H55}${buildLineEventText(baseEvent, captionStyle)}` },
        { layer: 1, text: buildLineEventText(baseEvent, captionStyle, '{\\1c&H00FFFFFF&\\3c&H00FFFFFF&\\bord2\\blur1\\shad0\\1a&H25\\3a&H45}') },
        { layer: 2, text: buildLineEventText(baseEvent, captionStyle) }
      ];
    }
    case 'fire':
      return [
        { layer: 0, text: buildLineEventText(baseEvent, captionStyle, '{\\1c&H0010AA&\\3c&H0010AA&\\bord10\\blur10\\shad0\\1a&H70\\3a&H70}') },
        { layer: 1, text: buildLineEventText(baseEvent, captionStyle, '{\\1c&H0030FF&\\3c&H0030FF&\\bord7\\blur6\\shad0\\1a&H35\\3a&H35}') },
        { layer: 2, text: buildLineEventText(baseEvent, captionStyle, '{\\1c&H006BFF&\\3c&H006BFF&\\bord4\\blur2\\shad0\\1a&H10\\3a&H18}') },
        { layer: 3, text: buildLineEventText(baseEvent, { ...captionStyle, fontColor: '#FFD36B', highlightColor: '#FFF199', outlineColor: '#000000', backgroundColor: 'rgba(0,0,0,0)' }, '{\\1c&H006BFF&\\2c&H009AFF&\\3c&H000000&\\bord2.5\\shad0}') }
      ];
    case 'ice':
      return [
        { layer: 0, text: buildLineEventText(baseEvent, captionStyle, '{\\1c&H00A060&\\3c&H00A060&\\bord10\\blur10\\shad0\\1a&H70\\3a&H70}') },
        { layer: 1, text: buildLineEventText(baseEvent, captionStyle, '{\\1c&H00FFB7&\\3c&H00FFB7&\\bord7\\blur6\\shad0\\1a&H35\\3a&H35}') },
        { layer: 2, text: buildLineEventText(baseEvent, captionStyle, '{\\1c&H00FFC8&\\3c&H00FFC8&\\bord4\\blur2\\shad0\\1a&H10\\3a&H18}') },
        { layer: 3, text: buildLineEventText(baseEvent, { ...captionStyle, fontColor: '#E0FFFF', highlightColor: '#BFEFFF', outlineColor: '#003A7A', backgroundColor: 'rgba(0,0,0,0)' }, '{\\1c&HFFFFE0&\\2c&HFFEFBF&\\3c&H7A3A00&\\bord2.5\\shad0}') }
      ];
    default:
      return [{ layer: 0, text: buildLineEventText(baseEvent, captionStyle) }];
  }
}

function resolveCaptionStyle(style = {}) {
  const defaultStyle = {
    fontFamily: 'Arial',
    fontSize: 24,
    fontColor: '#FFFFFF',
    highlightColor: undefined,
    backgroundColor: 'rgba(0,0,0,0)',
    outlineColor: '#000000',
    outlineWidth: 2,
    shadowSize: 0,
    boxPadding: 6,
    bold: false,
    italic: false,
    spacing: 0,
    borderStyle: 1,
    underline: false,
    position: 'bottom',
    wordEffect: 'karaoke-fill',
    animation: undefined
  };

  const resolved = { ...defaultStyle, ...style };

  if (!resolved.highlightColor) {
    resolved.highlightColor = resolved.fontColor;
  }

  resolved.variant = normalizeVariantName(resolved.variant) || 'none';
  resolved.variantConfig = getCaptionVariantConfig(resolved.variant);

  delete resolved.stylePreset;

  return resolved;
}

function probeVideoDimensions(videoPath) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(videoPath, (err, metadata) => {
      if (err) {
        reject(err);
        return;
      }

      const videoStream = (metadata.streams || []).find(stream => stream.codec_type === 'video');
      const width = Number(videoStream?.width);
      const height = Number(videoStream?.height);

      if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
        reject(new Error('Unable to determine video dimensions from ffprobe.'));
        return;
      }

      resolve({ width, height });
    });
  });
}

function shouldBreakSegment(currentWords, nextWord, segmentStartMs) {
  if (!nextWord) return true;

  const currentText = currentWords.map(word => word.text).join(' ');
  const lastWord = currentWords[currentWords.length - 1];
  const segmentDurationMs = Math.max(0, lastWord.endMs - segmentStartMs);
  const pauseAfterMs = Math.max(0, nextWord.startMs - lastWord.endMs);
  const endsWithPunctuation = /[.!?,:;]$/.test(lastWord.text);

  if (currentWords.length >= 4) return true;
  if (currentText.length >= 24) return true;
  if (segmentDurationMs >= 1800) return true;
  if (pauseAfterMs >= 350) return true;
  if (endsWithPunctuation && currentWords.length >= 2) return true;

  return false;
}

function buildSmartSegments(words) {
  const normalizedWords = words
    .map(word => ({
      text: String(word.word || word.text || '').trim().toUpperCase(),
      startMs: Math.round(Number(word.startMs ?? (word.start * 1000))),
      endMs: Math.round(Number(word.endMs ?? (word.end * 1000)))
    }))
    .filter(word => word.text && Number.isFinite(word.startMs) && Number.isFinite(word.endMs));

  const segments = [];
  let currentWords = [];

  for (let i = 0; i < normalizedWords.length; i += 1) {
    const currentWord = normalizedWords[i];
    const nextWord = normalizedWords[i + 1];

    currentWords.push(currentWord);

    if (!shouldBreakSegment(currentWords, nextWord, currentWords[0].startMs)) {
      continue;
    }

    segments.push({
      startMs: currentWords[0].startMs,
      endMs: currentWords[currentWords.length - 1].endMs,
      text: currentWords.map(word => word.text).join(' '),
      words: currentWords
    });

    currentWords = [];
  }

  return segments;
}

// --- Auth Middleware ---
const authenticate = (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || authHeader !== `Bearer ${API_KEY}`) {
    console.warn('Unauthorized request attempt detected.');
    return res.status(401).json({ error: 'Unauthorized: Invalid API Key' });
  }
  next();
};

// --- Routes ---

// Health check endpoint for Railway
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', uptime: process.uptime() });
});

// Main rendering endpoint
app.post('/render', authenticate, async (req, res) => {
  let { postId, cleanVideoUrl, captionStyle, segments } = req.body;

  if (!cleanVideoUrl || !captionStyle) {
    return res.status(400).json({ error: 'Missing cleanVideoUrl or captionStyle' });
  }

  captionStyle = resolveCaptionStyle(captionStyle);

  // --- Auto-Transcribe if segments are missing ---
  if (!segments || segments.length === 0) {
    console.log(`[Job ${postId}] Segments missing. Requesting transcription from Supabase...`);
    try {
      const supabaseUrl = process.env.SUPABASE_URL;
      const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
      console.log(`[DEBUG] Supabase URL: ${supabaseUrl}`);
      console.log(`[DEBUG] Service Key starts with: ${serviceKey.substring(0, 10)}... ends with: ...${serviceKey.slice(-10)}`);
      console.log(`[DEBUG] Key length: ${serviceKey.length}`);
      console.log(`[DEBUG] URL: ${supabaseUrl}/functions/v1/whisper-transcribe`);
      const whisperRes = await axios.post(`${supabaseUrl}/functions/v1/whisper-transcribe`,
        { videoUrl: cleanVideoUrl },
        {
          headers: {
            'Authorization': `Bearer ${serviceKey}`,
            'apikey': serviceKey,
            'Content-Type': 'application/json'
          },
          timeout: 120000
        }
      );

      console.log(`[DEBUG] URL: ${supabaseUrl}/functions/v1/whisper-transcribe`);

      console.log("[DEBUG] Whisper Data", whisperRes.data)

      console.log("[DEBUG] Whisper Data-JSON", JSON.stringify(whisperRes.data))


      const { words } = whisperRes.data;

      console.log("[DEBUG] words", words)

      console.log("[DEBUG] words Data-JSON", JSON.stringify(words))


      if (!words || words.length === 0) {
        throw new Error('Whisper returned no words.');
      }

      console.log(`[Job ${postId}] Transcribed ${words.length} words. Formatting smart segments...`);
      segments = buildSmartSegments(words);

      console.log("[DEBUG] Segments", segments)

    } catch (transcribeError) {
      console.error(`[Job ${postId}] Transcription failed:`, transcribeError.message);
      return res.status(500).json({ error: `Transcription failed: ${transcribeError.message}` });
    }
  }

  // Create a unique temporary working directory
  const workDir = path.join(__dirname, 'temp', `job-${Date.now()}-${Math.floor(Math.random() * 1000)}`);
  fs.mkdirSync(workDir, { recursive: true });

  const inputPath = path.join(workDir, 'input.mp4');
  const assPath = path.join(workDir, 'captions.ass');
  const outputPath = path.join(workDir, 'output.mp4');

  try {
    console.log(`[Job ${postId}] Starting render workflow...`);

    // 1. Download video
    console.log(`[Job ${postId}] Downloading source video...`);
    const videoRes = await axios({
      method: 'get',
      url: cleanVideoUrl,
      responseType: 'stream'
    });

    const writer = fs.createWriteStream(inputPath);
    videoRes.data.pipe(writer);
    await new Promise((resolve, reject) => {
      writer.on('finish', resolve);
      writer.on('error', reject);
    });

    let playResX = 720;
    let playResY = 1280;

    try {
      const dimensions = await probeVideoDimensions(inputPath);
      playResX = dimensions.width;
      playResY = dimensions.height;
      console.log(`[Job ${postId}] Using detected subtitle canvas ${playResX}x${playResY}.`);
    } catch (probeError) {
      console.warn(`[Job ${postId}] Failed to detect video dimensions, using fallback canvas 720x1280:`, probeError.message);
    }

    // 2. Generate ASS Subtitle file
    console.log(`[Job ${postId}] Generating styling payload...`);
    const variantStyle = applyReadabilityBaseline(
      resolveBasicVariantStyle(captionStyle, { playResX, playResY }),
      { playResX, playResY }
    );
    const primaryColour = hexToAssBgr(variantStyle.fontColor);
    const secondaryColour = hexToAssBgr(variantStyle.highlightColor || variantStyle.fontColor);
    const outlineColour = hexToAssBgr(variantStyle.outlineColor);
    const backColour = rgbaToAssBackColor(variantStyle.backgroundColor);
    const alignment = variantStyle.position === 'top' ? 8 : variantStyle.position === 'middle' ? 5 : 2;
    const topMarginV = Math.max(40, Math.round(playResY * Number(variantStyle.topSafeRatio || 0.065)));
    const bottomMarginV = Math.max(84, Math.round(playResY * Number(variantStyle.bottomSafeRatio || 0.1)));
    const marginV = variantStyle.position === 'bottom' ? bottomMarginV : variantStyle.position === 'top' ? topMarginV : 0;
    const bold = variantStyle.bold ? -1 : 0;
    const italic = variantStyle.italic ? -1 : 0;
    const underline = variantStyle.underline ? -1 : 0;
    const fontScale = Math.max(1, playResY / 1280);
    const fontSize = Math.max(24, Math.round(Number(variantStyle.fontSize || 24) * fontScale));
    const borderStyle = Number.isFinite(Number(variantStyle.borderStyle)) ? Number(variantStyle.borderStyle) : 3;
    const outlineWidth = Number.isFinite(Number(variantStyle.outlineWidth)) ? Number(variantStyle.outlineWidth) : 2;
    const boxPadding = Number.isFinite(Number(variantStyle.boxPadding)) ? Number(variantStyle.boxPadding) : 6;
    const effectiveOutlineWidth = borderStyle === 3 ? Math.max(outlineWidth, boxPadding) : outlineWidth;
    const shadowSize = Number.isFinite(Number(variantStyle.shadowSize)) ? Number(variantStyle.shadowSize) : 0;
    const spacing = Number.isFinite(Number(variantStyle.spacing)) ? Number(variantStyle.spacing) : 0;
    const marginRatio = Number.isFinite(Number(variantStyle.marginHorizontalRatio)) ? Number(variantStyle.marginHorizontalRatio) : 0.045;
    const marginH = Math.max(10, Math.round(playResX * marginRatio));
    const header = `[Script Info]\nScriptType: v4.00+\nPlayResX: ${playResX}\nPlayResY: ${playResY}\nScaledBorderAndShadow: yes\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: Default,${variantStyle.fontFamily},${fontSize},${primaryColour},${secondaryColour},${outlineColour},${backColour},${bold},${italic},${underline},0,100,100,${spacing},0,${borderStyle},${effectiveOutlineWidth},${shadowSize},${alignment},${marginH},${marginH},${marginV},1\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n`;

    const events = segments
      .flatMap(seg => {
        const segmentEvents = [buildSegmentBaseEvent(seg), ...buildSegmentDialogueEvents(seg, variantStyle)];

        return segmentEvents.flatMap(event => {
          const variantEntries = buildVariantDialogueEntries(event, variantStyle, { playResX, playResY });

          return variantEntries.map(entry => {
            const start = msToAssTime(event.startMs);
            const end = msToAssTime(event.endMs);
            return `Dialogue: ${entry.layer},${start},${end},Default,,0,0,0,,${entry.text}`;
          });
        });
      })
      .join('\n');

    fs.writeFileSync(assPath, header + events);

    // 3. Run FFmpeg Engine
    console.log(`[Job ${postId}] Executing FFmpeg processing...`);

    // Cross-platform path escaping for the 'ass' filter:
    let escapedAssPath;
    if (process.platform === 'win32') {
      // Windows needs the drive colon escaped and forward slashes
      escapedAssPath = assPath.replace(/\\/g, '/').replace(':', '\\:');
    } else {
      // Linux/Railway needs a clean path
      escapedAssPath = assPath;
    }

    await new Promise((resolve, reject) => {
      ffmpeg(inputPath)
        .videoFilters(`ass='${escapedAssPath}'`)
        .outputOptions([
          '-c:v libx264',
          '-preset veryfast', // 'veryfast' is safer for memory than 'ultrafast'
          '-crf 23',
          '-threads 1', // IMPORTANT: Limits RAM usage significantly
          '-pix_fmt yuv420p',
          '-c:a copy',
          '-movflags faststart'
        ])
        .output(outputPath)
        .on('end', () => resolve())
        .on('error', (err) => reject(err))
        .run();
    });

    console.log(`[Job ${postId}] Video rendered successfully.`);

    // 4. Upload to Supabase Storage
    console.log(`[Job ${postId}] Uploading artifact to Supabase...`);
    const fileBuffer = fs.readFileSync(outputPath);
    const objectPath = `captions/serverless/${postId || 'adhoc'}-${Date.now()}.mp4`;

    const { error: uploadError } = await supabase.storage
      .from('social-media-content')
      .upload(objectPath, fileBuffer, {
        contentType: 'video/mp4',
        upsert: true
      });

    if (uploadError) throw new Error(`Supabase Storage Error: ${uploadError.message}`);

    // Generate Public URL
    const { data: publicUrlData } = supabase.storage
      .from('social-media-content')
      .getPublicUrl(objectPath);

    const processedUrl = publicUrlData.publicUrl;

    // 5. Update Database Record
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(postId);
    if (isUuid) {
      const { data: currentPost, error: fetchError } = await supabase
        .from('scheduled_posts')
        .select('avatar_video_task_id, media_urls, preview_media_urls, caption_burn_task_status')
        .eq('id', postId)
        .single();

      if (fetchError || !currentPost) {
        console.error(`[Job ${postId}] Failed to fetch post for sync:`, fetchError);
      } else {
        const existingUrls = currentPost.media_urls || [];
        const existingPreviewUrls = currentPost.preview_media_urls || [];

        console.log(`[Job ${postId}] Current media_urls:`, existingUrls);

        // Filter out ANY .mp4 or .mov file that isn't our new processed URL.
        // This ensures we remove the raw HeyGen video (from both CDN and Supabase storage).
        const nonVideoUrls = existingUrls.filter(u => {
          const isVideo = /\.(mp4|mov|avi|webm|m4v)/i.test(String(u));
          return !isVideo || u === processedUrl;
        });
        const nonPreviewVideoUrls = existingPreviewUrls.filter(u => {
          const isVideo = /\.(mp4|mov|avi|webm|m4v)/i.test(String(u));
          return !isVideo || u === processedUrl;
        });

        const finalMediaUrls = [...new Set([...nonVideoUrls, processedUrl])];
        console.log(`[Job ${postId}] Final media_urls:`, finalMediaUrls);

        const { error: dbError } = await supabase
          .from('scheduled_posts')
          .update({
            caption_burn_output_url: processedUrl,
            caption_burn_task_status: 'completed',
            media_urls: finalMediaUrls,
            preview_media_urls: [...new Set([...nonPreviewVideoUrls, processedUrl])],
            caption_burn_completed_at: new Date().toISOString(),
            caption_burn_task_log: `Caption burn successful. Output URL: ${processedUrl}`,
          })
          .eq('id', postId);

        if (dbError) console.error(`[Job ${postId}] Failed to update scheduled_posts:`, dbError);

        // Also update media_library so the user sees the captioned version in their library
        if (currentPost.avatar_video_task_id) {
          console.log(`[Job ${postId}] Updating media_library entry for task ${currentPost.avatar_video_task_id}`);
          const { error: mlErr } = await supabase
            .from('media_library')
            .update({
              public_url: processedUrl,
              // updated_at: new Date().toISOString(),
            })
            .eq('ai_task_id', currentPost.avatar_video_task_id);

          if (mlErr) console.error(`[Job ${postId}] Warning: Failed to update media_library:`, mlErr);
          else console.log(`[Job ${postId}] media_library updated successfully.`);
        }
      }
    } else {
      console.log(`[Job ${postId}] Skipping DB update (ID is not a valid UUID).`);
    }

    // Success response
    console.log(`[Job ${postId}] Workflow completed entirely.`);
    res.json({ success: true, processedUrl });

  } catch (error) {
    console.error(`[Job ${postId}] Critical Error:`, error.message);
    res.status(500).json({ error: error.message });
  } finally {
    // CRITICAL: Always clean up temporary files to prevent server crash from full disk
    console.log(`[Job ${postId}] Cleaning up temporary resources...`);
    try {
      if (fs.existsSync(workDir)) {
        fs.rmSync(workDir, { recursive: true, force: true });
      }
    } catch (cleanupErr) {
      console.error(`[Job ${postId}] Failed to clean up directory ${workDir}:`, cleanupErr);
    }
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Production Caption Server running on port ${PORT}`);
});
