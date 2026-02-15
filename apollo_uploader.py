"""
Apollo CRM Uploader
===================
Reads leads_enriched.json, deduplicates against existing Apollo contacts,
creates new contacts with tags, and adds them to a specified sequence.

Apollo API references:
  Search Contacts:         POST https://api.apollo.io/api/v1/contacts/search
  Create Contact:          POST https://api.apollo.io/api/v1/contacts
  Add to Sequence:         POST https://api.apollo.io/api/v1/emailer_campaigns/{id}/add_contact_ids
  Docs: https://docs.apollo.io/reference/create-a-contact
        https://docs.apollo.io/reference/add-contacts-to-sequence
"""

import json
import logging
import time
from datetime import datetime
from pathlib import Path

import requests

# ---------------------------------------------------------------------------
# Logging — both console and file
# ---------------------------------------------------------------------------
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
)
logger = logging.getLogger(__name__)

# Also log to upload_log.txt
file_handler = logging.FileHandler("upload_log.txt", mode="a")
file_handler.setFormatter(logging.Formatter("%(asctime)s [%(levelname)s] %(message)s"))
logger.addHandler(file_handler)

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------
APOLLO_BASE = "https://api.apollo.io/api/v1"
CONTACTS_SEARCH_URL = f"{APOLLO_BASE}/contacts/search"
CONTACTS_CREATE_URL = f"{APOLLO_BASE}/contacts"
SEQUENCE_ADD_URL_TEMPLATE = f"{APOLLO_BASE}/emailer_campaigns/{{sequence_id}}/add_contact_ids"

DELAY_BETWEEN_CALLS = 1.0  # seconds
MAX_RETRIES = 3
RETRY_BACKOFF = 5  # seconds


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def load_config(path: str = "config.json") -> dict:
    with open(path, "r") as fh:
        return json.load(fh)


def load_enriched_leads(path: str = "leads_enriched.json") -> list[dict]:
    p = Path(path)
    if not p.exists():
        raise FileNotFoundError(f"{path} not found. Run apollo_enricher.py first.")
    with open(p, "r") as fh:
        return json.load(fh)


def _api_headers(api_key: str) -> dict:
    return {
        "Content-Type": "application/json",
        "Cache-Control": "no-cache",
        "x-api-key": api_key,
    }


def _post_with_retry(url: str, payload: dict, headers: dict) -> requests.Response | None:
    """POST with exponential backoff on 429 / 5xx."""
    for attempt in range(1, MAX_RETRIES + 1):
        try:
            resp = requests.post(url, json=payload, headers=headers, timeout=30)

            if resp.status_code in (200, 201):
                return resp

            if resp.status_code == 429 or resp.status_code >= 500:
                wait = RETRY_BACKOFF * attempt
                logger.warning(
                    "HTTP %d on %s — retrying in %ds (%d/%d)",
                    resp.status_code, url, wait, attempt, MAX_RETRIES,
                )
                time.sleep(wait)
                continue

            # Non-retryable client error
            logger.error("HTTP %d on %s — %s", resp.status_code, url, resp.text[:300])
            return resp

        except requests.RequestException as exc:
            logger.warning("Network error (attempt %d): %s", attempt, exc)
            time.sleep(RETRY_BACKOFF * attempt)

    logger.error("All retries exhausted for %s", url)
    return None


# ---------------------------------------------------------------------------
# ICP tier classification
# ---------------------------------------------------------------------------

def classify_icp_tier(job_title: str, elite_keywords: list[str], high_keywords: list[str]) -> str:
    """
    Classify a lead as ELITE or HIGH based on job title keywords.
    Falls back to HIGH if no ELITE match is found.
    """
    title_lower = job_title.lower()

    for kw in elite_keywords:
        if kw.lower() in title_lower:
            return "ELITE"

    for kw in high_keywords:
        if kw.lower() in title_lower:
            return "HIGH"

    # Default to HIGH for any lead that made it through the Sales Nav search
    return "HIGH"


# ---------------------------------------------------------------------------
# Duplicate check
# ---------------------------------------------------------------------------

def contact_exists(email: str, api_key: str) -> bool:
    """
    Search Apollo contacts by email to detect duplicates.
    Returns True if a contact with this email already exists.
    """
    if not email:
        return False

    headers = _api_headers(api_key)
    payload = {
        "q_keywords": email,
        "page": 1,
        "per_page": 1,
    }

    resp = _post_with_retry(CONTACTS_SEARCH_URL, payload, headers)
    if resp is None or resp.status_code != 200:
        # If search fails, err on the side of caution and skip
        logger.warning("Contact search failed for %s — treating as non-duplicate.", email)
        return False

    data = resp.json()
    contacts = data.get("contacts") or []
    return len(contacts) > 0


# ---------------------------------------------------------------------------
# Contact creation
# ---------------------------------------------------------------------------

