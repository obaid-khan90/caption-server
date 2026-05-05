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
      return '{\\fscx120\\fscy120\\t(0,120,\\fscx100\\fscy100)}';
    default:
      return '';
  }
}

function buildWordScopedText(words, activeIndex, captionStyle) {
  const activeWordTag = `${buildHighlightedWordTag(captionStyle)}${buildWordAnimationTag(captionStyle.animation)}`;

  return words.map((word, index) => {
    const escapedText = escapeAssText(word.text || '');
    if (index !== activeIndex) {
      return escapedText;
    }

    return `${activeWordTag}${escapedText}{\\rDefault}`;
  }).join(' ');
}

function buildSegmentDialogueEvents(seg, captionStyle) {
  const words = Array.isArray(seg.words) ? seg.words.filter(word => word.text) : [];
  const lineAnimationTag = buildAnimationTag(captionStyle.animation);

  if (words.length === 0) {
    return [
      {
        startMs: seg.startMs,
        endMs: seg.endMs,
        text: `${lineAnimationTag}${escapeAssText(seg.text || '')}`
      }
    ];
  }

  return words.map((word, index) => {
    const startMs = Number(word.startMs ?? seg.startMs ?? 0);
    const nextStartMs = Number(words[index + 1]?.startMs ?? word.endMs ?? seg.endMs ?? startMs + 10);
    const endMs = Math.max(startMs + 10, Number(word.endMs ?? nextStartMs ?? seg.endMs ?? startMs + 10));
    const scopedText = buildWordScopedText(words, index, captionStyle);

    return {
      startMs,
      endMs,
      text: `${lineAnimationTag}${scopedText}`
    };
  });
}

const CAPTION_STYLE_PRESETS = {
  Minimal: {
    fontFamily: 'Arial',
    fontSize: 24,
    fontColor: '#FFFFFF',
    highlightColor: '#FFFFFF',
    backgroundColor: 'rgba(0,0,0,0)',
    outlineColor: '#000000',
    outlineWidth: 1,
    shadowSize: 0,
    bold: false,
    italic: false,
    spacing: 0,
    borderStyle: 1
  },
  'Clean Black': {
    fontFamily: 'Arial',
    fontSize: 26,
    fontColor: '#FFFFFF',
    highlightColor: '#FFFFFF',
    backgroundColor: 'rgba(0,0,0,0.72)',
    outlineColor: '#000000',
    outlineWidth: 0,
    shadowSize: 0,
    bold: true,
    italic: false,
    spacing: 0,
    borderStyle: 3
  },
  'Outline White': {
    fontFamily: 'Arial',
    fontSize: 26,
    fontColor: '#FFFFFF',
    highlightColor: '#FFFFFF',
    backgroundColor: 'rgba(0,0,0,0)',
    outlineColor: '#000000',
    outlineWidth: 3,
    shadowSize: 0,
    bold: true,
    italic: false,
    spacing: 0,
    borderStyle: 1
  },
  'Outline Yellow': {
    fontFamily: 'Arial',
    fontSize: 26,
    fontColor: '#FFD400',
    highlightColor: '#FFF2A8',
    backgroundColor: 'rgba(0,0,0,0)',
    outlineColor: '#000000',
    outlineWidth: 3,
    shadowSize: 0,
    bold: true,
    italic: false,
    spacing: 0,
    borderStyle: 1
  },
  'Shadow White': {
    fontFamily: 'Arial',
    fontSize: 26,
    fontColor: '#FFFFFF',
    highlightColor: '#FFFFFF',
    backgroundColor: 'rgba(0,0,0,0)',
    outlineColor: '#000000',
    outlineWidth: 1,
    shadowSize: 2,
    bold: true,
    italic: false,
    spacing: 0,
    borderStyle: 1
  },
  'Shadow Yellow': {
    fontFamily: 'Arial',
    fontSize: 26,
    fontColor: '#FFD400',
    highlightColor: '#FFF2A8',
    backgroundColor: 'rgba(0,0,0,0)',
    outlineColor: '#000000',
    outlineWidth: 1,
    shadowSize: 2,
    bold: true,
    italic: false,
    spacing: 0,
    borderStyle: 1
  },
  'Bold White': {
    fontFamily: 'Arial Black',
    fontSize: 28,
    fontColor: '#FFFFFF',
    highlightColor: '#FFFFFF',
    backgroundColor: 'rgba(0,0,0,0)',
    outlineColor: '#000000',
    outlineWidth: 2,
    shadowSize: 0,
    bold: true,
    italic: false,
    spacing: 0.5,
    borderStyle: 1
  },
  'MrBeast Yellow': {
    fontFamily: 'Arial Black',
    fontSize: 30,
    fontColor: '#FFD400',
    highlightColor: '#FFF2A8',
    backgroundColor: 'rgba(0,0,0,0)',
    outlineColor: '#000000',
    outlineWidth: 4,
    shadowSize: 0,
    bold: true,
    italic: false,
    spacing: 0.5,
    borderStyle: 1
  },
  'Neon Cyan': {
    fontFamily: 'Arial Black',
    fontSize: 28,
    fontColor: '#7DF9FF',
    highlightColor: '#C9FDFF',
    backgroundColor: 'rgba(0,0,0,0)',
    outlineColor: '#00343A',
    outlineWidth: 2,
    shadowSize: 2,
    bold: true,
    italic: false,
    spacing: 0.5,
    borderStyle: 1
  },
  'Cinema Black': {
    fontFamily: 'Arial',
    fontSize: 24,
    fontColor: '#FFFFFF',
    highlightColor: '#FFFFFF',
    backgroundColor: 'rgba(0,0,0,0.82)',
    outlineColor: '#000000',
    outlineWidth: 0,
    shadowSize: 0,
    bold: false,
    italic: false,
    spacing: 0.3,
    borderStyle: 3
  }
};

