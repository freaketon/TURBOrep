/**
 * Background Service Worker
 * =========================
 * Orchestrates the full pipeline:
 *   1. Open a Sales Nav tab at the correct page offset
 *   2. Tell content script to scroll + scrape
 *   3. Filter out already-processed leads
 *   4. ICP-qualify each lead (PRIMARY / SECONDARY / skip)
 *   5. Enrich qualified leads via Apollo
 *   6. Dedup-check + create contacts in Apollo
 *   7. Add new contacts to Apollo sequence
 *   8. Persist progress so daily batches resume correctly
 *
 * State lives in chrome.storage.local.
 */

import { qualifyLead, DEFAULT_ICP_CONFIG } from "./icp_qualifier.js";
import {
  enrichLead,
  contactExists,
  createContact,
  addToSequence,
} from "./apollo_api.js";


// ── Constants ────────────────────────────────────────────────────────────

const DELAY_BETWEEN_LEADS_MS = 3000;   // default; configurable via settings
const SEQUENCE_BATCH_SIZE    = 50;

// ── Runtime state (in-memory, not persisted) ─────────────────────────────

let runState = {
  status: "idle",           // idle | running | stopping
  searchId: null,
  tabId: null,
  batchProcessed: 0,
  batchTarget: 25,
  log: [],                  // recent log entries for the popup
};

let popupPort = null;       // port connection to popup (if open)


// ── Logging helper ───────────────────────────────────────────────────────

function log(level, message) {
  const entry = {
    time: new Date().toISOString(),
    level,
    message,
  };
  runState.log.push(entry);
  if (runState.log.length > 200) runState.log.splice(0, 50); // trim old
  console.log(`[TURBOrep][${level}] ${message}`);
  notifyPopup({ type: "LOG", entry });
}


// ── Popup communication ──────────────────────────────────────────────────

chrome.runtime.onConnect.addListener((port) => {
  if (port.name === "popup") {
    popupPort = port;
    port.onDisconnect.addListener(() => { popupPort = null; });

    // Send current state immediately
    port.postMessage({ type: "STATE", state: sanitizeState() });
  }
});

function notifyPopup(data) {
  if (popupPort) {
    try { popupPort.postMessage(data); } catch (_) { popupPort = null; }
  }
}

function sanitizeState() {
  return {
    status: runState.status,
    searchId: runState.searchId,
    batchProcessed: runState.batchProcessed,
    batchTarget: runState.batchTarget,
    log: runState.log.slice(-50),
  };
}


// ── Storage helpers ──────────────────────────────────────────────────────

async function getSettings() {
  const result = await chrome.storage.local.get("settings");
  return result.settings || {
    apollo_api_key: "",
    apollo_sequence_id: "",
    batch_size: 25,
    delay_between_leads: 3000,
    icp_config: DEFAULT_ICP_CONFIG,
  };
}

async function saveSettings(settings) {
  await chrome.storage.local.set({ settings });
}

async function getSearches() {
  const result = await chrome.storage.local.get("searches");
  return result.searches || {};
}

async function saveSearches(searches) {
  await chrome.storage.local.set({ searches });
}

async function getSearchState(searchId) {
  const searches = await getSearches();
  return searches[searchId] || null;
}

async function updateSearchState(searchId, updates) {
  const searches = await getSearches();
  if (searches[searchId]) {
    searches[searchId].state = { ...searches[searchId].state, ...updates };
    await saveSearches(searches);
  }
}


// ── Sleep / delay ────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}


// ── Content-script communication ─────────────────────────────────────────

function sendToTab(tabId, message) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, message, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve(response);
      }
    });
  });
}

/**
 * Wait for the content script on a tab to become responsive.
 * After navigation, the old content script dies and a new one
 * is injected.  We poll with PING until we get a response.
 */
async function waitForContentScript(tabId, timeoutMs = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const resp = await sendToTab(tabId, { action: "PING" });
      if (resp && resp.ok) return true;
    } catch (_) {
      // not ready yet
    }
    await sleep(1000);
  }
  return false;
}

