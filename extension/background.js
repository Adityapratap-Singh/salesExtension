// Background service worker for Chrome extension

class BackgroundService {
  constructor() {
    this.initializeListeners();
  }

  initializeListeners() {
    // Handle extension installation
    chrome.runtime.onInstalled.addListener((details) => {
      console.log('Price Comparison Extension installed:', details.reason);
      
      if (details.reason === 'install') {
        this.showWelcomeNotification();
      }
    });

    // Handle messages from content scripts and popup
    chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
      switch (request.action) {
        case 'getSelectedText':
          this.handleGetSelectedText(sender.tab.id, sendResponse);
          return true; // Keep message channel open for async response
        
        case 'openProductPage':
          this.openProductPage(request.url);
          break;
          
        case 'trackSearch':
          this.trackSearchAnalytics(request.query);
          break;
      }
    });

    // Handle extension icon click (optional - popup handles most interactions)
    chrome.action.onClicked.addListener((tab) => {
      console.log('Extension icon clicked on tab:', tab.url);
    });
  }

  async handleGetSelectedText(tabId, sendResponse) {
    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId: tabId },
        function: () => {
          return window.getSelection().toString().trim();
        }
      });
      
      const selectedText = results[0]?.result || '';
      sendResponse({ selectedText });
    } catch (error) {
      console.error('Error getting selected text:', error);
      sendResponse({ selectedText: '' });
    }
  }

  openProductPage(url) {
    if (url && this.isValidUrl(url)) {
      chrome.tabs.create({ url: url });
    }
  }

  isValidUrl(string) {
    try {
      new URL(string);
      return true;
    } catch (_) {
      return false;
    }
  }

  trackSearchAnalytics(query) {
    // Store search analytics locally
    chrome.storage.local.get(['searchHistory'], (result) => {
      const history = result.searchHistory || [];
      history.push({
        query: query,
        timestamp: Date.now()
      });
      
      // Keep only last 100 searches
      const recentHistory = history.slice(-100);
      
      chrome.storage.local.set({ searchHistory: recentHistory });
    });
  }

  showWelcomeNotification() {
    // Show welcome notification on installation
    chrome.notifications.create({
      type: 'basic',
      iconUrl: 'icons/icon48.png',
      title: 'Price Comparison Tool',
      message: 'Extension installed! Select text on any webpage and click the extension icon to compare prices.'
    });
  }

  // Clean up old data periodically
  cleanupOldData() {
    const oneWeekAgo = Date.now() - (7 * 24 * 60 * 60 * 1000);
    
    chrome.storage.local.get(['searchHistory'], (result) => {
      if (result.searchHistory) {
        const cleanHistory = result.searchHistory.filter(
          item => item.timestamp > oneWeekAgo
        );
        chrome.storage.local.set({ searchHistory: cleanHistory });
      }
    });
  }
}

// Initialize background service
const backgroundService = new BackgroundService();

// Clean up old data daily
chrome.alarms.create('cleanup', { periodInMinutes: 24 * 60 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'cleanup') {
    backgroundService.cleanupOldData();
  }
});