function resolveCaptionStyle(style = {}) {
  const defaultStyle = {
    fontFamily: 'Arial',
    fontSize: 24,
    fontColor: '#FFFFFF',
    highlightColor: style.fontColor || '#FFFFFF',
    backgroundColor: 'rgba(0,0,0,0.5)',
    outlineColor: '#000000',
    outlineWidth: 2,
    shadowSize: 0,
    bold: false,
    italic: false,
    spacing: 0,
    borderStyle: 3,
    position: 'bottom',
    wordEffect: 'karaoke-fill',
    animation: undefined
  };

  const presetStyle = style.stylePreset ? CAPTION_STYLE_PRESETS[style.stylePreset] || {} : {};
  const resolved = { ...defaultStyle, ...presetStyle, ...style };

  if (!resolved.highlightColor) {
    resolved.highlightColor = resolved.fontColor;
  }

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

  if (currentWords.length >= 5) return true;
  if (currentText.length >= 28) return true;
  if (segmentDurationMs >= 2200) return true;
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
    const primaryColour = hexToAssBgr(captionStyle.fontColor);
    const secondaryColour = hexToAssBgr(captionStyle.highlightColor || captionStyle.fontColor);
    const outlineColour = hexToAssBgr(captionStyle.outlineColor);
    const backColour = rgbaToAssBackColor(captionStyle.backgroundColor);
    const alignment = captionStyle.position === 'top' ? 8 : captionStyle.position === 'middle' ? 5 : 2;
    const baseMarginV = Math.max(24, Math.round(playResY * 0.04));
    const marginV = captionStyle.position === 'bottom' ? baseMarginV : captionStyle.position === 'top' ? baseMarginV : 0;
    const bold = captionStyle.bold ? -1 : 0;
    const italic = captionStyle.italic ? -1 : 0;
    const outlineWidth = Number.isFinite(Number(captionStyle.outlineWidth)) ? Number(captionStyle.outlineWidth) : 2;
    const shadowSize = Number.isFinite(Number(captionStyle.shadowSize)) ? Number(captionStyle.shadowSize) : 0;
    const spacing = Number.isFinite(Number(captionStyle.spacing)) ? Number(captionStyle.spacing) : 0;
    const borderStyle = Number.isFinite(Number(captionStyle.borderStyle)) ? Number(captionStyle.borderStyle) : 3;
    const marginH = Math.max(10, Math.round(playResX * 0.015));
    const header = `[Script Info]\nScriptType: v4.00+\nPlayResX: ${playResX}\nPlayResY: ${playResY}\nScaledBorderAndShadow: yes\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: Default,${captionStyle.fontFamily},${captionStyle.fontSize},${primaryColour},${secondaryColour},${outlineColour},${backColour},${bold},${italic},0,0,100,100,${spacing},0,${borderStyle},${outlineWidth},${shadowSize},${alignment},${marginH},${marginH},${marginV},1\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n`;

    const events = segments
      .flatMap(seg => buildSegmentDialogueEvents(seg, captionStyle))
      .map(event => {
        const start = msToAssTime(event.startMs);
        const end = msToAssTime(event.endMs);
        return `Dialogue: 0,${start},${end},Default,,0,0,0,,${event.text}`;
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
