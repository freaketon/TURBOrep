/**
 * Popup Script
 * ============
 * Drives the extension popup UI.
 * Communicates with background.js via chrome.runtime messages + port.
 */

// ── DOM refs ─────────────────────────────────────────────────────────────

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

const els = {
  // Tabs
  tabs:            $$(".tab"),
  tabContents:     $$(".tab-content"),

  // Dashboard
  activeSearch:    $("#active-search"),
  progressSection: $("#progress-section"),
  batchProgress:   $("#batch-progress"),
  progressText:    $("#progress-text"),
  lastRunText:     $("#last-run-text"),
  batchSizeInput:  $("#batch-size-input"),
  btnStart:        $("#btn-start"),
  btnStop:         $("#btn-stop"),
  statusBadge:     $("#status-badge"),
  logOutput:       $("#log-output"),

  // Stats
  statProcessed:   $("#stat-processed"),
  statQualified:   $("#stat-qualified"),
  statEnriched:    $("#stat-enriched"),
  statUploaded:    $("#stat-uploaded"),
  statSkipped:     $("#stat-skipped"),
  statFailed:      $("#stat-failed"),

  // Searches
  newSearchName:   $("#new-search-name"),
  newSearchUrl:    $("#new-search-url"),
  btnAddSearch:    $("#btn-add-search"),
  searchesList:    $("#searches-list"),

  // Settings
  setApiKey:       $("#set-api-key"),
  setSequenceId:   $("#set-sequence-id"),
  setDelay:        $("#set-delay"),
  icpPrimaryIncl:  $("#icp-primary-include"),
  icpPrimaryExcl:  $("#icp-primary-exclude"),
  icpSecondaryIncl:$("#icp-secondary-include"),
  icpSecondaryExcl:$("#icp-secondary-exclude"),
  icpGlobalExcl:   $("#icp-global-exclude"),
  btnSaveSettings: $("#btn-save-settings"),
  settingsSavedMsg:$("#settings-saved-msg"),
};


// ── Port connection for real-time updates ────────────────────────────────

const port = chrome.runtime.connect({ name: "popup" });

port.onMessage.addListener((msg) => {
  if (msg.type === "STATE") updateDashboardState(msg.state);
  if (msg.type === "LOG")   appendLogEntry(msg.entry);
});


// ── Tab switching ────────────────────────────────────────────────────────

els.tabs.forEach((btn) => {
  btn.addEventListener("click", () => {
    els.tabs.forEach((t) => t.classList.remove("active"));
    els.tabContents.forEach((c) => c.classList.remove("active"));
    btn.classList.add("active");
    $(`#${btn.dataset.tab}`).classList.add("active");
  });
});


// ══════════════════════════════════════════════════════════════════════════
// ██  DASHBOARD
// ══════════════════════════════════════════════════════════════════════════

function updateDashboardState(state) {
  // Status badge
  els.statusBadge.textContent = state.status.toUpperCase();
  els.statusBadge.className = "status-badge " + state.status;

  // Buttons
  if (state.status === "running" || state.status === "stopping") {
    els.btnStart.classList.add("hidden");
    els.btnStop.classList.remove("hidden");
  } else {
    els.btnStart.classList.remove("hidden");
    els.btnStop.classList.add("hidden");
  }

  // Progress
  const pct = state.batchTarget > 0
    ? Math.round((state.batchProcessed / state.batchTarget) * 100)
    : 0;
  els.batchProgress.style.width = pct + "%";
  els.progressText.textContent = `${state.batchProcessed} / ${state.batchTarget} leads (this batch)`;

  // Render log
  if (state.log) {
    els.logOutput.innerHTML = "";
    state.log.forEach((e) => appendLogEntry(e));
  }
}

function appendLogEntry(entry) {
  const div = document.createElement("div");
  div.className = `log-line ${entry.level}`;
  const time = entry.time ? entry.time.slice(11, 19) : "";
  div.textContent = `${time}  ${entry.message}`;
  els.logOutput.appendChild(div);
  els.logOutput.scrollTop = els.logOutput.scrollHeight;
}


