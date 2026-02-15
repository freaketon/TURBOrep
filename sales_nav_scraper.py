"""
Sales Navigator Scraper
=======================
Uses Playwright to automate a headless Chrome browser, log into LinkedIn
Sales Navigator, navigate to a saved search, infinite-scroll to load all
results, and extract lead data (name, title, company, profile URL).

Output: leads.json
"""

import json
import logging
import random
import re
import time
from pathlib import Path

from playwright.sync_api import sync_playwright, TimeoutError as PlaywrightTimeout

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
)
logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def random_delay(low: float = 2.0, high: float = 5.0) -> None:
    """Sleep for a random duration to mimic human behaviour."""
    delay = random.uniform(low, high)
    logger.debug("Sleeping %.1fs", delay)
    time.sleep(delay)


def load_config(path: str = "config.json") -> dict:
    """Load configuration from config.json."""
    cfg_path = Path(path)
    if not cfg_path.exists():
        raise FileNotFoundError(
            f"{path} not found. Copy config.template.json → config.json and fill in your values."
        )
    with open(cfg_path, "r") as fh:
        return json.load(fh)


# ---------------------------------------------------------------------------
# Login
# ---------------------------------------------------------------------------

def login_to_linkedin(page, email: str, password: str) -> None:
    """
    Navigate to the LinkedIn login page and authenticate.
    Raises RuntimeError on failure.
    """
    logger.info("Navigating to LinkedIn login page …")
    page.goto("https://www.linkedin.com/login", wait_until="networkidle")
    random_delay(1, 2)

    logger.info("Entering credentials …")
    page.fill('input#username', email)
    random_delay(0.5, 1.0)
    page.fill('input#password', password)
    random_delay(0.5, 1.0)

    page.click('button[type="submit"]')

    # Wait for navigation after login
    try:
        page.wait_for_url("**/feed/**", timeout=30_000)
    except PlaywrightTimeout:
        # Could be a security challenge / CAPTCHA / 2FA
        current_url = page.url
        if "checkpoint" in current_url or "challenge" in current_url:
            raise RuntimeError(
                "LinkedIn is showing a security challenge (CAPTCHA / 2FA). "
                "Log in manually once to clear it, then retry."
            )
        raise RuntimeError(
            f"Login did not redirect to the feed. Current URL: {current_url}"
        )

    logger.info("Login successful.")
    random_delay()


# ---------------------------------------------------------------------------
# Infinite scroll
# ---------------------------------------------------------------------------

def scroll_to_load_all(page, max_stale_rounds: int = 5) -> None:
    """
    Scroll down repeatedly until no new profile cards appear.
    `max_stale_rounds` — how many consecutive scrolls with zero new results
    before we conclude that all results have loaded.
    """
    previous_count = 0
    stale_rounds = 0

    while stale_rounds < max_stale_rounds:
        page.evaluate("window.scrollTo(0, document.body.scrollHeight)")
        random_delay(2, 4)

        # Sales Navigator renders results in <li> elements within the results list
        current_count = page.locator("li.artdeco-list__item").count()
        logger.info("Scroll — visible result cards: %d", current_count)

        if current_count == previous_count:
            stale_rounds += 1
        else:
            stale_rounds = 0
            previous_count = current_count

        # Click "Next" / "Show more results" button if present
        show_more = page.locator("button.artdeco-pagination__button--next")
        if show_more.is_visible():
            show_more.click()
            random_delay(2, 4)

    logger.info("Scrolling complete. Total cards found: %d", previous_count)


# ---------------------------------------------------------------------------
# Extraction
# ---------------------------------------------------------------------------

