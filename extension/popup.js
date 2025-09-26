class PriceComparisonPopup {
  constructor() {
    this.apiEndpoint = 'http://localhost:3000/api/compare-prices';
    this.initializeElements();
    this.bindEvents();
    this.loadSelectedText();
  }

  initializeElements() {
    this.productInput = document.getElementById('productInput');
    this.useSelectionBtn = document.getElementById('useSelection');
    this.searchBtn = document.getElementById('searchBtn');
    this.loadingIndicator = document.getElementById('loadingIndicator');
    this.errorMessage = document.getElementById('errorMessage');
    this.resultsContainer = document.getElementById('resultsContainer');
    this.resultsList = document.getElementById('resultsList');
    this.resultCount = document.getElementById('resultCount');
    this.emptyState = document.getElementById('emptyState');
  }

  bindEvents() {
    this.searchBtn.addEventListener('click', () => this.handleSearch());
    this.useSelectionBtn.addEventListener('click', () => this.useSelectedText());
    this.productInput.addEventListener('keypress', (e) => {
      if (e.key === 'Enter') this.handleSearch();
    });
  }

  async loadSelectedText() {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab || !tab.id) return;

      const results = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        function: () => window.getSelection().toString().trim()
      });

      const selectedText = results?.[0]?.result || '';
      if (selectedText) {
        // store selection for later use
        chrome.storage.local.set({ selectedText });
        this.useSelectionBtn.style.background = '#e3f2fd';
        this.useSelectionBtn.title = `Use selected: "${selectedText.substring(0, 30)}..."`;
      }
    } catch (error) {
      // Not critical - just no selection available
      console.log('No text selection found or failed to read selection', error);
    }
  }

  async useSelectedText() {
    // chrome.storage.local.get uses callback API in MV3; wrap in a Promise for async/await
    try {
      const selectedText = await new Promise((resolve) => {
        chrome.storage.local.get(['selectedText'], (result) => {
          resolve(result?.selectedText || '');
        });
      });

      if (selectedText) {
        this.productInput.value = selectedText;
        this.productInput.focus();
      } else {
        this.showError('No text selected on the webpage. Please select text first.');
      }
    } catch (error) {
      this.showError('Failed to retrieve selected text.');
    }
  }

  async handleSearch() {
    const query = this.productInput.value.trim();
    if (!query) {
      this.showError('Please enter a product name');
      return;
    }

    this.showLoading();

    try {
      const response = await fetch(this.apiEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query })
      });

      if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw new Error(`HTTP ${response.status} ${text}`);
      }

      const data = await response.json();
      this.displayResults(data.results, query);
    } catch (error) {
      console.error('Search error:', error);
      this.showError('Failed to fetch prices. Please check your connection and try again.');
    }
  }

  showLoading() {
    this.hideAllSections();
    this.loadingIndicator.classList.remove('hidden');
  }

  showError(message) {
    this.hideAllSections();
    this.errorMessage.querySelector('p').textContent = message;
    this.errorMessage.classList.remove('hidden');
    // auto-hide after 6s
    setTimeout(() => {
      this.errorMessage.classList.add('hidden');
      this.emptyState.classList.remove('hidden');
    }, 6000);
  }

  displayResults(results, query) {
    this.hideAllSections();

    if (!results || results.length === 0) {
      this.showError(`No products found for "${query}". Try a different search term.`);
      return;
    }

    this.resultCount.textContent = `${results.length} result${results.length !== 1 ? 's' : ''}`;
    this.resultsList.innerHTML = '';

    results.forEach(product => {
      const productElement = this.createProductElement(product);
      this.resultsList.appendChild(productElement);
    });

    this.resultsContainer.classList.remove('hidden');
  }

  createProductElement(product) {
    const div = document.createElement('div');
    div.className = 'product-item';

    const rating = product.rating ? parseFloat(product.rating) : 0;
    const ratingStars = this.generateStars(rating);
    const priceText = (product.price || product.price === 0)
      ? new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' }).format(product.price)
      : 'N/A';

    div.innerHTML = `
      <div class="product-header">
        <div class="product-info">
          <div class="product-platform">${this.escapeHtml(product.platform || '')}</div>
          <div class="product-name">${this.escapeHtml(product.name)}</div>
        </div>
      </div>
      <div class="product-details">
        <div class="product-price">${priceText}</div>
        <div class="product-rating">
          <span class="rating-stars">${ratingStars}</span>
          <span>${rating > 0 ? rating.toFixed(1) : 'N/A'}</span>
        </div>
      </div>
      <button class="buy-button">🛒 Go to ${this.escapeHtml(product.platform || 'site')}</button>
    `;

    // attach click handler to open product page via background script
    const buyBtn = div.querySelector('.buy-button');
    buyBtn.addEventListener('click', () => {
      if (product.link) {
        chrome.runtime.sendMessage({ action: 'openProductPage', url: product.link });
      } else {
        this.showError('Product link is missing or invalid.');
      }
    });

    // make clicking the name or image also open the product page
    const header = div.querySelector('.product-header');
    header.style.cursor = 'pointer';
    header.addEventListener('click', () => {
      if (product.link) chrome.runtime.sendMessage({ action: 'openProductPage', url: product.link });
    });

    return div;
  }

  escapeHtml(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  generateStars(rating) {
    const fullStars = Math.floor(rating);
    const hasHalfStar = rating % 1 >= 0.5;
    const emptyStars = 5 - fullStars - (hasHalfStar ? 1 : 0);

    return '★'.repeat(fullStars) + (hasHalfStar ? '☆' : '') + '☆'.repeat(emptyStars);
  }

  hideAllSections() {
    this.loadingIndicator.classList.add('hidden');
    this.errorMessage.classList.add('hidden');
    this.resultsContainer.classList.add('hidden');
    this.emptyState.classList.add('hidden');
  }
}

// Initialize popup when DOM is loaded
document.addEventListener('DOMContentLoaded', () => {
  new PriceComparisonPopup();
});