// ── Search selector ──────────────────────────────────────────────────────

async function loadSearchSelector() {
  const resp = await msg("GET_SEARCHES");
  const searches = resp.searches || {};

  els.activeSearch.innerHTML = '<option value="">— select a saved search —</option>';
  for (const [id, s] of Object.entries(searches)) {
    const opt = document.createElement("option");
    opt.value = id;
    opt.textContent = s.name;
    els.activeSearch.appendChild(opt);
  }
}

els.activeSearch.addEventListener("change", () => {
  loadSelectedSearchStats();
});

async function loadSelectedSearchStats() {
  const searchId = els.activeSearch.value;
  if (!searchId) {
    els.progressSection.classList.add("hidden");
    return;
  }

  const resp = await msg("GET_SEARCHES");
  const search = (resp.searches || {})[searchId];
  if (!search) return;

  els.progressSection.classList.remove("hidden");

  const s = search.state;
  const qualified = (s.total_enriched || 0) + (s.total_skipped_duplicate || 0) + (s.total_uploaded || 0);

  els.statProcessed.textContent  = s.total_processed || 0;
  els.statQualified.textContent  = qualified;
  els.statEnriched.textContent   = s.total_enriched || 0;
  els.statUploaded.textContent   = s.total_uploaded || 0;
  els.statSkipped.textContent    = (s.total_skipped_icp || 0) + (s.total_skipped_duplicate || 0);
  els.statFailed.textContent     = s.total_failed || 0;

  if (s.last_run) {
    const d = new Date(s.last_run);
    els.lastRunText.textContent = `Last run: ${d.toLocaleDateString()} ${d.toLocaleTimeString()}`;
  } else {
    els.lastRunText.textContent = "Never run";
  }
}


// ── Start / Stop ─────────────────────────────────────────────────────────

els.btnStart.addEventListener("click", async () => {
  const searchId = els.activeSearch.value;
  if (!searchId) { alert("Select a saved search first."); return; }

  // Update batch size in settings
  const settingsResp = await msg("GET_SETTINGS");
  const settings = settingsResp.settings;
  settings.batch_size = parseInt(els.batchSizeInput.value, 10) || 25;
  await msg("SAVE_SETTINGS", { settings });

  await msg("START_BATCH", { searchId });
});

els.btnStop.addEventListener("click", () => {
  msg("STOP_BATCH");
});


// ══════════════════════════════════════════════════════════════════════════
// ██  SEARCHES TAB
// ══════════════════════════════════════════════════════════════════════════

els.btnAddSearch.addEventListener("click", async () => {
  const name = els.newSearchName.value.trim();
  const url  = els.newSearchUrl.value.trim();

  if (!name || !url) { alert("Name and URL are required."); return; }
  if (!url.includes("linkedin.com/sales/search")) {
    alert("URL must be a LinkedIn Sales Navigator search URL."); return;
  }

  await msg("ADD_SEARCH", { name, url });
  els.newSearchName.value = "";
  els.newSearchUrl.value = "";
  loadSearchesList();
  loadSearchSelector();
});