def extract_leads(page) -> list[dict]:
    """
    Parse the currently loaded Sales Navigator search results page and
    return a list of lead dicts.
    """
    leads: list[dict] = []

    # Sales Navigator result cards are rendered inside an ordered list.
    # Each card contains the person's name, headline (title), company,
    # and a link to their Sales Navigator profile.
    cards = page.locator("li.artdeco-list__item")
    count = cards.count()
    logger.info("Extracting data from %d cards …", count)

    for i in range(count):
        card = cards.nth(i)
        try:
            # Full name — usually an anchor inside a span with data-anonymize="person-name"
            name_el = card.locator("[data-anonymize='person-name']").first
            full_name = name_el.inner_text().strip() if name_el.count() else ""

            # Job title / headline
            title_el = card.locator("[data-anonymize='headline']").first
            job_title = title_el.inner_text().strip() if title_el.count() else ""

            # Company name
            company_el = card.locator("[data-anonymize='company-name']").first
            company_name = company_el.inner_text().strip() if company_el.count() else ""

            # LinkedIn profile URL (Sales Navigator link)
            link_el = card.locator("a[href*='/sales/lead/']").first
            profile_url = ""
            if link_el.count():
                href = link_el.get_attribute("href") or ""
                # Normalise to absolute URL
                if href.startswith("/"):
                    profile_url = f"https://www.linkedin.com{href}"
                else:
                    profile_url = href
                # Strip query params for a cleaner URL
                profile_url = profile_url.split("?")[0]

            # Also try to extract the public LinkedIn profile URL if available
            public_link_el = card.locator("a[href*='linkedin.com/in/']").first
            public_url = ""
            if public_link_el.count():
                public_url = (public_link_el.get_attribute("href") or "").split("?")[0]

            lead = {
                "full_name": full_name,
                "job_title": job_title,
                "company_name": company_name,
                "linkedin_url": public_url or profile_url,
                "sales_nav_url": profile_url,
            }

            if full_name:  # skip empty / malformed cards
                leads.append(lead)

        except Exception as exc:
            logger.warning("Failed to extract card %d: %s", i, exc)

    logger.info("Extracted %d leads.", len(leads))
    return leads


# ---------------------------------------------------------------------------
# Pagination across multiple pages
# ---------------------------------------------------------------------------

def scrape_all_pages(page) -> list[dict]:
    """
    Iterate through paginated Sales Navigator search results.
    Returns the combined list of leads from all pages.
    """
    all_leads: list[dict] = []
    page_num = 1

    while True:
        logger.info("--- Scraping page %d ---", page_num)
        random_delay(2, 4)

        # Scroll within the current page to load lazy-rendered cards
        scroll_to_load_all(page, max_stale_rounds=3)

        # Extract leads from the current page
        page_leads = extract_leads(page)
        all_leads.extend(page_leads)

        # Check for a "Next" pagination button
        next_btn = page.locator("button.artdeco-pagination__button--next")
        if next_btn.count() and next_btn.is_enabled():
            logger.info("Navigating to page %d …", page_num + 1)
            next_btn.click()
            random_delay(3, 6)
            page_num += 1
        else:
            logger.info("No more pages. Stopping pagination.")
            break

    return all_leads


# ---------------------------------------------------------------------------
# Main entry point
# ---------------------------------------------------------------------------

def run(config: dict | None = None) -> list[dict]:
    """
    Execute the full scraping flow.
    Returns the list of scraped leads and writes them to leads.json.
    """
    if config is None:
        config = load_config()

    li_email = config["linkedin_email"]
    li_password = config["linkedin_password"]
    search_url = config["sales_nav_search_url"]

    with sync_playwright() as pw:
        browser = pw.chromium.launch(
            headless=True,
            args=[
                "--disable-blink-features=AutomationControlled",
                "--no-sandbox",
            ],
        )
        context = browser.new_context(
            viewport={"width": 1280, "height": 900},
            user_agent=(
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                "AppleWebKit/537.36 (KHTML, like Gecko) "
                "Chrome/120.0.0.0 Safari/537.36"
            ),
        )
        page = context.new_page()

        try:
            # Step 1 — Login
            login_to_linkedin(page, li_email, li_password)

            # Step 2 — Navigate to saved search
            logger.info("Navigating to Sales Navigator search …")
            page.goto(search_url, wait_until="domcontentloaded")
            random_delay(3, 5)

            # Step 3 — Scrape all pages
            leads = scrape_all_pages(page)

        except Exception:
            logger.exception("Scraping failed.")
            raise
        finally:
            context.close()
            browser.close()

    # Deduplicate by linkedin_url
    seen: set[str] = set()
    unique_leads: list[dict] = []
    for lead in leads:
        key = lead["linkedin_url"]
        if key and key not in seen:
            seen.add(key)
            unique_leads.append(lead)

    # Write output
    output_path = Path("leads.json")
    with open(output_path, "w") as fh:
        json.dump(unique_leads, fh, indent=2)
    logger.info("Saved %d unique leads → %s", len(unique_leads), output_path)

    return unique_leads


if __name__ == "__main__":
    run()
