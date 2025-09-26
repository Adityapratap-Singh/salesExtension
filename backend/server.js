const express = require('express');
const puppeteer = require('puppeteer');
const cors = require('cors');
const rateLimit = require('express-rate-limit');

class PriceComparisonServer {
  constructor() {
    // Simple browser pool settings
    this.browserPool = null; // will be initialized in initializeBrowserPool
    this.poolSize = parseInt(process.env.PUPPETEER_POOL_SIZE || '2', 10);
    this.app = express();
    this.port = process.env.PORT || 3000;
    this.defaultPageTimeout = 30000; // ms
    this.browser = null;
    this._debugLogs = [];
    this._maxDebugLogs = 200;
    this.setupMiddleware();
    this.setupRoutes();
    this.initializeBrowser();
    this.initializeBrowserPool().catch(err => {
      console.warn('Browser pool failed to initialize:', err && err.message ? err.message : err);
    });
  }

  // Initialize a small pool of browsers to reuse for scraping
  async initializeBrowserPool() {
    try {
      const size = Math.max(1, this.poolSize);
      const launchOpts = {
        headless: 'new',
        timeout: 60000,
        protocolTimeout: 120000,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-accelerated-2d-canvas',
          '--no-first-run',
          '--no-zygote',
          '--single-process',
          '--disable-gpu'
        ]
      };

      this.browserPool = {
        size,
        browsers: [],
        available: [],
        pending: []
      };

      for (let i = 0; i < size; i++) {
        try {
          const b = await puppeteer.launch(launchOpts);
          this.browserPool.browsers.push(b);
          this.browserPool.available.push(b);
        } catch (err) {
          this.logDebug('initializeBrowserPool launch failed for index', i, err && err.message ? err.message : String(err));
        }
      }
      this.logDebug('initializeBrowserPool ready', this.browserPool.available.length, 'of', size);
    } catch (err) {
      console.error('Failed to initialize browser pool:', err);
    }
  }

  async acquireFromPool(timeoutMs = 15000) {
    if (!this.browserPool) throw new Error('No browser pool');
    // immediate available
    if (this.browserPool.available.length > 0) {
      return this.browserPool.available.shift();
    }
    // otherwise wait
    return await new Promise((resolve, reject) => {
      const entry = { resolve, reject };
      this.browserPool.pending.push(entry);
      // timeout
      entry.timer = setTimeout(() => {
        const idx = this.browserPool.pending.indexOf(entry);
        if (idx >= 0) this.browserPool.pending.splice(idx, 1);
        reject(new Error('Pool acquire timeout'));
      }, timeoutMs);
    });
  }

  // Remove a browser instance from the pool (used when a pooled browser is detected as broken)
  removeBrowserFromPool(browser) {
    if (!this.browserPool) return;
    try {
      const bi = this.browserPool.browsers.indexOf(browser);
      if (bi >= 0) this.browserPool.browsers.splice(bi, 1);
      const ai = this.browserPool.available.indexOf(browser);
      if (ai >= 0) this.browserPool.available.splice(ai, 1);
      // if there are pending waiters, try to launch a replacement browser asynchronously
      (async () => {
        try {
          const launchOpts = {
            headless: 'new',
            timeout: 60000,
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
          };
          const nb = await puppeteer.launch(launchOpts);
          this.browserPool.browsers.push(nb);
          this.browserPool.available.push(nb);
          this.logDebug('removeBrowserFromPool: replaced broken browser, pool size now', this.browserPool.available.length);
          // if there are pending, satisfy one
          if (this.browserPool.pending.length > 0) {
            const entry = this.browserPool.pending.shift();
            clearTimeout(entry.timer);
            entry.resolve(this.browserPool.available.shift());
          }
        } catch (e) {
          this.logDebug('removeBrowserFromPool: failed to replace browser', e && e.message ? e.message : String(e));
        }
      })();
    } catch (e) {
      this.logDebug('removeBrowserFromPool error', e && e.message ? e.message : String(e));
    }
  }

  releaseToPool(browser) {
    if (!this.browserPool) return;
    // if there are waiters, satisfy first
    if (this.browserPool.pending.length > 0) {
      const entry = this.browserPool.pending.shift();
      clearTimeout(entry.timer);
      entry.resolve(browser);
      return;
    }
    this.browserPool.available.push(browser);
  }

  async destroyPool() {
    if (!this.browserPool) return;
    const all = this.browserPool.browsers.slice();
    this.browserPool = null;
    for (const b of all) {
      try { await b.close(); } catch (e) {}
    }
  }

  logDebug(...args) {
    try {
      const line = `[${new Date().toISOString()}] ${args.map(a => (a && a.stack) ? a.stack : (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' ')} `;
      this._debugLogs.push(line);
      if (this._debugLogs.length > this._maxDebugLogs) this._debugLogs.shift();
      console.log(line);
    } catch (e) {
      console.log('logDebug error', e);
    }
  }

  setupMiddleware() {
    // Enable CORS for chrome extension
    this.app.use(cors({
      origin: ['chrome-extension://*', 'http://localhost:*'],
      methods: ['GET', 'POST'],
      allowedHeaders: ['Content-Type']
    }));

    this.app.use(express.json());

    // Rate limiting
    const limiter = rateLimit({
      windowMs: 15 * 60 * 1000, // 15 minutes
      max: 50, // limit each IP to 50 requests per windowMs
      message: { error: 'Too many requests, please try again later.' }
    });
    this.app.use(limiter);
  }

  async initializeBrowser() {
    try {
      const launchOpts = {
        headless: 'new',
        timeout: 60000,
        protocolTimeout: 120000,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-accelerated-2d-canvas',
          '--no-first-run',
          '--no-zygote',
          '--single-process',
          '--disable-gpu'
        ]
      };

      try {
        this.browser = await puppeteer.launch(launchOpts);
      } catch (err) {
        console.warn('Default Puppeteer launch failed, attempting executablePath fallbacks:', err && err.message);
        // Try common Chrome locations on Windows
        const possiblePaths = [
          process.env.CHROME_PATH,
          'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
          'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'
        ].filter(Boolean);

        let launched = false;
        for (const p of possiblePaths) {
          try {
            this.browser = await puppeteer.launch(Object.assign({}, launchOpts, { executablePath: p }));
            console.log(`Launched Puppeteer using executablePath=${p}`);
            launched = true;
            break;
          } catch (err2) {
            console.warn(`Launch with executablePath=${p} failed:`, err2 && err2.message);
          }
        }

        if (!launched) throw err;
      }

      console.log('Browser initialized successfully');

      // Log browser disconnects and attempt reinitialization on disconnects
      this.browser.on && this.browser.on('disconnected', async () => {
        console.error('Puppeteer browser disconnected unexpectedly. Attempting to reinitialize...');
        this.browser = null;
        try {
          await this.initializeBrowser();
        } catch (reErr) {
          console.error('Failed to reinitialize browser after disconnect:', reErr);
        }
      });
    } catch (error) {
      console.error('Failed to initialize browser:', error);
    }
  }

  setupRoutes() {
    this.app.get('/health', (req, res) => {
      res.json({ status: 'OK', timestamp: new Date().toISOString() });
    });

    this.app.get('/api/logs', (req, res) => {
      res.json({ logs: this._debugLogs.slice(-100) });
    });

    // Run a single internal scraper with the shared browser (for debugging)
    this.app.get('/api/run-scraper', async (req, res) => {
      const site = (req.query.site || '').toLowerCase();
      const query = (req.query.query || '').trim();
      if (!query || query.length < 2) return res.status(400).json({ error: 'Query must be at least 2 characters' });

      const mapping = {
        amazon: this.scrapeAmazon.bind(this),
        flipkart: this.scrapeFlipkart.bind(this),
        myntra: this.scrapeMyntra.bind(this),
        snapdeal: this.scrapeSnapdeal.bind(this)
      };

      if (!mapping[site]) return res.status(400).json({ error: 'Unknown site' });

      try {
        const results = await mapping[site](query);
        this.logDebug('run-scraper', site, 'returned', results.length);
        return res.json({ site, query, resultsCount: results.length, samples: results.slice(0, 5) });
      } catch (err) {
        console.error('run-scraper error:', err);
        return res.status(500).json({ error: 'run-scraper failed', message: err.message });
      }
    });

    // Debug route: launch a temporary Puppeteer instance to inspect simple selector hits
    this.app.get('/api/debug-scrape', async (req, res) => {
      const site = (req.query.site || '').toLowerCase();
      const query = (req.query.query || '').trim();
      if (!query || query.length < 2) return res.status(400).json({ error: 'Query must be at least 2 characters' });

      try {
        const puppeteer = require('puppeteer');
        const launchOpts = { headless: 'new', args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'] };
        const browser = await puppeteer.launch(launchOpts);
        const page = await browser.newPage();
        await page.setViewport({ width: 1200, height: 800 });
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/117.0.0.0 Safari/537.36');

        let url;
        let selector;
        if (site === 'amazon') {
          url = `https://www.amazon.in/s?k=${encodeURIComponent(query)}`;
          selector = '[data-component-type="s-search-result"], div.s-main-slot > div';
        } else if (site === 'flipkart') {
          url = `https://www.flipkart.com/search?q=${encodeURIComponent(query)}`;
          selector = 'div._1AtVbE, div._2kHMtA, div._3pLy-c';
        } else if (site === 'myntra') {
          url = `https://www.myntra.com/${encodeURIComponent(query)}`;
          selector = '.product-base, .product-flex';
        } else if (site === 'snapdeal') {
          url = `https://www.snapdeal.com/search?keyword=${encodeURIComponent(query)}`;
          selector = '.product-tuple-listing';
        } else {
          await browser.close();
          return res.status(400).json({ error: 'Unknown site. Use amazon|flipkart|myntra|snapdeal' });
        }

        await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
        // allow some time for dynamic content
        await page.waitForTimeout(1000);

        const info = await page.evaluate((sel) => {
          const nodes = Array.from(document.querySelectorAll(sel || 'body'));
          const samples = nodes.slice(0, 6).map(n => ({ html: n.innerHTML.slice(0, 300) }));
          return { count: nodes.length, samples };
        }, selector);

        await browser.close();
        res.json({ site, query, url, selector, info });
      } catch (err) {
        console.error('Debug scrape (temp) failed:', err);
        res.status(500).json({ error: 'Debug scrape failed', message: err.message });
      }
    });

    // Temporary fresh-browser scrape endpoint
    this.app.get('/api/temp-scrape', async (req, res) => {
      const site = (req.query.site || '').toLowerCase();
      const query = (req.query.query || '').trim();
      if (!query || query.length < 2) return res.status(400).json({ error: 'Query must be at least 2 characters' });
      try {
        const data = await this.scrapeSiteWithTempBrowser(site, query);
        res.json({ site, query, count: Array.isArray(data) ? data.length : 0, samples: (Array.isArray(data) ? data.slice(0,5) : []) });
      } catch (err) {
        res.status(500).json({ error: 'temp-scrape failed', message: err && err.message ? err.message : String(err) });
      }
    });

    this.app.post('/api/compare-prices', async (req, res) => {
      try {
        const { query } = req.body;
        
        if (!query || query.trim().length < 2) {
          return res.status(400).json({ 
            error: 'Query must be at least 2 characters long' 
          });
        }

        console.log(`Searching for: ${query}`);
        const results = await this.scrapeMultipleSites(query.trim());
        
        res.json({
          query: query.trim(),
          results: results,
          timestamp: new Date().toISOString()
        });
        
      } catch (error) {
        console.error('Search error:', error);
        res.status(500).json({ 
          error: 'Failed to fetch product data',
          message: error.message 
        });
      }
    });
  }

  async scrapeMultipleSites(query) {
    // Use per-site temporary browsers sequentially to avoid shared-browser instability
    const sites = ['amazon', 'flipkart', 'myntra', 'snapdeal'];
    const products = [];
    for (let i = 0; i < sites.length; i++) {
      const site = sites[i];
      this.logDebug('scrapeMultipleSites: starting temporary-browser scraper', site);
      try {
        const result = await this.scrapeSiteWithTempBrowser(site, query);
        if (Array.isArray(result) && result.length > 0) {
          products.push(...result);
          this.logDebug('scrapeMultipleSites: temp-scraper', site, 'returned', result.length);
        } else {
          this.logDebug('scrapeMultipleSites: temp-scraper', site, 'returned zero items');
        }
      } catch (err) {
        console.error(`Temp-scraper ${site} failed:`, err && err.message ? err.message : err);
        this.logDebug('scraper-failed-temp', site, err && err.message ? err.message : String(err));
      }
    }

    // Sort by price (lowest first) and remove duplicates
    return this.deduplicateAndSort(products);
  }

  async withTimeout(promise, ms) {
    return Promise.race([
      promise,
      new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), ms))
    ]);
  }

  async withRetry(scraperFn, query, attempts = 2) {
    let lastErr;
    for (let i = 0; i < attempts; i++) {
      try {
        // each call should create/close its own page; call scraperFn which returns a Promise
        return await scraperFn(query);
      } catch (err) {
        lastErr = err;
        console.error(`Scraper attempt ${i + 1} failed:`, err && err.message ? err.message : err);
        this.logDebug('withRetry', 'attempt', i + 1, 'failed', err && err.message ? err.message : String(err));
        // if browser disconnected or protocol error, try to reinitialize browser once
        if (/Protocol error|Connection closed|Timeout/.test(err.message || '')) {
          try {
            if (this.browser) {
              await this.browser.close();
            }
            this.logDebug('withRetry', 'closed shared browser due to error, reinitializing');
          } catch (closeErr) {
            console.error('Error closing browser during retry:', closeErr);
            this.logDebug('withRetry', 'error closing browser', closeErr && closeErr.message ? closeErr.message : String(closeErr));
          }
          await this.initializeBrowser();
          this.logDebug('withRetry', 'reinitialized browser during retry');
        }
        // small backoff
        await new Promise(r => setTimeout(r, 500 + i * 200));
      }
    }
    throw lastErr;
  }

  async scrapeAmazon(query) {
    // Use withRetry wrapper to handle transient protocol/timeout errors
    return this.withRetry(async (q) => {
      let page;
      this.logDebug('scrapeAmazon start', q, 'browserPresent', !!this.browser);
      if (!this.browser) {
        this.logDebug('scrapeAmazon: browser missing, reinitializing');
        await this.initializeBrowser();
      }
      try {
        page = await this.browser.newPage();
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/117.0.0.0 Safari/537.36');
        await page.setViewport({ width: 1200, height: 800 });
        await page.setDefaultNavigationTimeout(this.defaultPageTimeout);

        const searchUrl = `https://www.amazon.in/s?k=${encodeURIComponent(q)}`;
        await page.goto(searchUrl, { waitUntil: 'networkidle2', timeout: this.defaultPageTimeout });
        this.logDebug('scrapeAmazon: navigated', searchUrl, 'currentUrl', page.url());

        // quick check for candidate nodes and sample names
        try {
          const dinfo = await page.evaluate(() => {
            const items = Array.from(document.querySelectorAll('[data-component-type="s-search-result"], div.s-main-slot > div'));
            const samples = items.slice(0, 6).map(n => {
              const nameEl = n.querySelector('h2 a span, .a-size-medium.a-color-base.a-text-normal, .s-title-instructions-style');
              return nameEl ? nameEl.textContent.trim().slice(0, 120) : null;
            }).filter(Boolean);
            return { count: items.length, samples };
          });
          this.logDebug('scrapeAmazon pageInfo', dinfo);
        } catch (e) {
          this.logDebug('scrapeAmazon evaluate-check failed', e && e.message ? e.message : String(e));
        }

        // try multiple selector patterns to be more resilient to DOM changes
        const products = await page.evaluate(() => {
          const items = document.querySelectorAll('[data-component-type="s-search-result"], div.s-main-slot > div');
          const results = [];

          for (let i = 0; i < Math.min(items.length, 8); i++) {
            const item = items[i];
            try {
              const nameEl = item.querySelector('h2 a span, .a-size-medium.a-color-base.a-text-normal, .s-title-instructions-style');
              const priceEl = item.querySelector('.a-price .a-offscreen, .a-price-whole, .a-price-fraction');
              const imageEl = item.querySelector('img.s-image, img[data-image-latency]');
              const ratingEl = item.querySelector('.a-icon-alt');
              const linkEl = item.querySelector('h2 a, a.a-link-normal.s-no-outline');

              const name = nameEl ? nameEl.textContent.trim() : null;
                const priceText = priceEl ? priceEl.textContent.replace(/[^\d.,]/g, '').replace(/,/g, '') : null;
              const price = priceText ? parseFloat(priceText) : null;
              const image = imageEl ? (imageEl.src || imageEl.getAttribute('data-src') || null) : null;
              const rating = ratingEl ? parseFloat(ratingEl.textContent.split(' ')[0]) : null;
              const link = linkEl ? (linkEl.getAttribute('href') || null) : null;

              if (name && price) {
                results.push({ platform: 'Amazon', name, price, image, rating, link: link ? (link.startsWith('http') ? link : ('https://amazon.in' + link)) : null });
              }
            } catch (e) {
              // ignore parsing errors for individual items
            }
          }
          return results;
        });

        return products;
      } finally {
        if (page) await page.close().catch(() => {});
      }
    }, query, 2).catch(err => {
      console.error('Amazon scraping error:', err);
      return [];
    });

    // If the shared-browser run returned nothing, try a fresh temporary browser (more reliable in some envs)
    if ((!Array.isArray(products) || products.length === 0)) {
      this.logDebug('scrapeAmazon: no products from shared browser, attempting temporary fresh browser fallback');
      try {
        const launchOpts = { headless: 'new', args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'] };
        const tempBrowser = await puppeteer.launch(launchOpts);
        const tempPage = await tempBrowser.newPage();
        await tempPage.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/117.0.0.0 Safari/537.36');
        await tempPage.setViewport({ width: 1200, height: 800 });
        await tempPage.goto(`https://www.amazon.in/s?k=${encodeURIComponent(query)}`, { waitUntil: 'networkidle2', timeout: this.defaultPageTimeout }).catch(() => {});
        await tempPage.waitForTimeout(1000).catch(() => {});
        const freshProducts = await tempPage.evaluate(() => {
          const items = document.querySelectorAll('[data-component-type="s-search-result"], div.s-main-slot > div');
          const results = [];
          for (let i = 0; i < Math.min(items.length, 8); i++) {
            const item = items[i];
            try {
              const nameEl = item.querySelector('h2 a span, .a-size-medium.a-color-base.a-text-normal, .s-title-instructions-style');
              const priceEl = item.querySelector('.a-price .a-offscreen, .a-price-whole, .a-price-fraction');
              const imageEl = item.querySelector('img.s-image, img[data-image-latency]');
              const ratingEl = item.querySelector('.a-icon-alt');
              const linkEl = item.querySelector('h2 a, a.a-link-normal.s-no-outline');

              const name = nameEl ? nameEl.textContent.trim() : null;
              const priceText = priceEl ? priceEl.textContent.replace(/[^\d.,]/g, '').replace(/,/g, '') : null;
              const price = priceText ? parseFloat(priceText) : null;
              const image = imageEl ? (imageEl.src || imageEl.getAttribute('data-src') || null) : null;
              const rating = ratingEl ? parseFloat(ratingEl.textContent.split(' ')[0]) : null;
              const link = linkEl ? (linkEl.getAttribute('href') || null) : null;

              if (name && price) {
                results.push({ platform: 'Amazon', name, price, image, rating, link: link ? (link.startsWith('http') ? link : ('https://amazon.in' + link)) : null });
              }
            } catch (e) {}
          }
          return results;
        }).catch(() => []);
        await tempPage.close().catch(() => {});
        await tempBrowser.close().catch(() => {});
        if (Array.isArray(freshProducts) && freshProducts.length > 0) {
          this.logDebug('scrapeAmazon: temporary browser returned', freshProducts.length, 'items');
          return freshProducts;
        }
      } catch (e) {
        this.logDebug('scrapeAmazon fallback error', e && e.message ? e.message : String(e));
      }
    }

  }

  async scrapeFlipkart(query) {
    return this.withRetry(async (q) => {
      let page;
      this.logDebug('scrapeFlipkart start', q, 'browserPresent', !!this.browser);
      if (!this.browser) {
        this.logDebug('scrapeFlipkart: browser missing, reinitializing');
        await this.initializeBrowser();
      }
      try {
        page = await this.browser.newPage();
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/117.0.0.0 Safari/537.36');
        await page.setViewport({ width: 1200, height: 900 });
        await page.setDefaultNavigationTimeout(this.defaultPageTimeout);

        const searchUrl = `https://www.flipkart.com/search?q=${encodeURIComponent(q)}`;
        await page.goto(searchUrl, { waitUntil: 'networkidle2', timeout: this.defaultPageTimeout });
        this.logDebug('scrapeFlipkart: navigated', searchUrl, 'currentUrl', page.url());
        try {
          const dinfo = await page.evaluate(() => {
            const items = Array.from(document.querySelectorAll('div._1AtVbE, div._2kHMtA, div._3pLy-c'));
            const samples = items.slice(0, 6).map(n => {
              const nameEl = n.querySelector('a.s1Q9rs, ._4rR01T, a[title]');
              return nameEl ? (nameEl.textContent.trim().slice(0, 120) || nameEl.getAttribute('title')) : null;
            }).filter(Boolean);
            return { count: items.length, samples };
          });
          this.logDebug('scrapeFlipkart pageInfo', dinfo);
        } catch (e) {
          this.logDebug('scrapeFlipkart evaluate-check failed', e && e.message ? e.message : String(e));
        }

        // close login modal if present
        try {
          const closeBtn = await page.$('button._2KpZ6l._2doB4z');
          if (closeBtn) await closeBtn.click();
        } catch (e) {}

        const products = await page.evaluate(() => {
          // select likely product containers
          const items = document.querySelectorAll('div._1AtVbE, div._2kHMtA, div._3pLy-c');
          const results = [];
          for (let i = 0; i < Math.min(items.length, 8); i++) {
            const item = items[i];
            try {
              const nameEl = item.querySelector('a.s1Q9rs, ._4rR01T, a[title]');
              const priceEl = item.querySelector('._30jeq3, ._25b18c');
              const imageEl = item.querySelector('img');
              const ratingEl = item.querySelector('._3LWZlK');
              const linkEl = item.querySelector('a[href]');

              const name = nameEl ? (nameEl.textContent.trim() || nameEl.getAttribute('title')) : null;
              const priceText = priceEl ? priceEl.textContent.replace(/[^\d.,]/g, '').replace(/,/g, '') : null;
              const price = priceText ? parseFloat(priceText) : null;
              const image = imageEl ? (imageEl.src || imageEl.getAttribute('data-src') || null) : null;
              const rating = ratingEl ? parseFloat(ratingEl.textContent) : null;
              const link = linkEl ? linkEl.getAttribute('href') : null;

              if (name && price) {
                results.push({ platform: 'Flipkart', name, price, image, rating, link: link ? (link.startsWith('http') ? link : ('https://flipkart.com' + link)) : null });
              }
            } catch (e) {}
          }
          return results;
        });

        return products;
      } finally {
        if (page) await page.close().catch(() => {});
      }
    }, query, 2).catch(err => {
      console.error('Flipkart scraping error:', err);
      return [];
    });
  }

  async scrapeMyntra(query) {
    let page;
    try {
      page = await this.browser.newPage();
      await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36');
      
      const searchUrl = `https://www.myntra.com/${encodeURIComponent(query)}`;
      await page.goto(searchUrl, { waitUntil: 'networkidle2', timeout: 10000 });

      const products = await page.evaluate(() => {
        const items = document.querySelectorAll('.product-base');
        const results = [];

        for (let i = 0; i < Math.min(items.length, 5); i++) {
          const item = items[i];
          try {
            const nameEl = item.querySelector('.product-product');
            const priceEl = item.querySelector('.product-discountedPrice');
            const imageEl = item.querySelector('.product-imageSlider img');
            const ratingEl = item.querySelector('.product-ratingsCount');
            const linkEl = item.querySelector('a');

            if (nameEl && priceEl) {
              const name = nameEl.textContent.trim();
              const priceText = priceEl.textContent.replace(/[^\d.]/g, '');
              const price = priceText ? parseFloat(priceText) : null;
              const image = imageEl ? imageEl.src : null;
              const rating = ratingEl ? parseFloat(ratingEl.textContent) : null;
              const link = linkEl ? 'https://myntra.com' + linkEl.getAttribute('href') : null;

              if (price && name) {
                results.push({
                  platform: 'Myntra',
                  name,
                  price,
                  image,
                  rating,
                  link
                });
              }
            }
          } catch (e) {
            console.log('Error parsing Myntra item:', e);
          }
        }
        return results;
      });

      return products;
    } catch (error) {
      console.error('Myntra scraping error:', error);
      return [];
    } finally {
      if (page) await page.close();
    }
  }

  async scrapeSnapdeal(query) {
    let page;
    try {
      page = await this.browser.newPage();
      await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36');
      
      const searchUrl = `https://www.snapdeal.com/search?keyword=${encodeURIComponent(query)}`;
      await page.goto(searchUrl, { waitUntil: 'networkidle2', timeout: 10000 });

      const products = await page.evaluate(() => {
        const items = document.querySelectorAll('.product-tuple-listing');
        const results = [];

        for (let i = 0; i < Math.min(items.length, 5); i++) {
          const item = items[i];
          try {
            const nameEl = item.querySelector('.product-title');
            const priceEl = item.querySelector('.product-price');
            const imageEl = item.querySelector('.product-image img');
            const ratingEl = item.querySelector('.filled-stars');
            const linkEl = item.querySelector('.dp-widget-link');

            if (nameEl && priceEl) {
              const name = nameEl.textContent.trim();
              const priceText = priceEl.textContent.replace(/[^\d.]/g, '');
              const price = priceText ? parseFloat(priceText) : null;
              const image = imageEl ? imageEl.src : null;
              const rating = ratingEl ? parseFloat(ratingEl.getAttribute('title')) : null;
              const link = linkEl ? linkEl.getAttribute('href') : null;

              if (price && name) {
                results.push({
                  platform: 'Snapdeal',
                  name,
                  price,
                  image,
                  rating,
                  link
                });
              }
            }
          } catch (e) {
            console.log('Error parsing Snapdeal item:', e);
          }
        }
        return results;
      });

      return products;
    } catch (error) {
      console.error('Snapdeal scraping error:', error);
      return [];
    } finally {
      if (page) await page.close();
    }
  }

  // Fallback: launch a temporary browser and scrape a single site (used by scrapeMultipleSites)
  async scrapeSiteWithTempBrowser(site, query) {
    const pupp = require('puppeteer');
  const launchOpts = { headless: 'new', timeout: 60000, protocolTimeout: 120000, args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'] };
    let browser = null;
    let page = null;
    let borrowedFromPool = false;
    let lastErr = null;

    // Try twice: prefer pooled browser first, then fallback to fresh browser on failure
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        this.logDebug('scrapeSiteWithTempBrowser attempt', attempt + 1, 'site', site);

        if (this.browserPool && !browser) {
          try {
            browser = await this.acquireFromPool(30000);
            borrowedFromPool = true;
          } catch (e) {
            this.logDebug('scrapeSiteWithTempBrowser: pool acquire failed', e && e.message ? e.message : String(e));
          }
        }

        if (!browser) {
          browser = await pupp.launch(launchOpts);
          borrowedFromPool = false;
        }

        // create page
        try {
          page = await browser.newPage();
        } catch (e) {
          this.logDebug('scrapeSiteWithTempBrowser: newPage failed', e && e.message ? e.message : String(e));
          if (borrowedFromPool) {
            try { this.removeBrowserFromPool(browser); } catch (er) {}
          }
          try { await browser.close().catch(() => {}); } catch (er) {}
          browser = null;
          page = null;
          throw e;
        }

        await page.setViewport({ width: 1200, height: 900 });
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/117.0.0.0 Safari/537.36');

        let data = [];

        if (site === 'amazon') {
          const url = `https://www.amazon.in/s?k=${encodeURIComponent(query)}`;
          await page.goto(url, { waitUntil: 'networkidle2', timeout: this.defaultPageTimeout });
          await page.waitForTimeout(1500).catch(() => {});
          data = await page.evaluate(() => {
            const items = Array.from(document.querySelectorAll('[data-component-type="s-search-result"], div.s-main-slot > div'));
            const results = [];
            for (let i = 0; i < Math.min(items.length, 8); i++) {
              const item = items[i];
              try {
                const nameEl = item.querySelector('h2 a span, .a-size-medium.a-color-base.a-text-normal');
                const priceEl = item.querySelector('.a-price .a-offscreen, .a-price-whole');
                const imageEl = item.querySelector('img.s-image');
                const ratingEl = item.querySelector('.a-icon-alt');
                const linkEl = item.querySelector('h2 a');
                const dataAsin = item.getAttribute('data-asin') || (item.dataset ? item.dataset.asin : null);
                const name = nameEl ? nameEl.textContent.trim() : null;
                const priceText = priceEl ? priceEl.textContent.replace(/[^\d.,]/g, '').replace(/,/g, '') : null;
                const price = priceText ? parseFloat(priceText) : null;
                const image = imageEl ? (imageEl.src || null) : null;
                const rating = ratingEl ? parseFloat(ratingEl.textContent.split(' ')[0]) : null;
                let link = null;
                if (linkEl) link = linkEl.getAttribute('href') || null;
                if (!link && dataAsin) link = `/dp/${dataAsin}`;
                if (name && price) results.push({ platform: 'Amazon', name, price, image, rating, link: link ? (link.startsWith('http') ? link : ('https://amazon.in' + link)) : null });
              } catch (e) {}
            }
            return results;
          });
        } else if (site === 'flipkart') {
          const url = `https://www.flipkart.com/search?q=${encodeURIComponent(query)}`;
          await page.goto(url, { waitUntil: 'networkidle2', timeout: this.defaultPageTimeout });
          await page.waitForTimeout(1200).catch(() => {});
          data = await page.evaluate(() => {
            const items = Array.from(document.querySelectorAll('div._1AtVbE, div._2kHMtA, div._3pLy-c'));
            const results = [];
            for (let i = 0; i < Math.min(items.length, 8); i++) {
              const item = items[i];
              try {
                const nameEl = item.querySelector('a.s1Q9rs, ._4rR01T, a[title]');
                const priceEl = item.querySelector('._30jeq3, ._25b18c');
                const imageEl = item.querySelector('img');
                const ratingEl = item.querySelector('._3LWZlK');
                const linkEl = item.querySelector('a[href]');
                const name = nameEl ? (nameEl.textContent.trim() || nameEl.getAttribute('title')) : null;
                const priceText = priceEl ? priceEl.textContent.replace(/[^\d.,]/g, '').replace(/,/g, '') : null;
                const price = priceText ? parseFloat(priceText) : null;
                const image = imageEl ? (imageEl.src || null) : null;
                const rating = ratingEl ? parseFloat(ratingEl.textContent) : null;
                const link = linkEl ? linkEl.getAttribute('href') : null;
                if (name && price) results.push({ platform: 'Flipkart', name, price, image, rating, link: link ? (link.startsWith('http') ? link : ('https://flipkart.com' + link)) : null });
              } catch (e) {}
            }
            return results;
          });
        } else if (site === 'myntra') {
          const url = `https://www.myntra.com/${encodeURIComponent(query)}`;
          await page.goto(url, { waitUntil: 'networkidle2', timeout: this.defaultPageTimeout });
          await page.waitForTimeout(800).catch(() => {});
          data = await page.evaluate(() => {
            const items = Array.from(document.querySelectorAll('.product-base'));
            const results = [];
            for (let i = 0; i < Math.min(items.length, 6); i++) {
              const item = items[i];
              try {
                const nameEl = item.querySelector('.product-product');
                const priceEl = item.querySelector('.product-discountedPrice');
                const imageEl = item.querySelector('.product-imageSlider img');
                const ratingEl = item.querySelector('.product-ratingsCount');
                const linkEl = item.querySelector('a');
                if (nameEl && priceEl) {
                  const name = nameEl.textContent.trim();
                  const priceText = priceEl.textContent.replace(/[^\d.,]/g, '').replace(/,/g, '');
                  const price = priceText ? parseFloat(priceText) : null;
                  const image = imageEl ? imageEl.src : null;
                  const rating = ratingEl ? parseFloat(ratingEl.textContent) : null;
                  const link = linkEl ? 'https://myntra.com' + linkEl.getAttribute('href') : null;
                  if (price && name) results.push({ platform: 'Myntra', name, price, image, rating, link });
                }
              } catch (e) {}
            }
            return results;
          });
        } else if (site === 'snapdeal') {
          const url = `https://www.snapdeal.com/search?keyword=${encodeURIComponent(query)}`;
          await page.goto(url, { waitUntil: 'networkidle2', timeout: this.defaultPageTimeout });
          await page.waitForTimeout(800).catch(() => {});
          data = await page.evaluate(() => {
            const items = Array.from(document.querySelectorAll('.product-tuple-listing'));
            const results = [];
            for (let i = 0; i < Math.min(items.length, 6); i++) {
              const item = items[i];
              try {
                const nameEl = item.querySelector('.product-title');
                const priceEl = item.querySelector('.product-price');
                const imageEl = item.querySelector('.product-image img');
                const ratingEl = item.querySelector('.filled-stars');
                const linkEl = item.querySelector('.dp-widget-link');
                if (nameEl && priceEl) {
                  const name = nameEl.textContent.trim();
                  const priceText = priceEl.textContent.replace(/[^\d.,]/g, '').replace(/,/g, '');
                  const price = priceText ? parseFloat(priceText) : null;
                  const image = imageEl ? imageEl.src : null;
                  const rating = ratingEl ? parseFloat(ratingEl.getAttribute('title')) : null;
                  const link = linkEl ? linkEl.getAttribute('href') : null;
                  if (price && name) results.push({ platform: 'Snapdeal', name, price, image, rating, link });
                }
              } catch (e) {}
            }
            return results;
          });
        }

        // normalize links relative to final page url
        const base = page.url();
        const normalized = (Array.isArray(data) ? data : []).map(p => {
          let link = p.link || null;
          if (link && !/^https?:\/\//i.test(link)) {
            try { link = new URL(link, base).href; } catch (e) {}
          }
          return Object.assign({}, p, { link });
        });

        // cleanup and return
        try { await page.close().catch(() => {}); } catch (e) {}
        if (browser) {
          if (borrowedFromPool) this.releaseToPool(browser);
          else await browser.close().catch(() => {});
        }

        return normalized;
      } catch (err) {
        lastErr = err;
        this.logDebug('scrapeSiteWithTempBrowser attempt failed', attempt + 1, err && err.message ? err.message : String(err));
        try { if (page) await page.close().catch(() => {}); } catch (e) {}
        if (browser) {
          try {
            if (borrowedFromPool) this.removeBrowserFromPool(browser);
            else await browser.close().catch(() => {});
          } catch (e) {}
        }
        browser = null;
        page = null;
        borrowedFromPool = false;
        // small delay before retry
        await new Promise(r => setTimeout(r, 600));
        continue;
      }
    }

    throw new Error(lastErr ? (lastErr.message || String(lastErr)) : 'temp-scrape failed');
  }

  deduplicateAndSort(products) {
    // Remove duplicates based on similar names and prices
    const unique = [];
    const seen = new Set();

    products.forEach(product => {
      const key = `${product.name.toLowerCase().substring(0, 50)}-${product.price}`;
      if (!seen.has(key)) {
        seen.add(key);
        unique.push(product);
      }
    });

    // Sort by price (lowest first)
    return unique.sort((a, b) => (a.price || 999999) - (b.price || 999999));
  }

  async start() {
    this.app.listen(this.port, () => {
      console.log(`Price Comparison Server running on port ${this.port}`);
      console.log(`Health check: http://localhost:${this.port}/health`);
    });

    // Graceful shutdown
    process.on('SIGINT', async () => {
      console.log('Shutting down server...');
      if (this.browser) {
        await this.browser.close();
      }
      process.exit(0);
    });
  }
}

// Start the server
const server = new PriceComparisonServer();
server.start().catch(console.error);