async function loadSearchesList() {
  const resp = await msg("GET_SEARCHES");
  const searches = resp.searches || {};

  els.searchesList.innerHTML = "";

  if (Object.keys(searches).length === 0) {
    els.searchesList.innerHTML = '<p class="muted">No saved searches yet.</p>';
    return;
  }

  for (const [id, s] of Object.entries(searches)) {
    const st = s.state;
    const card = document.createElement("div");
    card.className = "search-card";
    card.innerHTML = `
      <div class="search-card-header">
        <span class="search-card-name">${esc(s.name)}</span>
      </div>
      <div class="search-card-stats">
        Page ${st.last_page} &middot;
        ${st.total_processed} processed &middot;
        ${st.total_uploaded} uploaded &middot;
        ${st.total_skipped_icp + st.total_skipped_duplicate} skipped
        ${st.last_run ? "<br>Last run: " + new Date(st.last_run).toLocaleDateString() : ""}
      </div>
      <div class="search-card-actions">
        <button class="btn ghost" data-reset="${id}">Reset progress</button>
        <button class="btn ghost" data-remove="${id}" style="color:#ef4444">Remove</button>
      </div>
    `;
    els.searchesList.appendChild(card);
  }

  // Bind actions
  els.searchesList.querySelectorAll("[data-reset]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      if (!confirm("Reset all progress for this search?")) return;
      await msg("RESET_SEARCH", { searchId: btn.dataset.reset });
      loadSearchesList();
      loadSearchSelector();
      loadSelectedSearchStats();
    });
  });

  els.searchesList.querySelectorAll("[data-remove]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      if (!confirm("Remove this search and all its data?")) return;
      await msg("REMOVE_SEARCH", { searchId: btn.dataset.remove });
      loadSearchesList();
      loadSearchSelector();
    });
  });
}


// ══════════════════════════════════════════════════════════════════════════
// ██  SETTINGS TAB
// ══════════════════════════════════════════════════════════════════════════

async function loadSettings() {
  const resp = await msg("GET_SETTINGS");
  const s = resp.settings;

  els.setApiKey.value      = s.apollo_api_key || "";
  els.setSequenceId.value  = s.apollo_sequence_id || "";
  els.setDelay.value       = (s.delay_between_leads || 3000) / 1000;

  const icp = s.icp_config || {};
  const pri = icp.primary || {};
  const sec = icp.secondary || {};

  els.icpPrimaryIncl.value   = (pri.title_include || []).join(", ");
  els.icpPrimaryExcl.value   = (pri.title_exclude || []).join(", ");
  els.icpSecondaryIncl.value = (sec.title_include || []).join(", ");
  els.icpSecondaryExcl.value = (sec.title_exclude || []).join(", ");
  els.icpGlobalExcl.value    = (icp.global_exclude || []).join(", ");
}

function csvToArray(str) {
  return str.split(",").map((s) => s.trim()).filter(Boolean);
}

els.btnSaveSettings.addEventListener("click", async () => {
  const settings = {
    apollo_api_key:      els.setApiKey.value.trim(),
    apollo_sequence_id:  els.setSequenceId.value.trim(),
    batch_size:          parseInt(els.batchSizeInput.value, 10) || 25,
    delay_between_leads: (parseFloat(els.setDelay.value) || 3) * 1000,
    icp_config: {
      primary: {
        description: "Primary ICP",
        title_include:   csvToArray(els.icpPrimaryIncl.value),
        title_exclude:   csvToArray(els.icpPrimaryExcl.value),
        company_include: [],
        company_exclude: [],
      },
      secondary: {
        description: "Secondary ICP",
        title_include:   csvToArray(els.icpSecondaryIncl.value),
        title_exclude:   csvToArray(els.icpSecondaryExcl.value),
        company_include: [],
        company_exclude: [],
      },
      global_exclude: csvToArray(els.icpGlobalExcl.value),
    },
  };

  await msg("SAVE_SETTINGS", { settings });
  els.settingsSavedMsg.textContent = "Saved!";
  setTimeout(() => { els.settingsSavedMsg.textContent = ""; }, 2000);
});


// ── Messaging helper ─────────────────────────────────────────────────────

function msg(action, extra = {}) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ action, ...extra }, (resp) => {
      resolve(resp || {});
    });
  });
}


// ── Escaping ─────────────────────────────────────────────────────────────

function esc(str) {
  const d = document.createElement("div");
  d.textContent = str;
  return d.innerHTML;
}


// ── Initialise ───────────────────────────────────────────────────────────

(async function init() {
  await loadSettings();
  await loadSearchSelector();
  await loadSearchesList();

  // Get current state from background
  const status = await msg("GET_STATUS");
  if (status.state) updateDashboardState(status.state);
})();