def create_contact(lead: dict, api_key: str, labels: list[str]) -> str | None:
    """
    Create a new contact in Apollo.  Returns the new contact ID or None.
    """
    headers = _api_headers(api_key)

    full_name = lead.get("full_name", "")
    parts = full_name.split(None, 1)
    first_name = parts[0] if parts else ""
    last_name = parts[1] if len(parts) > 1 else ""

    payload = {
        "first_name": first_name,
        "last_name": last_name,
        "title": lead.get("job_title", ""),
        "organization_name": lead.get("company_name", ""),
        "email": lead.get("work_email", ""),
        "direct_phone": lead.get("phone_number", ""),
        "label_names": labels,
        "website_url": lead.get("linkedin_url", ""),
    }

    resp = _post_with_retry(CONTACTS_CREATE_URL, payload, headers)

    if resp is None:
        return None

    if resp.status_code in (200, 201):
        contact = resp.json().get("contact") or {}
        contact_id = contact.get("id")
        logger.info("Created contact %s %s → %s", first_name, last_name, contact_id)
        return contact_id

    logger.error(
        "Failed to create contact %s %s: HTTP %d",
        first_name, last_name, resp.status_code,
    )
    return None


# ---------------------------------------------------------------------------
# Add contacts to sequence
# ---------------------------------------------------------------------------

def add_to_sequence(contact_ids: list[str], sequence_id: str, api_key: str) -> bool:
    """
    Add a batch of contact IDs to an Apollo sequence.
    Returns True on success.
    Note: This endpoint requires a master API key.
    """
    if not contact_ids:
        logger.info("No contacts to add to sequence.")
        return True

    headers = _api_headers(api_key)
    url = SEQUENCE_ADD_URL_TEMPLATE.format(sequence_id=sequence_id)
    payload = {
        "contact_ids": contact_ids,
        "emailer_campaign_id": sequence_id,
        "sequence_active_in_other_campaigns": False,
        "sequence_finished_in_other_campaigns": False,
    }

    resp = _post_with_retry(url, payload, headers)

    if resp and resp.status_code in (200, 201):
        logger.info("Added %d contacts to sequence %s.", len(contact_ids), sequence_id)
        return True

    logger.error("Failed to add contacts to sequence %s.", sequence_id)
    return False


# ---------------------------------------------------------------------------
# Main entry point
# ---------------------------------------------------------------------------

def run(config: dict | None = None) -> dict:
    """
    Upload enriched leads to Apollo.
    Returns a summary dict with counts of uploaded, skipped, and failed leads.
    """
    if config is None:
        config = load_config()

    api_key = config["apollo_api_key"]
    sequence_id = config.get("apollo_sequence_id", "")
    elite_keywords = config.get("icp_elite_keywords", ["CEO", "CTO", "CFO", "Founder", "Owner"])
    high_keywords = config.get("icp_high_keywords", ["VP", "Director", "Head of", "Manager"])

    leads = load_enriched_leads()
    logger.info("Loaded %d enriched leads for upload.", len(leads))

    uploaded_ids: list[str] = []
    skipped = 0
    failed = 0

    timestamp = datetime.now().strftime("%Y-%m-%d")

    for idx, lead in enumerate(leads, start=1):
        email = lead.get("work_email", "")
        name = lead.get("full_name", "")

        logger.info("[%d/%d] Processing: %s (%s)", idx, len(leads), name, email)

        # Deduplicate — check if contact already exists
        if contact_exists(email, api_key):
            logger.info("Skipping %s — already exists in Apollo.", name)
            skipped += 1
            continue

        # Classify ICP tier
        tier = classify_icp_tier(lead.get("job_title", ""), elite_keywords, high_keywords)

        # Tags: campaign source + ICP tier
        labels = [
            "Sales_Nav_Auto",
            f"ICP_{tier}",
            f"imported_{timestamp}",
        ]

        # Create the contact
        contact_id = create_contact(lead, api_key, labels)

        if contact_id:
            uploaded_ids.append(contact_id)
        else:
            failed += 1

        time.sleep(DELAY_BETWEEN_CALLS)

    # Add all newly created contacts to the sequence
    if sequence_id and uploaded_ids:
        # Batch in groups of 50 to stay within limits
        batch_size = 50
        for i in range(0, len(uploaded_ids), batch_size):
            batch = uploaded_ids[i : i + batch_size]
            add_to_sequence(batch, sequence_id, api_key)
            time.sleep(DELAY_BETWEEN_CALLS)

    summary = {
        "total_leads": len(leads),
        "uploaded": len(uploaded_ids),
        "skipped_duplicates": skipped,
        "failed": failed,
    }

    logger.info("Upload summary: %s", json.dumps(summary, indent=2))
    return summary


if __name__ == "__main__":
    run()
