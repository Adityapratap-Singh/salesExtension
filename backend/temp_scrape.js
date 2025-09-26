const puppeteer = require('puppeteer');

(async () => {
  const query = process.argv[2] || '7 habits';
  const launchOpts = {
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage'
    ]
  };

  try {
    const browser = await puppeteer.launch(launchOpts);
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/117.0.0.0 Safari/537.36');
    await page.setViewport({ width: 1200, height: 800 });
    const url = `https://www.amazon.in/s?k=${encodeURIComponent(query)}`;
    console.log('Navigating to', url);
    const start = Date.now();
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
    const took = Date.now() - start;
    console.log('Loaded in', took, 'ms');

    const counts = await page.evaluate(() => {
      const items = document.querySelectorAll('[data-component-type="s-search-result"], div.s-main-slot > div');
      return { items: items.length };
    });

    console.log('Found items:', counts.items);
    // optionally save a small screenshot
    await page.screenshot({ path: 'amazon_test.png', fullPage: false });
    console.log('Saved screenshot: amazon_test.png');

    await browser.close();
    process.exit(0);
  } catch (err) {
    console.error('Error in temp_scrape:', err);
    process.exit(2);
  }
})();