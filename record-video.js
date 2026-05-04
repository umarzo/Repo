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

    // Wait for a known present element (the phone screen) to confirm the page is ready
    await page.waitForSelector('#screen-inner', { state: 'visible', timeout: 15000 });

    // Optional: take a debug screenshot
    await page.screenshot({ path: 'page-loaded.png' });

    // Give the animation a moment to initialise (the script auto‑starts after 0.5s)
    await page.waitForTimeout(1000);

    // Record the full animation loop (~80 seconds) – the product film is 68.8s + end card
    await page.waitForTimeout(80000);

  } catch (error) {
    console.error('Error occurred:', error.message);
    await page.screenshot({ path: 'error.png' });
  }

  // Close the context – this finalises the video
  await context.close();

  // Save the video with a predictable name
  const video = page.video();
  if (video) {
    await video.saveAs('video.webm');
    console.log('Video saved as video.webm');
  } else {
    console.error('No video object found – something went wrong');
  }

  await browser.close();
})();
