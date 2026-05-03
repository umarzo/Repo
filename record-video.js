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
    await page.goto('http://localhost:8080/adx1.html', {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    });

    // Wait for the loading scene – this element is in the new HTML
    await page.waitForSelector('#s-loading', { state: 'visible', timeout: 15000 });

    // Optional: take a debug screenshot (download it if something goes wrong)
    await page.screenshot({ path: 'page-loaded.png' });

    // Record the full cinematic walkthrough (≈130 sec, we give 160)
    const totalDurationMs = 160000;
    console.log(`Recording for ${totalDurationMs / 1000} seconds…`);
    await page.waitForTimeout(totalDurationMs);

  } catch (error) {
    console.error('Error occurred:', error.message);
    await page.screenshot({ path: 'error.png' });
  }

  await context.close();
  await browser.close();

  // Save the video with a predictable name
  const video = page.video();
  if (video) {
    await video.saveAs('video.webm');
    console.log('Video saved as video.webm');
  } else {
    console.error('No video object found');
  }
})();
