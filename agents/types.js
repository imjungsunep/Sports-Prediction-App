/**
 * agents/types.js
 *
 * Typed input/output contracts for every agent in the Phase 2 pipeline.
 * These are JSDoc @typedef definitions — no runtime overhead.
 * Every agent function validates against these shapes on input and output.
 *
 * Pipeline flow:
 *
 *   PredictionInput
 *       │
 *       └─► DataCollectionAgent   → DataBundle
 *                   │
 *                   └─► PerformanceAnalysisAgent  → PerformanceReport
 *                               │
 *                               └─► PredictionAgent  → PredictionSchema
 *                                           │
 *                                           └─► InsightGenerationAgent  → InsightReport
 */

// ─── Shared primitives ────────────────────────────────────────────────────────

/**
 * @typedef {'High'|'Medium'|'Low'|'Insufficient'} ConfidenceLabel
 */

/**
 * @typedef {Object} SourceCitation
 * @property {string}      source_id      - stable identifier (source DB row name)
 * @property {string}      source_name    - human-readable name
 * @property {string|null} url
 * @property {string|null} retrieved_at   - ISO-8601 date
 * @property {number}      records_used   - how many records from this source were used
 */

/**
 * @typedef {Object} DataQualityScore
 * @property {number}  score                - 0..1 (1 = full confidence)
 * @property {string}  label                - "Excellent"|"Good"|"Fair"|"Sparse"|"None"
 * @property {number}  h2h_count            - H2H matches found (post-leakage-filter)
 * @property {number}  team_a_form_count    - form matches for team A
 * @property {number}  team_b_form_count    - form matches for team B
 * @property {number}  freshness_days       - days since the most recent match in data
 * @property {string[]} warnings            - human-readable quality warnings
 */

// ─── Agent 1: DataCollectionAgent ────────────────────────────────────────────

/**
 * Input to DataCollectionAgent.
 * @typedef {Object} PredictionInput
 * @property {string}                         team_a
 * @property {string}                         team_b
 * @property {'team_a'|'team_b'|null}         venue_host
 * @property {string|null}                    fixture_date  - ISO-8601; used for leakage guard
 * @property {string}                         [dbPath]      - override for tests
 */

/**
 * Output of DataCollectionAgent. Extends the Phase 1 RetrievalBundle.
 * @typedef {Object} DataBundle
 * @property {boolean}        found
 * @property {string}         team_a
 * @property {string}         team_b
 * @property {'team_a'|'team_b'|null} venue_host
 * @property {string|null}    fixture_date
 * @property {object[]}       head_to_head         - matches BEFORE fixture_date
 * @property {object[]}       team_a_form          - last-10 matches BEFORE fixture_date
 * @property {object[]}       team_b_form          - last-10 matches BEFORE fixture_date
 * @property {object[]}       home_form_a
 * @property {object[]}       away_form_b
 * @property {object[]}       away_form_a
 * @property {object[]}       home_form_b
 * @property {object|null}    team_a_stats
 * @property {object|null}    team_b_stats
 * @property {object[]}       relevant_notes
 * @property {DataQualityScore} data_quality
 * @property {SourceCitation[]} sources
 * @property {string[]}       data_warnings
 * @property {object}         coverage              - { team_a_known, team_b_known, h2h_total }
 */

// ─── Agent 2: PerformanceAnalysisAgent ───────────────────────────────────────

/**
 * @typedef {Object} TeamPerformanceMetrics
 * @property {number}   form_score             - -1 to 1, recency-weighted
 * @property {number}   attack_strength        - avg goals scored last N games
 * @property {number}   defence_strength       - avg goals conceded last N games (lower = better)
 * @property {number}   home_win_rate          - 0..1
 * @property {number}   away_win_rate          - 0..1
 * @property {number}   overall_win_rate       - 0..1
 * @property {number}   rest_days              - days since last match (null if unknown)
 * @property {string}   form_string            - e.g. "WWDLW"
 * @property {number}   matches_used           - how many matches contributed
 */

/**
 * @typedef {Object} H2HMetrics
 * @property {number}   total
 * @property {number}   team_a_wins
 * @property {number}   team_b_wins
 * @property {number}   draws
 * @property {number}   team_a_win_rate
 * @property {number}   recency_weight         - 0..1; how recent the H2H data is
 * @property {object[]} sample                 - up to 5 most recent H2H rows
 */

/**
 * Output of PerformanceAnalysisAgent.
 * @typedef {Object} PerformanceReport
 * @property {TeamPerformanceMetrics} team_a_metrics
 * @property {TeamPerformanceMetrics} team_b_metrics
 * @property {H2HMetrics}             h2h_metrics
 * @property {number}                 home_advantage_factor  - 0..1; 0.5 = neutral
 * @property {ConfidenceLabel}        data_confidence
 * @property {object}                 feature_values         - raw numbers fed into the model
 */

// ─── Agent 3: PredictionAgent ─────────────────────────────────────────────────

