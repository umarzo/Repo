const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 854, height: 480 },      // lower resolution = smoother
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

    // Turn off heavy background elements
    await page.evaluate(() => {
      const canvas = document.getElementById('particles-canvas');
      if (canvas) canvas.style.display = 'none';
      const grain = document.getElementById('grain-overlay');
      if (grain) grain.style.display = 'none';
    });

    // Record the full walkthrough (80 s)
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
