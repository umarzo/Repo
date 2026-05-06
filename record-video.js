const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 854, height: 480 },   // lighter than 720p
    recordVideo: {
      dir: '.',
      size: { width: 854, height: 480 },
    },
  });

  const page = await context.newPage();

  try {
    await page.goto('http://localhost:8080/golex_ad_v7.html', {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    });

    await page.waitForSelector('#ad', { state: 'visible', timeout: 15000 });

    // Turn off the most expensive background effects
    await page.evaluate(() => {
      // Hide the particle canvas
      const canvas = document.getElementById('particles-canvas');
      if (canvas) canvas.style.display = 'none';
      // Hide the grain overlay
      const grain = document.getElementById('grain-overlay');
      if (grain) grain.style.display = 'none';
    });

    // Wait a tiny moment for the browser to settle
    await page.waitForTimeout(500);

    // Record the full loop (80 seconds – safe margin)
    console.log('Recording for 80 seconds…');
    await page.waitForTimeout(80000);

  } catch (error) {
    console.error('Error occurred:', error.message);
    await page.screenshot({ path: 'error.png' });
  }

  const video = page.video();
  await context.close();

  if (video) {
    await video.saveAs('video.webm');
    console.log('Video saved as video.webm');
  } else {
    console.error('No video object found');
  }

  await browser.close();
})();
