/**
 * Apollo API Module
 * =================
 * Wraps all Apollo.io REST calls used by the pipeline:
 *   - People enrichment  (POST /v1/people/match)
 *   - Contact search      (POST /v1/contacts/search)   – dedup check
 *   - Contact creation    (POST /v1/contacts)
 *   - Sequence add        (POST /v1/emailer_campaigns/{id}/add_contact_ids)
 *
 * All calls include retry logic with exponential back-off on 429 / 5xx.
 */

const BASE = "https://api.apollo.io/api/v1";
const MAX_RETRIES = 3;
const RETRY_BACKOFF_MS = 5000;


// ── Helpers ──────────────────────────────────────────────────────────────

function headers(apiKey) {
  return {
    "Content-Type": "application/json",
    "Cache-Control": "no-cache",
    "x-api-key": apiKey,
  };
}

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * POST with automatic retry on 429 / 5xx / network errors.
 * Returns { ok, status, data } or { ok: false, error }.
 */
async function postWithRetry(url, payload, apiKey) {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const resp = await fetch(url, {
        method: "POST",
        headers: headers(apiKey),
        body: JSON.stringify(payload),
      });

      if (resp.ok) {
        const data = await resp.json();
        return { ok: true, status: resp.status, data };
      }

      if (resp.status === 429 || resp.status >= 500) {
        const wait = RETRY_BACKOFF_MS * attempt;
        console.warn(
          `[Apollo] HTTP ${resp.status} on ${url} — retry ${attempt}/${MAX_RETRIES} in ${wait}ms`
        );
        await sleep(wait);
        continue;
      }

      // Non-retryable client error
      const text = await resp.text().catch(() => "");
      return { ok: false, status: resp.status, error: text.slice(0, 300) };

    } catch (err) {
      console.warn(`[Apollo] Network error (attempt ${attempt}): ${err.message}`);
      await sleep(RETRY_BACKOFF_MS * attempt);
    }
  }

  return { ok: false, status: 0, error: "All retries exhausted" };
}


// ── Public API ───────────────────────────────────────────────────────────

/**
 * Enrich a single lead via Apollo People Match.
 * Returns parsed enrichment object or null on failure.
 */
export async function enrichLead(lead, apiKey) {
  const payload = {
    reveal_personal_emails: false,
    reveal_phone_number: true,
  };

  if (lead.linkedin_url) payload.linkedin_url = lead.linkedin_url;

  const fullName = lead.full_name || "";
  const parts = fullName.split(/\s+/);
  if (parts.length >= 1) payload.first_name = parts[0];
  if (parts.length >= 2) payload.last_name = parts.slice(1).join(" ");

  if (lead.company_name) payload.organization_name = lead.company_name;

  const result = await postWithRetry(`${BASE}/people/match`, payload, apiKey);

  if (!result.ok) {
    console.error(`[Apollo] Enrichment failed for ${lead.full_name}: ${result.error}`);
    return null;
  }

  const person = result.data.person || {};
  const phones = person.phone_numbers || [];

  return {
    work_email: person.email || "",
    email_status: person.email_status || "",
    phone_number: phones.length > 0 ? (phones[0].sanitized_number || "") : "",
    apollo_id: person.id || "",
  };
}


/**
 * Check if a contact with this email already exists in Apollo.
 */
export async function contactExists(email, apiKey) {
  if (!email) return false;

  const result = await postWithRetry(
    `${BASE}/contacts/search`,
    { q_keywords: email, page: 1, per_page: 1 },
    apiKey
  );

  if (!result.ok) return false;

  const contacts = result.data.contacts || [];
  return contacts.length > 0;
}


/**
 * Create a new contact in Apollo.
 * Returns the new contact ID or null.
 */
export async function createContact(lead, apiKey, labels) {
  const fullName = lead.full_name || "";
  const parts = fullName.split(/\s+/);

  const payload = {
    first_name: parts[0] || "",
    last_name: parts.slice(1).join(" ") || "",
    title: lead.job_title || "",
    organization_name: lead.company_name || "",
    email: lead.work_email || "",
    direct_phone: lead.phone_number || "",
    label_names: labels,
    website_url: lead.linkedin_url || "",
  };

  const result = await postWithRetry(`${BASE}/contacts`, payload, apiKey);

  if (!result.ok) {
    console.error(`[Apollo] Contact creation failed for ${lead.full_name}: ${result.error}`);
    return null;
  }

  const contact = result.data.contact || {};
  return contact.id || null;
}


/**
 * Add an array of contact IDs to an Apollo sequence.
 * Returns true on success.
 */
export async function addToSequence(contactIds, sequenceId, apiKey) {
  if (!contactIds.length || !sequenceId) return true;

  const url = `${BASE}/emailer_campaigns/${sequenceId}/add_contact_ids`;
  const payload = {
    contact_ids: contactIds,
    emailer_campaign_id: sequenceId,
    sequence_active_in_other_campaigns: false,
    sequence_finished_in_other_campaigns: false,
  };

  const result = await postWithRetry(url, payload, apiKey);

  if (!result.ok) {
    console.error(`[Apollo] Failed to add contacts to sequence: ${result.error}`);
    return false;
  }

  return true;
}
