const express = require('express');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegInstaller = require('@ffmpeg-installer/ffmpeg');
const ffprobeInstaller = require('@ffprobe-installer/ffprobe');
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
if (process.platform === 'win32') {
  ffmpeg.setFfmpegPath(ffmpegInstaller.path);
  ffmpeg.setFfprobePath(ffprobeInstaller.path);
}

// Setup Supabase
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
  const h = hex.replace('#', '');
  const r = h.slice(0, 2);
  const g = h.slice(2, 4);
  const b = h.slice(4, 6);
  return `&H00${b}${g}${r}`;
}

// Convert RGBA string to ASS BackColor format
function rgbaToAssBackColor(rgba) {
  const match = rgba.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/);
  if (!match) return '&H80000000';
  const r = parseInt(match[1]).toString(16).padStart(2, '0');
  const g = parseInt(match[2]).toString(16).padStart(2, '0');
  const b = parseInt(match[3]).toString(16).padStart(2, '0');
  const alpha = match[4] !== undefined ? Math.round((1 - parseFloat(match[4])) * 255) : 128;
  const a = alpha.toString(16).padStart(2, '0');
  return `&H${a}${b}${g}${r}`;
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
  const { postId, cleanVideoUrl, captionStyle, segments } = req.body;

  if (!cleanVideoUrl || !segments || !captionStyle) {
    return res.status(400).json({ error: 'Missing cleanVideoUrl, segments, or captionStyle' });
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

    // 2. Generate ASS Subtitle file
    console.log(`[Job ${postId}] Generating styling payload...`);
    const primaryColour = hexToAssBgr(captionStyle.fontColor);
    const backColour = rgbaToAssBackColor(captionStyle.backgroundColor);
    const alignment = captionStyle.position === 'top' ? 8 : captionStyle.position === 'middle' ? 5 : 2;
    const marginV = captionStyle.position === 'bottom' ? 30 : captionStyle.position === 'top' ? 30 : 0;

    const header = `[Script Info]\nScriptType: v4.00+\nPlayResX: 720\nPlayResY: 1280\nScaledBorderAndShadow: yes\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: Default,${captionStyle.fontFamily},${captionStyle.fontSize},${primaryColour},&H00FFFFFF,&H00000000,${backColour},0,0,0,0,100,100,0,0,3,2,0,${alignment},10,10,${marginV},1\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n`;

    const events = segments
      .map(seg => {
        const start = msToAssTime(seg.startMs);
        const end = msToAssTime(seg.endMs);
        const text = seg.text.replace(/\n/g, '\\N');
        return `Dialogue: 0,${start},${end},Default,,0,0,0,,${text}`;
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
    if (postId) {
      const { error: dbError } = await supabase
        .from('scheduled_posts')
        .update({
          caption_burn_output_url: processedUrl,
          caption_burn_task_status: 'completed'
        })
        .eq('id', postId);
        
      if (dbError) console.error(`[Job ${postId}] Warning: Failed to update DB status:`, dbError);
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

app.listen(PORT, () => {
  console.log(`🚀 Production Caption Server running on port ${PORT}`);
});
