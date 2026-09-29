/**
 * retrieval/retrievalService.js
 *
 * Hybrid retrieval service for football match prediction.
 *
 * Retrieval strategy:
 *   1. STRUCTURED — always executed against the SQLite DB:
 *      • Head-to-head records (up to 20 matches)
 *      • Team A recent form (last 10 matches, home + away)
 *      • Team B recent form (last 10 matches, home + away)
 *      • Team A home form (last 10 home matches)
 *      • Team B away form (last 10 away matches) [or vice versa based on venue_host]
 *      • Aggregate statistics for both teams
 *
 *   2. SEMANTIC — only executed when match_notes exist for retrieved match IDs:
 *      • Fetches raw text notes and ranks by simple keyword overlap with
 *        the query teams. No vector DB required — the dataset is small.
 *      • When no notes exist, this stage is skipped and a warning is added.
 *
 * Returns a RetrievalBundle:
 * {
 *   found: boolean,
 *   team_a: string,
 *   team_b: string,
 *   head_to_head: MatchRow[],
 *   team_a_form: MatchRow[],
 *   team_b_form: MatchRow[],
 *   team_a_stats: TeamStats | null,
 *   team_b_stats: TeamStats | null,
 *   relevant_notes: NoteRow[],
 *   query_params: object,
 *   data_warnings: string[],
 *   sources: SourceCitation[],
 * }
 */

import { getDb } from "../db/schema.js";
import {
  getTeamId,
  getHeadToHead,
  getTeamForm,
  getTeamStats,
  getMatchNotes,
} from "../db/queries.js";

// ─── Constants ────────────────────────────────────────────────────────────────

const H2H_LIMIT       = 20;
const FORM_WINDOW     = 10;
const MIN_H2H_WARN    = 5;   // warn if fewer than this many H2H records
const MIN_FORM_WARN   = 3;   // warn if fewer than this many form records

// ─── Semantic ranking ─────────────────────────────────────────────────────────

/**
 * Very simple keyword-overlap ranking for match notes.
 * Avoids any external NLP dependency; works well for a small corpus.
 * @param {Array<{match_id:number, content:string, source_name:string|null}>} notes
 * @param {string[]} keywords
 * @param {number} topK
 * @returns {Array<{match_id:number, content:string, source_name:string|null, score:number}>}
 */
