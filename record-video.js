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
    await page.goto('http://localhost:8080/scenes.html', {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    });

    // Wait for the first scene to be visible – any element with class "scene"
    await page.waitForSelector('.scene', { state: 'visible', timeout: 10000 });

    // The full loop (8 scenes) is about 18 seconds.
    // We’ll record two full loops for a nice, complete ad → 40 seconds total.
    const recordDuration = 40000;   // 40 seconds
    console.log(`Recording for ${recordDuration / 1000} seconds…`);
    await page.waitForTimeout(recordDuration);

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
