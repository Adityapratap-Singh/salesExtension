Price Comparison Chrome Extension

Overview

This repository contains a Chrome extension (MV3) and a Node.js backend that uses Puppeteer to scrape product data from major e-commerce sites (Amazon, Flipkart, Myntra, Snapdeal). The extension provides two input modes: manual product name entry and using selected text from any webpage.

Structure

- backend/
  - server.js        - Express + Puppeteer server exposing POST /api/compare-prices
  - package.json
- extension/
  - manifest.json
  - popup.html
  - popup.css
  - popup.js
  - content.js
  - background.js
  - icons/

Quick start (development)

1. Install dependencies for backend

```powershell
cd backend
npm install
```

2. Start the backend server (Puppeteer will launch a browser; ensure your environment satisfies Puppeteer requirements)

```powershell
npm run dev
# or
npm start
```

If Puppeteer fails to launch due to missing Chromium dependencies on Windows, try installing dependencies or run with environment variables to use a local Chrome install. See Puppeteer docs.

3. Load the extension into Chrome

- Open chrome://extensions
- Enable "Developer mode"
- Click "Load unpacked" and choose the `extension/` folder from this repo
- The extension icon will appear in the toolbar. Click it to open the popup.

Usage

- Manually type the product name into the popup and click "Check Prices".
- Or select text on any webpage (highlight product name). A subtle indicator appears; click the extension popup and press the selection button to fill the selected text.
- Results show product image, name, platform, rating, price, and a "Go to site" button that opens the product page in a new tab.

Notes & Limitations

- Scraping fragile: the backend uses CSS selectors that may break if sites change their markup. Tweak selectors in `backend/server.js`.
- Rate limits and legal: Scraping sites at scale may violate terms of service. Use responsibly and implement caching, request throttling, or official APIs where available.
- Puppeteer resource usage: running Chromium can be heavy on small machines. Consider running the backend on a server.

What's left (optional improvements)

- Add unit tests for scraping functions.
- Add better deduplication using fuzzy matching.
- Improve UI with loading placeholders and skeletons.
- Add retry/backoff logic and more robust error reporting.

License: MIT
