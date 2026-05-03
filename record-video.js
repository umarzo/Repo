const { chromium } = require('playwright');

(async () => {
  // Launch a persistent context with video recording
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },   // Desktop size
    recordVideo: {
      dir: '.',
      size: { width: 1280, height: 720 },
      // Playwright records in .webm by default
    },
  });

  const page = await context.newPage();

  // Navigate to the locally served HTML
  await page.goto('http://localhost:8080/adx1.html', {
    waitUntil: 'networkidle',
    timeout: 30000,
  });

  // Wait for the ad container to appear (ensures DOM is ready)
  await page.waitForSelector('#ad', { state: 'visible', timeout: 10000 });

  // The full ad loop is ~77 seconds; wait a bit longer to capture the finale
  const totalDurationMs = 80000;   // 80 seconds
  console.log(`Recording for ${totalDurationMs / 1000} seconds…`);
  await page.waitForTimeout(totalDurationMs);

  // Close context – Playwright saves the video
  await context.close();
  await browser.close();

  console.log('Video saved as video.webm');
})();
