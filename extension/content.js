/**
 * Content Script – Sales Navigator Search Results
 * =================================================
 * Injected on https://www.linkedin.com/sales/search/*
 *
 * Responsibilities:
 *   1. Scroll the page to load all lazy-loaded result cards.
 *   2. Extract lead data from each card.
 *   3. Report leads + page metadata back to the background worker.
 *   4. Click "Next page" when told to advance.
 *
 * Communication:
 *   background → content:  chrome.tabs.sendMessage
 *   content → background:  chrome.runtime.sendMessage
 */

// ── Selectors (Sales Navigator 2024/2025 DOM) ────────────────────────────
const SEL = {
  resultCard:   "li.artdeco-list__item",
  personName:   "[data-anonymize='person-name']",
  headline:     "[data-anonymize='headline']",
  companyName:  "[data-anonymize='company-name']",
  linkedinLink: "a[href*='linkedin.com/in/']",
  salesNavLink: "a[href*='/sales/lead/']",
  nextPageBtn:  "button.artdeco-pagination__button--next",
  totalResults: ".search-results__result-count",
  currentPage:  "button.artdeco-pagination__indicator--number.active, button.artdeco-pagination__indicator--number[aria-current='true']",
};


// ── Utilities ─────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function randomDelay(minMs, maxMs) {
  return sleep(minMs + Math.random() * (maxMs - minMs));
}


// ── Scroll to load all cards on the current page ─────────────────────────

async function scrollToLoadAll() {
  const maxStaleRounds = 5;
  let staleRounds = 0;
  let previousCount = 0;

  for (let i = 0; i < 30; i++) {          // safety cap: 30 scroll iterations
    window.scrollTo(0, document.body.scrollHeight);
    await randomDelay(1500, 3000);

    // Try clicking "Show more results" if present
    const showMore = document.querySelector("button.artdeco-button--muted");
    if (showMore && showMore.textContent.toLowerCase().includes("show more")) {
      showMore.click();
      await randomDelay(2000, 4000);
    }

    const currentCount = document.querySelectorAll(SEL.resultCard).length;
    if (currentCount === previousCount) {
      staleRounds++;
      if (staleRounds >= maxStaleRounds) break;
    } else {
      staleRounds = 0;
    }
    previousCount = currentCount;
  }

  // Scroll back to top so the page is in a normal state
  window.scrollTo(0, 0);
  await sleep(500);
}


// ── Extract leads from DOM ───────────────────────────────────────────────

function extractLeads() {
  const cards = document.querySelectorAll(SEL.resultCard);
  const leads = [];

  for (const card of cards) {
    try {
      const nameEl    = card.querySelector(SEL.personName);
      const titleEl   = card.querySelector(SEL.headline);
      const companyEl = card.querySelector(SEL.companyName);
      const liLink    = card.querySelector(SEL.linkedinLink);
      const snLink    = card.querySelector(SEL.salesNavLink);

      const fullName = nameEl ? nameEl.textContent.trim() : "";
      if (!fullName) continue;               // skip empty cards

      leads.push({
        full_name:     fullName,
        job_title:     titleEl   ? titleEl.textContent.trim()   : "",
        company_name:  companyEl ? companyEl.textContent.trim() : "",
        linkedin_url:  liLink    ? liLink.href.split("?")[0]    : "",
        sales_nav_url: snLink    ? snLink.href.split("?")[0]    : "",
      });
    } catch (_) {
      // Skip malformed cards silently
    }
  }

  return leads;
}


// ── Page metadata ────────────────────────────────────────────────────────

function getPageInfo() {
  const totalEl = document.querySelector(SEL.totalResults);
  const totalText = totalEl ? totalEl.textContent.trim() : "";
  const totalMatch = totalText.match(/([\d,]+)/);
  const totalResults = totalMatch ? parseInt(totalMatch[1].replace(/,/g, ""), 10) : null;

  const activePageBtn = document.querySelector(SEL.currentPage);
  const currentPage = activePageBtn ? parseInt(activePageBtn.textContent.trim(), 10) : 1;

  const nextBtn = document.querySelector(SEL.nextPageBtn);
  const hasNextPage = nextBtn ? !nextBtn.disabled : false;

  return { currentPage, totalResults, hasNextPage };
}


// ── Click Next Page ──────────────────────────────────────────────────────

function clickNextPage() {
  const btn = document.querySelector(SEL.nextPageBtn);
  if (btn && !btn.disabled) {
    btn.click();
    return true;
  }
  return false;
}


// ── Message handler ──────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.action === "SCRAPE_PAGE") {
    // Async handler — we scroll first, then extract
    (async () => {
      try {
        await scrollToLoadAll();
        const leads    = extractLeads();
        const pageInfo = getPageInfo();
        sendResponse({ ok: true, leads, pageInfo });
      } catch (err) {
        sendResponse({ ok: false, error: err.message });
      }
    })();
    return true;  // keep sendResponse channel open for async
  }

  if (msg.action === "GET_PAGE_INFO") {
    sendResponse({ ok: true, pageInfo: getPageInfo() });
    return false;
  }

  if (msg.action === "CLICK_NEXT_PAGE") {
    const clicked = clickNextPage();
    sendResponse({ ok: clicked });
    return false;
  }

  if (msg.action === "PING") {
    sendResponse({ ok: true });
    return false;
  }
});


// ── Notify background that the content script is ready ───────────────────

chrome.runtime.sendMessage({ action: "CONTENT_SCRIPT_READY" });