/**
 * Wait for tab to finish loading after navigation.
 */
function waitForTabLoad(tabId) {
  return new Promise((resolve) => {
    function listener(updatedTabId, changeInfo) {
      if (updatedTabId === tabId && changeInfo.status === "complete") {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    }
    chrome.tabs.onUpdated.addListener(listener);
  });
}


// ── Keep-alive alarm (MV3 service workers get killed after 30s idle) ─────

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "keepAlive" && runState.status === "running") {
    // Just existing keeps the worker alive
  }
});

function startKeepAlive() {
  chrome.alarms.create("keepAlive", { periodInMinutes: 0.4 });
}

function stopKeepAlive() {
  chrome.alarms.clear("keepAlive");
}


// ══════════════════════════════════════════════════════════════════════════
// ██  BATCH PROCESSING PIPELINE
// ══════════════════════════════════════════════════════════════════════════

async function runBatch(searchId) {
  if (runState.status === "running") {
    log("warn", "A batch is already running.");
    return;
  }

  const search = await getSearchState(searchId);
  if (!search) {
    log("error", `Search "${searchId}" not found.`);
    return;
  }

  const settings = await getSettings();
  if (!settings.apollo_api_key) {
    log("error", "Apollo API key is not set. Go to Settings.");
    return;
  }

  // ── Initialise run state ───────────────────────────────────────────
  runState.status = "running";
  runState.searchId = searchId;
  runState.batchProcessed = 0;
  runState.batchTarget = settings.batch_size || 25;
  notifyPopup({ type: "STATE", state: sanitizeState() });
  startKeepAlive();

  const apiKey      = settings.apollo_api_key;
  const sequenceId  = settings.apollo_sequence_id;
  const icpConfig   = settings.icp_config || DEFAULT_ICP_CONFIG;
  const delayMs     = settings.delay_between_leads || DELAY_BETWEEN_LEADS_MS;

  const state        = search.state;
  let currentPage    = state.last_page || 1;
  const processedSet = new Set(state.processed_urls || []);

  const newContactIds = [];

  log("info", `Starting batch for "${search.name}" — page ${currentPage}, target ${runState.batchTarget} leads`);

  try {
    // ── Open / reuse a tab ──────────────────────────────────────────
    const searchUrl = search.url;
    const pageUrl   = appendPageParam(searchUrl, currentPage);

    // Open a new tab with the search
    const tab = await chrome.tabs.create({ url: pageUrl, active: false });
    runState.tabId = tab.id;

    // Wait for the page to fully load + content script to be ready
    await waitForTabLoad(tab.id);
    await sleep(3000);  // extra settle time for Sales Nav SPA
    const csReady = await waitForContentScript(tab.id);
    if (!csReady) {
      throw new Error("Content script did not respond — is the page a Sales Nav search?");
    }

    // ── Page loop ───────────────────────────────────────────────────
    while (runState.status === "running" && runState.batchProcessed < runState.batchTarget) {

      log("info", `Scraping page ${currentPage}…`);

      // Ask content script to scroll and extract leads
      const scrapeResult = await sendToTab(tab.id, { action: "SCRAPE_PAGE" });

      if (!scrapeResult || !scrapeResult.ok) {
        log("error", `Scrape failed: ${scrapeResult?.error || "unknown"}`);
        break;
      }

      const { leads, pageInfo } = scrapeResult;
      log("info", `Page ${currentPage}: ${leads.length} cards found`);

      // ── Process each lead ──────────────────────────────────────
      for (const lead of leads) {
        if (runState.status !== "running") break;
        if (runState.batchProcessed >= runState.batchTarget) break;

        // Skip already-processed
        const url = lead.linkedin_url || lead.sales_nav_url || lead.full_name;
        if (processedSet.has(url)) continue;

        // ── ICP Qualification ────────────────────────────────────
        const icpResult = qualifyLead(lead, icpConfig);
        processedSet.add(url);

        if (!icpResult.qualified) {
          log("info", `SKIP (ICP) ${lead.full_name} — ${icpResult.reason}`);
          await updateProgress(searchId, processedSet, currentPage, { skipped_icp: 1 });
          continue;
        }

        log("info", `✓ ${icpResult.tier}: ${lead.full_name} (${lead.job_title})`);

        // ── Apollo Enrichment ────────────────────────────────────
        const enrichment = await enrichLead(lead, apiKey);
        await sleep(delayMs);

        if (!enrichment) {
          log("warn", `Enrichment failed for ${lead.full_name}`);
          await updateProgress(searchId, processedSet, currentPage, { failed: 1 });
          runState.batchProcessed++;
          notifyPopup({ type: "STATE", state: sanitizeState() });
          continue;
        }

        const enrichedLead = { ...lead, ...enrichment };
        await updateProgress(searchId, processedSet, currentPage, { enriched: 1 });

        log("info", `Enriched: ${lead.full_name} → ${enrichment.work_email || "no email"}`);

        // ── Dedup check in Apollo ────────────────────────────────
        if (enrichment.work_email) {
          const exists = await contactExists(enrichment.work_email, apiKey);
          await sleep(1000);

          if (exists) {
            log("info", `SKIP (duplicate) ${lead.full_name} — already in Apollo`);
            await updateProgress(searchId, processedSet, currentPage, { skipped_duplicate: 1 });
            runState.batchProcessed++;
            notifyPopup({ type: "STATE", state: sanitizeState() });
            continue;
          }
        }

        // ── Create contact in Apollo ─────────────────────────────
        const today = new Date().toISOString().slice(0, 10);
        const labels = [
          "Sales_Nav_Auto",
          `ICP_${icpResult.tier}`,
          `imported_${today}`,
        ];

        const contactId = await createContact(enrichedLead, apiKey, labels);
        await sleep(1000);

        if (contactId) {
          newContactIds.push(contactId);
          log("info", `Created contact: ${lead.full_name} → ${contactId}`);
          await updateProgress(searchId, processedSet, currentPage, { uploaded: 1 });
        } else {
          log("warn", `Contact creation failed for ${lead.full_name}`);
          await updateProgress(searchId, processedSet, currentPage, { failed: 1 });
        }

        runState.batchProcessed++;
        notifyPopup({ type: "STATE", state: sanitizeState() });
      }

      // ── Advance to next page ──────────────────────────────────
      if (runState.batchProcessed >= runState.batchTarget) break;
      if (!pageInfo.hasNextPage) {
        log("info", "No more pages — search exhausted.");
        break;
      }

      currentPage++;
      log("info", `Navigating to page ${currentPage}…`);

      const nextUrl = appendPageParam(searchUrl, currentPage);
      await chrome.tabs.update(tab.id, { url: nextUrl });
      await waitForTabLoad(tab.id);
      await sleep(3000);
      const ready = await waitForContentScript(tab.id);
      if (!ready) {
        log("error", "Content script lost after page navigation.");
        break;
      }
    }

    // ── Add new contacts to sequence ────────────────────────────────
    if (sequenceId && newContactIds.length > 0) {
      log("info", `Adding ${newContactIds.length} contacts to sequence…`);
      for (let i = 0; i < newContactIds.length; i += SEQUENCE_BATCH_SIZE) {
        const batch = newContactIds.slice(i, i + SEQUENCE_BATCH_SIZE);
        await addToSequence(batch, sequenceId, apiKey);
        await sleep(1000);
      }
      log("info", "Sequence enrollment complete.");
    }

    // ── Save final state ────────────────────────────────────────────
    await updateProgress(searchId, processedSet, currentPage, {});
    await updateSearchState(searchId, {
      last_run: new Date().toISOString(),
    });

    log("info", `Batch complete — processed ${runState.batchProcessed} leads.`);

  } catch (err) {
    log("error", `Batch error: ${err.message}`);
  } finally {
    runState.status = "idle";
    runState.tabId = null;
    stopKeepAlive();
    notifyPopup({ type: "STATE", state: sanitizeState() });
  }
}


