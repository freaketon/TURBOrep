"""
Apollo Email Enricher
=====================
Reads leads.json produced by the Sales Navigator scraper, calls the
Apollo.io People Enrichment API for each lead, and writes enriched
data to leads_enriched.json.

Apollo API reference:
  POST https://api.apollo.io/api/v1/people/match
  Docs: https://docs.apollo.io/reference/people-enrichment
"""

import json
import logging
import time
from pathlib import Path

import requests

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
)
logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------
APOLLO_ENRICH_URL = "https://api.apollo.io/api/v1/people/match"

# Apollo rate limits vary by plan. Free/Basic plans allow ~50 req/min for
# single enrichment.  We stay conservative with a 1.5s delay between calls.
DEFAULT_DELAY_BETWEEN_CALLS = 1.5  # seconds
MAX_RETRIES = 3
RETRY_BACKOFF = 5  # seconds — base backoff on 429 / 5xx


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def load_config(path: str = "config.json") -> dict:
    with open(path, "r") as fh:
        return json.load(fh)


def load_leads(path: str = "leads.json") -> list[dict]:
    p = Path(path)
    if not p.exists():
        raise FileNotFoundError(f"{path} not found. Run sales_nav_scraper.py first.")
    with open(p, "r") as fh:
        return json.load(fh)


# ---------------------------------------------------------------------------
# Enrichment
# ---------------------------------------------------------------------------

def enrich_lead(lead: dict, api_key: str) -> dict | None:
    """
    Call Apollo People Enrichment API for a single lead.
    Returns the enrichment data dict, or None on failure.
    """
    # Build the request payload.  Apollo matches best when you provide
    # multiple identifiers; we send linkedin_url plus name + company.
    payload: dict = {
        "reveal_personal_emails": False,
        "reveal_phone_number": True,
    }

    # Use the LinkedIn URL as the primary identifier
    linkedin_url = lead.get("linkedin_url", "")
    if linkedin_url:
        payload["linkedin_url"] = linkedin_url

    # Also supply name + org for better matching
    full_name = lead.get("full_name", "")
    if full_name:
        parts = full_name.split(None, 1)
        payload["first_name"] = parts[0]
        if len(parts) > 1:
            payload["last_name"] = parts[1]

    company = lead.get("company_name", "")
    if company:
        payload["organization_name"] = company

    headers = {
        "Content-Type": "application/json",
        "Cache-Control": "no-cache",
        "x-api-key": api_key,
    }

    for attempt in range(1, MAX_RETRIES + 1):
        try:
            resp = requests.post(
                APOLLO_ENRICH_URL,
                json=payload,
                headers=headers,
                timeout=30,
            )

            if resp.status_code == 200:
                return resp.json()

            if resp.status_code == 429:
                # Rate limited — back off and retry
                wait = RETRY_BACKOFF * attempt
                logger.warning(
                    "Rate limited (429). Waiting %ds before retry %d/%d …",
                    wait, attempt, MAX_RETRIES,
                )
                time.sleep(wait)
                continue

            if resp.status_code >= 500:
                wait = RETRY_BACKOFF * attempt
                logger.warning(
                    "Server error %d. Waiting %ds before retry %d/%d …",
                    resp.status_code, wait, attempt, MAX_RETRIES,
                )
                time.sleep(wait)
                continue

            # 4xx (not 429) — non-retryable
            logger.error(
                "Enrichment failed for %s: HTTP %d — %s",
                lead.get("full_name"), resp.status_code, resp.text[:300],
            )
            return None

        except requests.RequestException as exc:
            logger.warning("Network error on attempt %d: %s", attempt, exc)
            time.sleep(RETRY_BACKOFF * attempt)

    logger.error("All retries exhausted for %s.", lead.get("full_name"))
    return None


def parse_enrichment(raw: dict) -> dict:
    """
    Extract the fields we care about from Apollo's enrichment response.
    """
    person = raw.get("person") or {}

    email = person.get("email") or ""
    email_status = person.get("email_status") or ""

    # Phone numbers are in an array under person.phone_numbers
    phone_numbers = person.get("phone_numbers") or []
    phone = phone_numbers[0].get("sanitized_number", "") if phone_numbers else ""

    return {
        "work_email": email,
        "email_status": email_status,  # e.g. "verified", "unverified", "guessed"
        "phone_number": phone,
        "apollo_id": person.get("id", ""),
    }


# ---------------------------------------------------------------------------
# Main entry point
# ---------------------------------------------------------------------------

def run(config: dict | None = None) -> list[dict]:
    """
    Enrich all leads from leads.json and write leads_enriched.json.
    Returns the list of enriched lead dicts.
    """
    if config is None:
        config = load_config()

    api_key = config["apollo_api_key"]
    leads = load_leads()

    logger.info("Loaded %d leads for enrichment.", len(leads))

    enriched_leads: list[dict] = []
    failed_leads: list[dict] = []

    for idx, lead in enumerate(leads, start=1):
        logger.info(
            "[%d/%d] Enriching: %s @ %s",
            idx, len(leads), lead.get("full_name"), lead.get("company_name"),
        )

        raw = enrich_lead(lead, api_key)

        if raw is None:
            logger.warning("Skipping %s — enrichment failed.", lead.get("full_name"))
            failed_leads.append({**lead, "enrichment_error": "API call failed"})
            continue

        enrichment = parse_enrichment(raw)

        # Merge enrichment data into the lead dict
        enriched_lead = {**lead, **enrichment}
        enriched_leads.append(enriched_lead)

        # Respect rate limits
        time.sleep(DEFAULT_DELAY_BETWEEN_CALLS)

    # Write enriched leads
    enriched_path = Path("leads_enriched.json")
    with open(enriched_path, "w") as fh:
        json.dump(enriched_leads, fh, indent=2)
    logger.info("Saved %d enriched leads → %s", len(enriched_leads), enriched_path)

    # Write failed leads for review
    if failed_leads:
        failed_path = Path("leads_failed_enrichment.json")
        with open(failed_path, "w") as fh:
            json.dump(failed_leads, fh, indent=2)
        logger.info("Logged %d failed leads → %s", len(failed_leads), failed_path)

    return enriched_leads


if __name__ == "__main__":
    run()
