const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },   // full HD ready
    recordVideo: {
      dir: '.',
      size: { width: 1280, height: 720 },
    },
  });

  const page = await context.newPage();

  try {
    await page.goto('http://localhost:8080/golex_ad_v7.html', {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    });

    await page.waitForSelector('#ad', { state: 'visible', timeout: 15000 });

    // ═══════════════════════════════════════════
    //  DISABLE ALL HEAVY DECORATIVE EFFECTS
    // ═══════════════════════════════════════════
    await page.evaluate(() => {
      const removeIds = [
        'particles-canvas', 'grain-overlay', 'bg-orbs', 'bg-pulse-rings',
        'momentum-flash', 'scene-wipe', 'live-ticker', 'pause-indicator',
        'kbd-hint', 'custom-cursor', 'custom-cursor-ring',
        'pgbar-timer', 'scene-name-pill', 'scene-index',
      ];
      removeIds.forEach(id => {
        const el = document.getElementById(id);
        if (el) el.style.display = 'none';
      });

      // Remove floating orbs
      document.querySelectorAll('.bg-orb').forEach(orb => {
        orb.style.animation = 'none';
        orb.style.display = 'none';
      });

      // Remove 3D phone wrappers
      document.querySelectorAll('.phone-3d-wrap').forEach(wrap => {
        const phone = wrap.firstElementChild;
        if (phone) {
          wrap.parentNode.insertBefore(phone, wrap);
        }
        wrap.remove();
      });

      // Remove scan‑line pseudo‑elements
      const style = document.createElement('style');
      style.textContent = `
        .golex-phone::after, .chat-phone::after, .explore-phone::after,
        .create-phone::after, .guild-phone::after, .comm-detail-phone::after,
        .room-view-phone::after {
          content: none !important;
        }
      `;
      document.head.appendChild(style);

      // Simplify phone animations
      document.querySelectorAll(
        '.golex-phone, .chat-phone, .explore-phone, .create-phone,' +
        '.comm-detail-phone, .room-view-phone, .guild-phone'
      ).forEach(ph => {
        ph.style.animation = 'floatPhone 5s ease-in-out infinite';
        ph.style.transform = '';
        ph.style.setProperty('--tilt-x', '');
        ph.style.setProperty('--tilt-y', '');
      });

      console.log('All heavy effects disabled');
    });

    // Small breather to settle
    await page.waitForTimeout(500);

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
