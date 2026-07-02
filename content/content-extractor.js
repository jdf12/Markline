// Content script: extract readable article text using Readability.
// Injected programmatically from the service worker when a bookmark is created.
(function () {
  'use strict';

  function extractContent() {
    try {
      const doc = document.cloneNode(true);
      const article = new Readability(doc).parse();
      const metaDesc = document.querySelector('meta[name="description"]')?.content || '';
      const textContent = article?.textContent || document.body?.innerText || '';
      return {
        title: article?.title || document.title || '',
        excerpt: article?.excerpt || metaDesc || '',
        textContent,
        metaDesc,
        lengthChars: textContent.length
      };
    } catch (err) {
      return null;
    }
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message && message.action === 'extractContent') {
      sendResponse(extractContent());
    }
  });
})();
