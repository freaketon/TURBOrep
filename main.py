"""
Orchestrator
=============
Runs the full pipeline: Scrape → Enrich → Upload.

Usage:
    python main.py              # full run
    python main.py --dry-run    # scrape + enrich only, skip upload
"""

import argparse
import json
import logging
import sys
import time

import sales_nav_scraper
import apollo_enricher
import apollo_uploader

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
)
logger = logging.getLogger(__name__)


def load_config(path: str = "config.json") -> dict:
    with open(path, "r") as fh:
        return json.load(fh)


def main() -> None:
    parser = argparse.ArgumentParser(
        description="LinkedIn Sales Navigator → Apollo.io automation pipeline",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Scrape and enrich, but skip the upload to Apollo CRM.",
    )
    args = parser.parse_args()

    config = load_config()
    start_time = time.time()

    # ------------------------------------------------------------------
    # Step 1: Scrape Sales Navigator
    # ------------------------------------------------------------------
    logger.info("=" * 60)
    logger.info("STEP 1 / 3 — Scraping Sales Navigator")
    logger.info("=" * 60)

    try:
        scraped_leads = sales_nav_scraper.run(config)
    except Exception:
        logger.exception("Scraping failed. Aborting pipeline.")
        sys.exit(1)

    total_scraped = len(scraped_leads)
    logger.info("Scraped %d leads.", total_scraped)

    if total_scraped == 0:
        logger.warning("No leads scraped. Nothing to enrich or upload.")
        sys.exit(0)

    # ------------------------------------------------------------------
    # Step 2: Enrich via Apollo API
    # ------------------------------------------------------------------
    logger.info("=" * 60)
    logger.info("STEP 2 / 3 — Enriching leads via Apollo API")
    logger.info("=" * 60)

    try:
        enriched_leads = apollo_enricher.run(config)
    except Exception:
        logger.exception("Enrichment failed. Aborting pipeline.")
        sys.exit(1)

    total_enriched = len(enriched_leads)
    logger.info("Enriched %d leads.", total_enriched)

    # ------------------------------------------------------------------
    # Step 3: Upload to Apollo CRM (skipped in dry-run mode)
    # ------------------------------------------------------------------
    upload_summary = {"uploaded": 0, "skipped_duplicates": 0, "failed": 0}

    if args.dry_run:
        logger.info("=" * 60)
        logger.info("STEP 3 / 3 — Upload SKIPPED (--dry-run mode)")
        logger.info("=" * 60)
    else:
        logger.info("=" * 60)
        logger.info("STEP 3 / 3 — Uploading to Apollo CRM")
        logger.info("=" * 60)

        try:
            upload_summary = apollo_uploader.run(config)
        except Exception:
            logger.exception("Upload failed.")
            upload_summary["failed"] = total_enriched

    # ------------------------------------------------------------------
    # Summary
    # ------------------------------------------------------------------
    elapsed = time.time() - start_time

    summary = {
        "leads_scraped": total_scraped,
        "leads_enriched": total_enriched,
        "leads_uploaded": upload_summary.get("uploaded", 0),
        "duplicates_skipped": upload_summary.get("skipped_duplicates", 0),
        "upload_failures": upload_summary.get("failed", 0),
        "dry_run": args.dry_run,
        "elapsed_seconds": round(elapsed, 1),
    }

    logger.info("=" * 60)
    logger.info("PIPELINE COMPLETE")
    logger.info("=" * 60)
    for key, value in summary.items():
        logger.info("  %-22s %s", key, value)
    logger.info("=" * 60)


if __name__ == "__main__":
    main()
