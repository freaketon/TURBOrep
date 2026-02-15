# LinkedIn Sales Navigator → Apollo.io Automation Pipeline

Automated pipeline that scrapes leads from LinkedIn Sales Navigator, enriches
them via the Apollo.io API, and uploads them to your Apollo CRM with tagging
and sequence assignment.

## Architecture

```
┌──────────────────┐     ┌──────────────────┐     ┌──────────────────┐
│  Sales Navigator │────▶│  Apollo People    │────▶│  Apollo CRM      │
│  Scraper         │     │  Enrichment API   │     │  Upload + Tag    │
│  (Playwright)    │     │                   │     │  + Add to Seq    │
└──────────────────┘     └──────────────────┘     └──────────────────┘
      leads.json          leads_enriched.json         upload_log.txt
```

**Orchestrator** (`main.py`) runs all three steps sequentially and supports
a `--dry-run` flag to skip the upload step.

## Files

| File | Purpose |
|---|---|
| `sales_nav_scraper.py` | Playwright-based scraper for Sales Navigator search results |
| `apollo_enricher.py` | Calls Apollo People Enrichment API for each lead |
| `apollo_uploader.py` | Creates contacts in Apollo, tags them, adds to a sequence |
| `main.py` | Orchestrator — runs all 3 scripts sequentially |
| `config.template.json` | Configuration template (copy to `config.json`) |
| `requirements.txt` | Python dependencies |
| `.github/workflows/daily_scrape.yml` | GitHub Actions workflow for daily scheduled runs |

## Prerequisites

- Python 3.11+
- A LinkedIn account with Sales Navigator access
- An Apollo.io account with an API key (Settings → Integrations → API)
- A **master API key** if you want to add contacts to sequences

## Local Setup

### 1. Clone and install

```bash
git clone <this-repo>
cd <this-repo>
python -m venv .venv
source .venv/bin/activate  # Windows: .venv\Scripts\activate
pip install -r requirements.txt
playwright install chromium
```

### 2. Configure

```bash
cp config.template.json config.json
```

Edit `config.json` with your actual values:

```json
{
  "linkedin_email": "you@example.com",
  "linkedin_password": "your-password",
  "sales_nav_search_url": "https://www.linkedin.com/sales/search/people?savedSearchId=...",
  "apollo_api_key": "your-apollo-api-key",
  "apollo_sequence_id": "your-sequence-id",
  "icp_elite_keywords": ["CEO", "CTO", "CFO", "Founder", "Owner"],
  "icp_high_keywords": ["VP", "Director", "Head of", "Manager"]
}
```

> **config.json is in .gitignore** — it will not be committed.

### 3. Run

```bash
# Full pipeline
python main.py

# Dry run (scrape + enrich only, no upload)
python main.py --dry-run
```

You can also run each script individually:

```bash
python sales_nav_scraper.py      # → leads.json
python apollo_enricher.py        # → leads_enriched.json
python apollo_uploader.py        # → upload_log.txt
```

## GitHub Actions (Daily Scheduled Run)

The included workflow runs the pipeline daily at **6:00 AM PST** (14:00 UTC).

### Setup secrets

Go to your repo → Settings → Secrets and variables → Actions, and add:

| Secret | Value |
|---|---|
| `LINKEDIN_EMAIL` | Your LinkedIn email |
| `LINKEDIN_PASSWORD` | Your LinkedIn password |
| `SALES_NAV_SEARCH_URL` | Full Sales Navigator saved search URL |
| `APOLLO_API_KEY` | Your Apollo API key |
| `APOLLO_SEQUENCE_ID` | Target sequence ID in Apollo |

### Manual trigger

You can also trigger the workflow manually from the Actions tab, with an
option to enable dry-run mode.

### Artifacts

Each run uploads `leads.json`, `leads_enriched.json`, and `upload_log.txt`
as build artifacts retained for 30 days.

## ICP Tier Classification

Leads are tagged based on job title keywords from your config:

- **ELITE** — matches any keyword in `icp_elite_keywords` (e.g. CEO, CTO, Founder)
- **HIGH** — matches any keyword in `icp_high_keywords` (e.g. VP, Director)
- Defaults to **HIGH** if no keyword matches

Each contact is also tagged with `Sales_Nav_Auto` and `imported_YYYY-MM-DD`.

## API Endpoints Used

| Service | Endpoint | Docs |
|---|---|---|
| Apollo People Enrichment | `POST /api/v1/people/match` | [docs.apollo.io/reference/people-enrichment](https://docs.apollo.io/reference/people-enrichment) |
| Apollo Create Contact | `POST /api/v1/contacts` | [docs.apollo.io/reference/create-a-contact](https://docs.apollo.io/reference/create-a-contact) |
| Apollo Search Contacts | `POST /api/v1/contacts/search` | [docs.apollo.io/reference/search-for-contacts](https://docs.apollo.io/reference/search-for-contacts) |
| Apollo Add to Sequence | `POST /api/v1/emailer_campaigns/{id}/add_contact_ids` | [docs.apollo.io/reference/add-contacts-to-sequence](https://docs.apollo.io/reference/add-contacts-to-sequence) |

## Rate Limiting

- **Apollo API**: The enricher adds a 1.5s delay between calls. On HTTP 429
  responses, it backs off exponentially (5s, 10s, 15s) up to 3 retries.
- **LinkedIn**: The scraper adds random 2–5s delays between actions and uses
  a realistic user-agent string to reduce detection risk.

## Important Notes

- LinkedIn's Terms of Service restrict automated access. Use this tool
  responsibly and at your own risk. Consider running at low frequency and
  during off-peak hours.
- The scraper may break if LinkedIn changes their DOM structure. The CSS
  selectors in `sales_nav_scraper.py` are the most likely things to need
  updating.
- The "Add to Sequence" Apollo endpoint requires a **master API key**.
  A standard API key will return 403.