function rankNotes(notes, keywords, topK = 5) {
  const lc = keywords.map(k => k.toLowerCase());
  return notes
    .map(n => {
      const text  = n.content.toLowerCase();
      const score = lc.reduce((acc, kw) => acc + (text.includes(kw) ? 1 : 0), 0);
      return { ...n, score };
    })
    .filter(n => n.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
}

// ─── Source deduplication ─────────────────────────────────────────────────────

function deduplicateSources(rows) {
  const seen = new Set();
  const out  = [];
  for (const row of rows) {
    if (!row.source_name) continue;
    const key = row.source_name;
    if (!seen.has(key)) {
      seen.add(key);
      out.push({
        name:         row.source_name,
        url:          row.source_url  ?? null,
        retrieved_at: row.retrieved_at ?? null,
      });
    }
  }
  return out;
}

// ─── Main retrieval ───────────────────────────────────────────────────────────

/**
 * Perform hybrid retrieval for a fixture.
 *
 * @param {object} params
 * @param {string}  params.team_a          - Home or Team A
 * @param {string}  params.team_b          - Away or Team B
 * @param {'team_a'|'team_b'|null} [params.venue_host] - Which team is hosting
 * @param {string}  [params.dbPath]        - Override DB path (used in tests)
 * @returns {RetrievalBundle}
 */
export function retrieve({ team_a, team_b, venue_host = null, dbPath } = {}) {
  if (!team_a || !team_b) {
    throw new Error("retrieve() requires team_a and team_b");
  }

  const db       = getDb(dbPath);
  const warnings = [];

  // ── 1. Resolve team IDs ──────────────────────────────────────────────────────
  const idA = getTeamId(db, team_a);
  const idB = getTeamId(db, team_b);

  if (idA === null) warnings.push(`No database records found for team "${team_a}".`);
  if (idB === null) warnings.push(`No database records found for team "${team_b}".`);

  // ── 2. Structured retrieval ──────────────────────────────────────────────────
  const h2h        = getHeadToHead(db, team_a, team_b, H2H_LIMIT);
  const formA      = getTeamForm(db, team_a, FORM_WINDOW, "all");
  const formB      = getTeamForm(db, team_b, FORM_WINDOW, "all");

  // Venue-specific form: if we know who is hosting, weight recent home/away form
  const homeFormA  = getTeamForm(db, team_a, FORM_WINDOW, "home");
  const awayFormB  = getTeamForm(db, team_b, FORM_WINDOW, "away");
  const awayFormA  = getTeamForm(db, team_a, FORM_WINDOW, "away");
  const homeFormB  = getTeamForm(db, team_b, FORM_WINDOW, "home");

  const statsA     = getTeamStats(db, team_a, FORM_WINDOW);
  const statsB     = getTeamStats(db, team_b, FORM_WINDOW);

  // ── 3. Data-quality warnings ─────────────────────────────────────────────────
  if (h2h.length === 0) {
    warnings.push(`No head-to-head records found between "${team_a}" and "${team_b}". Prediction will rely on individual form only.`);
  } else if (h2h.length < MIN_H2H_WARN) {
    warnings.push(`Only ${h2h.length} head-to-head record(s) available. H2H confidence is low.`);
  }

  if (formA.length === 0) {
    warnings.push(`No recent form records found for "${team_a}".`);
  } else if (formA.length < MIN_FORM_WARN) {
    warnings.push(`Only ${formA.length} form record(s) for "${team_a}". Form analysis confidence is low.`);
  }

  if (formB.length === 0) {
    warnings.push(`No recent form records found for "${team_b}".`);
  } else if (formB.length < MIN_FORM_WARN) {
    warnings.push(`Only ${formB.length} form record(s) for "${team_b}". Form analysis confidence is low.`);
  }

  // ── 4. Semantic retrieval (only when notes exist) ─────────────────────────────
  const allMatchIds = [
    ...new Set([
      ...h2h.map(r => r.id),
      ...formA.map(r => r.id),
      ...formB.map(r => r.id),
    ])
  ];
  const rawNotes   = getMatchNotes(db, allMatchIds);
  const keywords   = [team_a, team_b, ...team_a.split(" "), ...team_b.split(" ")];
  const rankedNotes = rawNotes.length > 0
    ? rankNotes(rawNotes, keywords, 5)
    : [];

  if (rawNotes.length === 0 && allMatchIds.length > 0) {
    warnings.push("No match reports available for the retrieved fixtures. Semantic context unavailable.");
  }

  // ── 5. Confidence level ──────────────────────────────────────────────────────
  const found = idA !== null && idB !== null && (formA.length > 0 || formB.length > 0);
  const confidence = computeConfidence({ h2h, formA, formB, found });

  // ── 6. Source citations ──────────────────────────────────────────────────────
  const allRows = [...h2h, ...formA, ...formB];
  const sources = deduplicateSources(allRows);

  return {
    found,
    confidence,
    team_a,
    team_b,
    venue_host: venue_host ?? null,
    head_to_head:  h2h,
    team_a_form:   formA,
    team_b_form:   formB,
    // Venue-specific form included separately for the statistical model
    home_form_a:   homeFormA,
    away_form_b:   awayFormB,
    away_form_a:   awayFormA,
    home_form_b:   homeFormB,
    team_a_stats:  statsA,
    team_b_stats:  statsB,
    relevant_notes: rankedNotes,
    query_params: {
      team_a,
      team_b,
      venue_host: venue_host ?? null,
      h2h_limit:  H2H_LIMIT,
      form_window: FORM_WINDOW,
    },
    data_warnings: warnings,
    sources,
  };
}

// ─── Confidence helper ────────────────────────────────────────────────────────

/**
 * Compute a data-confidence rating based on available evidence.
 * This is RETRIEVAL confidence (how much data we have), not prediction confidence.
 * @returns {'High'|'Medium'|'Low'}
 */
function computeConfidence({ h2h, formA, formB, found }) {
  if (!found) return "Low";
  const formDepth  = Math.min(formA.length, formB.length);
  const h2hDepth   = h2h.length;
  if (formDepth >= 5 && h2hDepth >= 3) return "High";
  if (formDepth >= 2 || h2hDepth >= 1) return "Medium";
  return "Low";
}