// ── Progress persistence ─────────────────────────────────────────────────

async function updateProgress(searchId, processedSet, currentPage, deltas) {
  const searches = await getSearches();
  const search = searches[searchId];
  if (!search) return;

  const s = search.state;
  s.last_page      = currentPage;
  s.processed_urls = [...processedSet];
  s.total_processed = processedSet.size;

  if (deltas.skipped_icp)       s.total_skipped_icp       = (s.total_skipped_icp || 0) + deltas.skipped_icp;
  if (deltas.enriched)          s.total_enriched           = (s.total_enriched || 0) + deltas.enriched;
  if (deltas.skipped_duplicate) s.total_skipped_duplicate  = (s.total_skipped_duplicate || 0) + deltas.skipped_duplicate;
  if (deltas.uploaded)          s.total_uploaded            = (s.total_uploaded || 0) + deltas.uploaded;
  if (deltas.failed)            s.total_failed              = (s.total_failed || 0) + deltas.failed;

  await saveSearches(searches);
}


// ── URL helpers ──────────────────────────────────────────────────────────

function appendPageParam(url, page) {
  const u = new URL(url);
  u.searchParams.set("page", String(page));
  return u.toString();
}


// ══════════════════════════════════════════════════════════════════════════
// ██  MESSAGE HANDLER (from popup)
// ══════════════════════════════════════════════════════════════════════════

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {

  // ── Batch control ────────────────────────────────────────────────
  if (msg.action === "START_BATCH") {
    runBatch(msg.searchId);       // fire-and-forget (async)
    sendResponse({ ok: true });
    return false;
  }

  if (msg.action === "STOP_BATCH") {
    log("info", "Stop requested by user.");
    runState.status = "stopping";
    notifyPopup({ type: "STATE", state: sanitizeState() });
    sendResponse({ ok: true });
    return false;
  }

  // ── Settings ─────────────────────────────────────────────────────
  if (msg.action === "GET_SETTINGS") {
    getSettings().then((s) => sendResponse({ ok: true, settings: s }));
    return true;
  }

  if (msg.action === "SAVE_SETTINGS") {
    saveSettings(msg.settings).then(() => sendResponse({ ok: true }));
    return true;
  }

  // ── Searches ─────────────────────────────────────────────────────
  if (msg.action === "GET_SEARCHES") {
    getSearches().then((s) => sendResponse({ ok: true, searches: s }));
    return true;
  }

  if (msg.action === "ADD_SEARCH") {
    (async () => {
      const searches = await getSearches();
      const id = "s_" + Date.now();
      searches[id] = {
        name: msg.name,
        url:  msg.url,
        created_at: new Date().toISOString(),
        state: {
          last_page: 1,
          processed_urls: [],
          total_processed: 0,
          total_skipped_icp: 0,
          total_enriched: 0,
          total_skipped_duplicate: 0,
          total_uploaded: 0,
          total_failed: 0,
          last_run: null,
        },
      };
      await saveSearches(searches);
      sendResponse({ ok: true, id });
    })();
    return true;
  }

  if (msg.action === "REMOVE_SEARCH") {
    (async () => {
      const searches = await getSearches();
      delete searches[msg.searchId];
      await saveSearches(searches);
      sendResponse({ ok: true });
    })();
    return true;
  }

  if (msg.action === "RESET_SEARCH") {
    (async () => {
      const searches = await getSearches();
      if (searches[msg.searchId]) {
        searches[msg.searchId].state = {
          last_page: 1,
          processed_urls: [],
          total_processed: 0,
          total_skipped_icp: 0,
          total_enriched: 0,
          total_skipped_duplicate: 0,
          total_uploaded: 0,
          total_failed: 0,
          last_run: null,
        };
        await saveSearches(searches);
      }
      sendResponse({ ok: true });
    })();
    return true;
  }

  // ── Status ───────────────────────────────────────────────────────
  if (msg.action === "GET_STATUS") {
    sendResponse({ ok: true, state: sanitizeState() });
    return false;
  }

  // ── Content script ready signal (informational) ──────────────────
  if (msg.action === "CONTENT_SCRIPT_READY") {
    // No action needed — waitForContentScript polls via PING
    return false;
  }
});
