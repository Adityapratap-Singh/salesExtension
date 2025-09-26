// Content script to handle text selection and communication with popup

class TextSelectionHandler {
  constructor() {
    this.selectedText = '';
    this.initializeListeners();
  }

  initializeListeners() {
    // Listen for text selection changes
    document.addEventListener('selectionchange', () => {
      this.handleSelectionChange();
    });

    // Listen for messages from popup
    chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
      if (request.action === 'getSelectedText') {
        sendResponse({ selectedText: this.getSelectedText() });
      }
      return true;
    });
  }

  handleSelectionChange() {
    const selection = window.getSelection();
    const selectedText = selection.toString().trim();
    
    if (selectedText && selectedText.length > 2) {
      this.selectedText = selectedText;
      // Store in chrome storage for popup access
      chrome.storage.local.set({ selectedText: selectedText });
      
      // Optional: Show a subtle indicator that text was selected
      this.showSelectionIndicator(selectedText);
    }
  }

  getSelectedText() {
    return window.getSelection().toString().trim();
  }

  showSelectionIndicator(text) {
    // Remove any existing indicator
    const existingIndicator = document.getElementById('price-comparison-indicator');
    if (existingIndicator) {
      existingIndicator.remove();
    }

    // Create a subtle indicator
    const indicator = document.createElement('div');
    indicator.id = 'price-comparison-indicator';
    indicator.style.cssText = `
      position: fixed;
      top: 20px;
      right: 20px;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      color: white;
      padding: 8px 12px;
      border-radius: 20px;
      font-size: 12px;
      font-weight: 600;
      z-index: 10000;
      box-shadow: 0 4px 12px rgba(0,0,0,0.15);
      animation: slideInRight 0.3s ease-out;
      cursor: pointer;
      font-family: 'Segoe UI', system-ui, sans-serif;
      backdrop-filter: blur(10px);
      border: 1px solid rgba(255,255,255,0.2);
    `;
    
    // Add animation keyframes
    if (!document.getElementById('price-comparison-styles')) {
      const style = document.createElement('style');
      style.id = 'price-comparison-styles';
      style.textContent = `
        @keyframes slideInRight {
          from { transform: translateX(100%); opacity: 0; }
          to { transform: translateX(0); opacity: 1; }
        }
        @keyframes slideOutRight {
          from { transform: translateX(0); opacity: 1; }
          to { transform: translateX(100%); opacity: 0; }
        }
      `;
      document.head.appendChild(style);
    }
    
    const truncatedText = text.length > 30 ? text.substring(0, 30) + '...' : text;
    indicator.innerHTML = `
      🛍️ Selected: "${truncatedText}"<br>
      <small style="opacity: 0.8;">Click extension to compare prices</small>
    `;
    
    // Add click handler to open extension
    indicator.addEventListener('click', () => {
      // This will be handled by the user clicking the extension icon
      indicator.style.animation = 'slideOutRight 0.3s ease-in forwards';
      setTimeout(() => indicator.remove(), 300);
    });
    
    document.body.appendChild(indicator);
    
    // Auto-hide after 4 seconds
    setTimeout(() => {
      if (indicator && indicator.parentNode) {
        indicator.style.animation = 'slideOutRight 0.3s ease-in forwards';
        setTimeout(() => indicator.remove(), 300);
      }
    }, 4000);
  }
}

// Initialize the text selection handler
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    new TextSelectionHandler();
  });
} else {
  new TextSelectionHandler();
}

// Export for potential future use
if (typeof module !== 'undefined' && module.exports) {
  module.exports = TextSelectionHandler;
}