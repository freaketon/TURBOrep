/**
 * ICP Qualifier
 * =============
 * Classifies leads into PRIMARY / SECONDARY / SKIP tiers BEFORE
 * enrichment so we never waste Apollo credits on non-ICP leads.
 *
 * Uses job-title keyword matching (case-insensitive substring).
 * Company-name filters are optional.
 */

/**
 * Default ICP configuration – used until the user customizes it.
 */
export const DEFAULT_ICP_CONFIG = {
  primary: {
    description: "C-suite, founders, and owners",
    title_include: [
      "CEO", "CTO", "CFO", "COO", "CMO", "CRO", "CIO", "CISO",
      "Founder", "Co-Founder", "Owner", "President", "Chief"
    ],
    title_exclude: ["Former", "Ex-", "Assistant to"],
    company_include: [],
    company_exclude: [],
  },
  secondary: {
    description: "Senior leadership – VPs, Directors, Heads",
    title_include: [
      "VP", "Vice President", "Director", "Head of",
      "Senior Manager", "Partner", "General Manager"
    ],
    title_exclude: ["Former", "Ex-", "Assistant"],
    company_include: [],
    company_exclude: [],
  },
  global_exclude: ["Intern", "Student", "Retired"],
};


/**
 * Check whether a string matches at least one keyword in a list.
 * @param {string} text       – lowercased text to search in
 * @param {string[]} keywords – keywords (will be lowercased internally)
 * @returns {boolean}
 */
function matchesAny(text, keywords) {
  if (!keywords || keywords.length === 0) return false;
  return keywords.some((kw) => text.includes(kw.toLowerCase()));
}


/**
 * Check whether a lead matches a given ICP tier definition.
 */
function matchesTier(titleLower, companyLower, tier) {
  // Must match at least one title_include keyword
  if (!matchesAny(titleLower, tier.title_include)) return false;

  // Must NOT match any title_exclude keyword
  if (matchesAny(titleLower, tier.title_exclude)) return false;

  // If company_include is set, company must match at least one
  if (tier.company_include && tier.company_include.length > 0) {
    if (!matchesAny(companyLower, tier.company_include)) return false;
  }

  // Must NOT match any company_exclude keyword
  if (matchesAny(companyLower, tier.company_exclude)) return false;

  return true;
}


/**
 * Qualify a single lead against the ICP config.
 *
 * @param {object} lead      – must have `job_title` and `company_name`
 * @param {object} icpConfig – { primary, secondary, global_exclude }
 * @returns {{ qualified: boolean, tier: string|null, reason: string }}
 */
export function qualifyLead(lead, icpConfig) {
  const title   = (lead.job_title   || "").toLowerCase();
  const company = (lead.company_name || "").toLowerCase();

  // ── Global exclusions ───────────────────────────────────
  if (matchesAny(title, icpConfig.global_exclude)) {
    return { qualified: false, tier: null, reason: "Global exclusion match" };
  }

  // ── Primary ICP ─────────────────────────────────────────
  if (matchesTier(title, company, icpConfig.primary)) {
    return { qualified: true, tier: "PRIMARY", reason: "Matches primary ICP" };
  }

  // ── Secondary ICP ───────────────────────────────────────
  if (matchesTier(title, company, icpConfig.secondary)) {
    return { qualified: true, tier: "SECONDARY", reason: "Matches secondary ICP" };
  }

  // ── No match ────────────────────────────────────────────
  return { qualified: false, tier: null, reason: "No ICP match" };
}
