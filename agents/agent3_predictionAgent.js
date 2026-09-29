/**
 * agents/agent3_predictionAgent.js
 *
 * Agent 3 — Prediction Agent
 *
 * Wraps the deterministic footballModel and produces a full PredictionSchema.
 * The LLM is NOT called here — zero async, zero network.
 *
 * Input:  DataBundle + PerformanceReport
 * Output: PredictionSchema
 */

import { computeFootballPrediction } from "../model/footballModel.js";

/**
 * @param {import('./types.js').DataBundle}         bundle
 * @param {import('./types.js').PerformanceReport}  report
 * @returns {import('./types.js').PredictionSchema}
 */
export function predictionAgent(bundle, report) {
  // Sparse-data fallback: if neither team has any form records, return a
  // clearly-labelled "no prediction" schema rather than fabricate a winner.
  const noData = bundle.team_a_form.length === 0 && bundle.team_b_form.length === 0;
  if (noData) {
    return sparseDataFallback(bundle);
  }

  return computeFootballPrediction(bundle, report);
}

// ─── Sparse-data fallback ─────────────────────────────────────────────────────

/**
 * Returns a maximally-uncertain PredictionSchema when there is no usable data.
 * Never fabricates a winner.
 * @param {import('./types.js').DataBundle} bundle
 * @returns {import('./types.js').PredictionSchema}
 */
function sparseDataFallback(bundle) {
  const { MODEL_VERSION, MODEL_TYPE } = { MODEL_VERSION: "2.0.0", MODEL_TYPE: "poisson_elo_blend" };
  return {
    model_version:     MODEL_VERSION,
    model_type:        MODEL_TYPE,
    predicted_winner:  "Unavailable",
    winner_is_certain: false,
    probabilities: {
      team_a_win: 0.3333,
      draw:       0.3333,
      team_b_win: 0.3334,
      team_a_pct: 33,
      draw_pct:   34,
      team_b_pct: 33,
    },
    expected_goals: {
      team_a_xg: null,
      team_b_xg: null,
      method:    "none",
    },
    confidence:       "Insufficient",
    confidence_score: 0,
    separation:       0.0001,
    data_quality:     bundle.data_quality,
    feature_values:   {},
    source_citations: bundle.sources,
    caveats: [
      `No historical records found for "${bundle.team_a}" or "${bundle.team_b}".`,
      "A prediction cannot be made without evidence. Equal probabilities (33/34/33) are a placeholder only.",
      "Add historical match data for these teams and re-seed the database.",
    ],
  };
}
