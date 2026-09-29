/**
 * agents/agent3_prediction.js
 *
 * Agent 3 — Probabilistic Prediction Engine
 *
 * Step A: deterministic computation via probabilityModel.js
 * Step B: LLM narrates the computed probabilities (never generates them)
 *
 * The LLM receives the final percentages and must explain them using the
 * retrieved evidence. It cannot change the numbers.
 */

import Groq from "groq-sdk";
import { computeProbabilities } from "../model/probabilityModel.js";

const groq  = new Groq({ apiKey: process.env.GROQ_API_KEY });
const MODEL = process.env.GROQ_MODEL ?? "llama3-8b-8192";

const SYSTEM = `You are a football prediction analyst narrating a pre-computed statistical result.
The win probabilities have already been calculated by a deterministic statistical model.
Your ONLY job is to write a one-sentence natural-language explanation for each probability,
citing specific numbers from the retrieved data provided.

Return this exact JSON (no markdown):
{
  "predicted_winner": "<Team Name or 'Draw'>",
  "probability_narrative": "<one sentence explaining why these probabilities are as they are, citing retrieved stats>"
}
Rules:
- You must NOT change or invent any percentages.
- The predicted_winner must match the highest probability outcome.
- If team_a_pct equals team_b_pct, predicted_winner = "Draw".
- Cite specific retrieved stats (e.g. win rates, form strings, H2H records).`;

/**
 * @param {object} bundle    - RetrievalBundle
 * @param {object} vectors   - from agent2_performanceAnalysis
 * @returns {Promise<PredictionResult>}
 */
export async function agent3_prediction(bundle, vectors) {
  // ── Step A: deterministic probability computation ──────────────────────────
  const { team_a_pct, team_b_pct, draw_pct, confidence, model_inputs } =
    computeProbabilities(bundle);

  // Determine winner label
  const winner = team_a_pct > team_b_pct && team_a_pct > draw_pct
    ? bundle.team_a
    : team_b_pct > team_a_pct && team_b_pct > draw_pct
    ? bundle.team_b
    : "Draw";

  // ── Step B: LLM narrates the result ───────────────────────────────────────
  const statsA = bundle.team_a_stats;
  const statsB = bundle.team_b_stats;

  const context = {
    team_a:      bundle.team_a,
    team_b:      bundle.team_b,
    venue_host:  bundle.venue_host ?? "neutral",
    // Pre-computed probabilities — LLM must use these exactly
    computed_probabilities: {
      [`${bundle.team_a}_win_pct`]: team_a_pct,
      [`${bundle.team_b}_win_pct`]: team_b_pct,
      draw_pct,
    },
    predicted_winner:   winner,
    model_inputs,
    team_a_win_rate:    statsA?.win_rate     ?? null,
    team_b_win_rate:    statsB?.win_rate     ?? null,
    team_a_form_string: statsA?.form_string  ?? null,
    team_b_form_string: statsB?.form_string  ?? null,
    h2h_total:          bundle.head_to_head.length,
    tactical_summary:   vectors.tactical_summary,
    data_warnings:      bundle.data_warnings,
  };

  const completion = await groq.chat.completions.create({
    model: MODEL,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: SYSTEM },
      { role: "user",   content: `Prediction context:\n${JSON.stringify(context, null, 2)}` },
    ],
    temperature: 0.1,
    max_tokens: 400,
  });

  const raw = JSON.parse(completion.choices[0]?.message?.content ?? "{}");

  return {
    // Deterministic numbers — never touched by LLM
    team_a_pct,
    team_b_pct,
    draw_pct,
    confidence,
    model_inputs,
    // LLM-generated narrative only
    predicted_winner:       winner,   // from model, not LLM
    probability_narrative:  raw.probability_narrative ?? "",
  };
}
