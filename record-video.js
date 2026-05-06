const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },      // desktop size
    recordVideo: {
      dir: '.',
      size: { width: 1280, height: 720 },
    },
  });

  const page = await context.newPage();

  try {
    // Load the new ad file
    await page.goto('http://localhost:8080/golex_ad_v7.html', {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    });

    // Wait for the main ad container – it still has id="ad"
    await page.waitForSelector('#ad', { state: 'visible', timeout: 15000 });

    // Debug screenshot (optional, you can remove this line later)
    await page.screenshot({ path: 'page-loaded.png' });

    // The full scene loop is ≈68.4s, we wait 80s to be safe
    const recordDuration = 80000;   // 80 seconds
    console.log(`Recording for ${recordDuration / 1000} seconds…`);
    await page.waitForTimeout(recordDuration);

  } catch (error) {
    console.error('Error occurred:', error.message);
    await page.screenshot({ path: 'error.png' });
  }

  // Save the video before closing the browser
  const video = page.video();
  await context.close();   // finalises the video file

  if (video) {
    await video.saveAs('video.webm');
    console.log('Video saved as video.webm');
  } else {
    console.error('No video object found');
  }

  await browser.close();
})();
