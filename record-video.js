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

    // Wait for the first scene to be visible (this is reliable in the new HTML)
    await page.waitForSelector('#s-loading', { state: 'visible', timeout: 15000 });

    // Optional debug screenshot
    await page.screenshot({ path: 'page-loaded.png' });

    // Record the full cinematic walkthrough (currently ~130 sec, we give 160)
    const totalDurationMs = 160000;
    console.log(`Recording for ${totalDurationMs / 1000} seconds…`);
    await page.waitForTimeout(totalDurationMs);

  } catch (error) {
    console.error('Error occurred:', error.message);
    await page.screenshot({ path: 'error.png' });
  }

  // ✅ Get the video object before closing anything
  const video = page.video();

  // Close the context (this finalises the video file)
  await context.close();

  // Save the video to a predictable name (browser is still running here)
  if (video) {
    await video.saveAs('video.webm');
    console.log('Video saved as video.webm');
  } else {
    console.error('No video object found');
  }

  // Now close the browser
  await browser.close();
})();
