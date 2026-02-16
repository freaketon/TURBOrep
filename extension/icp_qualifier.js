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
 * Default ICP configuration – "Archive-Drowning Aiden"
 * =====================================================
 * Target: Founder or content lead running a video-first business
 * with 2+ editors and a high publishing cadence, where a growing
 * archive has become an execution tax that caps output and margin.
 *
 * PRIMARY  = Decision makers with budget authority (the signer)
 * SECONDARY = Operational champions who feel the pain daily (the champion)
 *
 * Company filters boost hit rate by narrowing to video/content/media orgs.
 *
 * Explicit exclusions per ICP definition:
 *   - Solo creators, film/cinema-first teams, post-production-only shops
 *   - Anyone without budget authority or reuse workflow
 */
export const DEFAULT_ICP_CONFIG = {
  primary: {
    description: "Decision makers at video-first content businesses (budget authority)",
    title_include: [
      "Founder", "Co-Founder", "CEO", "Owner", "President",
      "Creative Director", "Content Director", "Media Director",
      "Head of Content", "Head of Video", "Head of Production",
      "Head of Media", "Head of Creative",
      "Executive Producer", "Chief Content Officer", "CCO",
      "Content Lead", "Video Lead"
    ],
    title_exclude: [
      "Former", "Ex-", "Assistant to",
      "Film Director", "Cinematographer"
    ],
    company_include: [],
    company_exclude: [],
  },
  secondary: {
    description: "Operational champions who feel archive pain daily (the internal champion)",
    title_include: [
      "Video Producer", "Senior Producer", "Production Manager",
      "Lead Editor", "Senior Editor", "Editor-in-Chief",
      "Post-Production Manager", "Head of Post", "Post-Production Supervisor",
      "Content Manager", "Content Strategist",
      "COO", "Operations Manager", "Director of Operations",
      "VP Content", "VP Production", "VP Creative",
      "Director of Content", "Director of Video", "Director of Production",
      "Studio Manager", "Production Coordinator"
    ],
    title_exclude: [
      "Former", "Ex-", "Assistant",
      "Film Director", "Cinematographer",
      "Colorist", "Sound Designer"
    ],
    company_include: [],
    company_exclude: [],
  },
  global_exclude: [
    "Intern", "Student", "Retired",
    "Actor", "Talent", "Model",
    "Accountant", "Legal Counsel", "HR Manager"
  ],
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
