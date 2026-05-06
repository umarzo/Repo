const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

// Config
const FRAME_RATE = 30;               // frames per second
const RECORD_DURATION_MS = 80000;    // 80 seconds (covers the full loop)
const TOTAL_FRAMES = Math.floor(RECORD_DURATION_MS * (FRAME_RATE / 1000));
const FRAME_INTERVAL_MS = 1000 / FRAME_RATE;

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Zero-pad frame numbers
function pad(n) {
  return String(n).padStart(5, '0');
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },   // keep native resolution
  });
  const page = await context.newPage();

  // Create frame directory
  const framesDir = path.join(__dirname, 'frames');
  if (fs.existsSync(framesDir)) {
    fs.rmSync(framesDir, { recursive: true, force: true });
  }
  fs.mkdirSync(framesDir);

  try {
    console.log('Loading ad...');
    await page.goto('http://localhost:8080/golex_ad_v7.html', {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    });
    await page.waitForSelector('#ad', { state: 'visible', timeout: 15000 });

    console.log(`Starting screenshot capture: ${FRAME_RATE} fps, ${TOTAL_FRAMES} frames`);

    // Optional: disable heavy effects for performance
    await page.evaluate(() => {
      const canvas = document.getElementById('particles-canvas');
      if (canvas) canvas.style.display = 'none';
      const grain = document.getElementById('grain-overlay');
      if (grain) grain.style.display = 'none';
    });

    let frameIndex = 0;
    const startTime = Date.now();

    for (let i = 0; i < TOTAL_FRAMES; i++) {
      const targetTime = startTime + i * FRAME_INTERVAL_MS;

      // Take screenshot
      await page.screenshot({
        path: path.join(framesDir, `frame-${pad(i)}.png`),
      });

      frameIndex++;

      // Wait just enough to stay on schedule
      const elapsed = Date.now() - startTime;
      const nextSleep = targetTime - Date.now();
      if (nextSleep > 0) {
        await sleep(nextSleep);
      } else {
        // We're behind schedule — continue immediately to catch up (no extra sleep)
        // This may cause missing frames in the video, but the recording won't drift.
        console.warn(`Frame ${i}: behind schedule by ${-nextSleep} ms`);
      }
    }

    console.log('Screenshots completed. Now encoding video with ffmpeg...');

  } catch (error) {
    console.error('Error during capture:', error.message);
    await page.screenshot({ path: 'error.png' });
  }

  await browser.close();

  // Encode video with ffmpeg
  const { execSync } = require('child_process');
  try {
    execSync(
      `ffmpeg -framerate ${FRAME_RATE} -i frames/frame-%05d.png -c:v libx264 -pix_fmt yuv420p -preset fast -crf 23 video.mp4`,
      { stdio: 'inherit' }
    );
    console.log('video.mp4 created successfully');
  } catch (e) {
    console.error('ffmpeg encoding failed:', e.message);
  }

  // Clean up frames
  fs.rmSync(framesDir, { recursive: true, force: true });
})();
