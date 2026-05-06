const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    recordVideo: {
      dir: '.',
      size: { width: 1280, height: 720 },
    },
  });

  const page = await context.newPage();

  try {
    // The new ad file must be named exactly golex_ad_premium-v5.html
    await page.goto('http://localhost:8080/golex_ad_premium-v5.html', {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    });

    // The ad container still has id="ad" – wait for it
    await page.waitForSelector('#ad', { state: 'visible', timeout: 15000 });

    // Debug screenshot (optional, can be removed)
    await page.screenshot({ path: 'page-loaded.png' });

    // Record the full cinematic loop (~77 s) plus a small buffer → 90 s safe
    const recordDuration = 90000;
    console.log(`Recording for ${recordDuration / 1000} seconds…`);
    await page.waitForTimeout(recordDuration);

  } catch (error) {
    console.error('Error occurred:', error.message);
    await page.screenshot({ path: 'error.png' });
  }

  // Save video before closing the browser
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