/**
 * @typedef {Object} ProbabilityDistribution
 * @property {number}  team_a_win   - 0..1 (not %)
 * @property {number}  draw         - 0..1
 * @property {number}  team_b_win   - 0..1
 * @property {number}  team_a_pct   - integer, sum with draw_pct+team_b_pct = 100
 * @property {number}  draw_pct     - integer
 * @property {number}  team_b_pct   - integer
 */

/**
 * @typedef {Object} ExpectedGoals
 * @property {number|null}  team_a_xg  - Poisson lambda for team A
 * @property {number|null}  team_b_xg  - Poisson lambda for team B
 * @property {string}       method     - "poisson"|"elo_only"|"none"
 */

/**
 * Full prediction output schema.
 * @typedef {Object} PredictionSchema
 * @property {string}                 model_version      - semver, e.g. "2.0.0"
 * @property {string}                 model_type         - "poisson_elo_blend"
 * @property {string}                 predicted_winner   - team name or "Draw"
 * @property {boolean}                winner_is_certain  - false when prediction is fallback
 * @property {ProbabilityDistribution} probabilities
 * @property {ExpectedGoals}          expected_goals
 * @property {ConfidenceLabel}        confidence         - based on data quality + separation
 * @property {number}                 confidence_score   - 0..1 (continuous)
 * @property {number}                 separation         - |team_a_win - team_b_win| in raw prob
 * @property {DataQualityScore}       data_quality
 * @property {object}                 feature_values     - every numeric input to the model
 * @property {SourceCitation[]}       source_citations
 * @property {string[]}               caveats            - machine-generated caveats
 */

// ─── Agent 4: InsightGenerationAgent ─────────────────────────────────────────

/**
 * @typedef {Object} InsightReport
 * @property {string[]}      insights          - array of fan-readable insight strings
 * @property {boolean}       llm_used          - false when fallback template was used
 * @property {SourceCitation[]} cited_sources  - sources explicitly cited in insights
 * @property {string[]}      insufficient_evidence_fields  - fields with no supporting data
 */

// ─── Validator helpers ────────────────────────────────────────────────────────

/**
 * Assert that probabilities (raw 0..1) sum to 1 within tolerance.
 * Throws if violated — prevents silent probability drift.
 * @param {number} a
 * @param {number} d
 * @param {number} b
 * @param {number} [tol=1e-9]
 */
export function assertProbabilitiesSum(a, d, b, tol = 1e-9) {
  const sum = a + d + b;
  if (Math.abs(sum - 1.0) > tol) {
    throw new Error(`Probability invariant violated: ${a}+${d}+${b} = ${sum} ≠ 1`);
  }
}

/**
 * Assert integer percentages sum to exactly 100.
 * @param {number} pctA
 * @param {number} pctD
 * @param {number} pctB
 */
export function assertPercentagesSum(pctA, pctD, pctB) {
  if (pctA + pctD + pctB !== 100) {
    throw new Error(`Percentage invariant violated: ${pctA}+${pctD}+${pctB} = ${pctA+pctD+pctB} ≠ 100`);
  }
}

/**
 * Compute a data-quality score (0..1) from coverage numbers.
 * @param {number} h2hCount
 * @param {number} formACount
 * @param {number} formBCount
 * @param {number} freshnessDays  - days since most recent match
 * @returns {DataQualityScore}
 */
export function computeDataQualityScore(h2hCount, formACount, formBCount, freshnessDays) {
  // Component scores
  const h2hScore  = Math.min(1, h2hCount / 10);        // saturates at 10 H2H matches
  const formScore = Math.min(1, Math.min(formACount, formBCount) / 8); // saturates at 8 form matches
  const ageScore  = freshnessDays <= 180 ? 1 :
                    freshnessDays <= 365 ? 0.7 :
                    freshnessDays <= 730 ? 0.4 : 0.2;

  const score = 0.35 * h2hScore + 0.45 * formScore + 0.20 * ageScore;

  const label = score >= 0.80 ? "Excellent"
              : score >= 0.55 ? "Good"
              : score >= 0.30 ? "Fair"
              : score >= 0.10 ? "Sparse"
              : "None";

  const warnings = [];
  if (h2hCount === 0) warnings.push("No head-to-head records. Prediction relies on individual form.");
  else if (h2hCount < 3) warnings.push(`Only ${h2hCount} H2H record(s). H2H signal has low reliability.`);
  if (formACount < 3) warnings.push(`Fewer than 3 form records for team A (${formACount} found).`);
  if (formBCount < 3) warnings.push(`Fewer than 3 form records for team B (${formBCount} found).`);
  if (freshnessDays > 365) warnings.push(`Most recent data is ${Math.round(freshnessDays/30)} months old.`);

  return { score: +score.toFixed(3), label, h2h_count: h2hCount,
           team_a_form_count: formACount, team_b_form_count: formBCount,
           freshness_days: freshnessDays, warnings };
}

/** MODEL_VERSION is baked into every PredictionSchema for traceability. */
export const MODEL_VERSION = "2.0.0";
export const MODEL_TYPE    = "poisson_elo_blend";
