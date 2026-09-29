/**
 * agents/agent4_xai.js
 *
 * Agent 4 — Explainable AI (XAI) Insights
 *
 * LLM call. Generates three grounded insights, each citing a specific
 * retrieved record. The LLM receives the actual match rows and must
 * reference them by date and score.
 *
 * Every insight must include:
 *   - A specific retrieved match result (date + scoreline)
 *   - A statistic derived from the retrieved data
 *
 * If there is insufficient data for a category, the insight must say so
 * explicitly rather than fabricate a plausible-sounding answer.
 */

import Groq from "groq-sdk";

const groq  = new Groq({ apiKey: process.env.GROQ_API_KEY });
const MODEL = process.env.GROQ_MODEL ?? "llama3-8b-8192";

const SYSTEM = `You are a football analyst writing explainable AI insights.
You are given REAL RETRIEVED MATCH RECORDS. Every insight must cite specific evidence.

Return this exact JSON (no markdown):
{
  "insight_1": "<Primary deciding factor — cite a specific retrieved stat or match result, e.g. '${'{team}'} won 7 of the last 10 H2H meetings, including a ${'{date}'} victory ${'{score}'}'>",
  "insight_2": "<Recent form or goals trend — cite actual form rows provided, e.g. '${'{team}'}'s form string ${'{WWDLW}'} shows 3 wins in 5'>",
  "insight_3": "<Venue or competition context — cite actual home/away split from the retrieved stats>"
}
Rules:
- You MUST quote at least one match result (format: 'TeamA N-N TeamB on YYYY-MM-DD') per insight.
- If you have no retrieved evidence for a category, write: "Insufficient historical data — [category] evidence unavailable."
- Do NOT invent matches, scorelines, or statistics.
- Each insight ≤250 characters.`;

/**
 * @param {object} bundle     - RetrievalBundle
 * @param {object} vectors    - from agent2
 * @param {object} prediction - from agent3
 * @returns {Promise<string[]>} array of 3 insight strings
 */
export async function agent4_xaiInsights(bundle, vectors, prediction) {
  // Prepare evidence — pass only what exists, capped to avoid token bloat
  const h2hSample  = bundle.head_to_head.slice(0, 6).map(r =>
    `${r.home_team} ${r.home_goals}-${r.away_goals} ${r.away_team} on ${r.match_date} (${r.competition ?? "unknown"})`
  );
  const formSampleA = bundle.team_a_form.slice(0, 5).map(r =>
    `${r.home_team} ${r.home_goals}-${r.away_goals} ${r.away_team} on ${r.match_date} → ${bundle.team_a}: ${r.team_result}`
  );
  const formSampleB = bundle.team_b_form.slice(0, 5).map(r =>
    `${r.home_team} ${r.home_goals}-${r.away_goals} ${r.away_team} on ${r.match_date} → ${bundle.team_b}: ${r.team_result}`
  );
  const notesSample = bundle.relevant_notes.slice(0, 3).map(n =>
    `Match #${n.match_id}: "${n.content.slice(0, 120)}"`
  );

  const statsA = bundle.team_a_stats;
  const statsB = bundle.team_b_stats;

  const evidence = {
    team_a:          bundle.team_a,
    team_b:          bundle.team_b,
    venue_host:      bundle.venue_host ?? "neutral",
    predicted_winner: prediction.predicted_winner,
    computed_win_pct: {
      [bundle.team_a]: prediction.team_a_pct,
      [bundle.team_b]: prediction.team_b_pct,
      draw:            prediction.draw_pct,
    },
    h2h_records:     h2hSample.length > 0 ? h2hSample : ["No H2H records available"],
    team_a_form:     formSampleA.length > 0 ? formSampleA : ["No recent form records"],
    team_b_form:     formSampleB.length > 0 ? formSampleB : ["No recent form records"],
    team_a_stats:    statsA ? {
      form_string:   statsA.form_string,
      win_rate:      statsA.win_rate,
      home_win_rate: statsA.home_win_rate,
      away_win_rate: statsA.away_win_rate,
      goals_for_avg: statsA.goals_for_avg,
    } : null,
    team_b_stats:    statsB ? {
      form_string:   statsB.form_string,
      win_rate:      statsB.win_rate,
      home_win_rate: statsB.home_win_rate,
      away_win_rate: statsB.away_win_rate,
      goals_for_avg: statsB.goals_for_avg,
    } : null,
    match_notes:     notesSample.length > 0 ? notesSample : ["No match reports available"],
    data_warnings:   bundle.data_warnings,
  };

  const completion = await groq.chat.completions.create({
    model: MODEL,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: SYSTEM },
      { role: "user",   content: `Evidence:\n${JSON.stringify(evidence, null, 2)}` },
    ],
    temperature: 0.15,
    max_tokens: 600,
  });

  const raw = JSON.parse(completion.choices[0]?.message?.content ?? "{}");

  return [
    raw.insight_1 ?? "Insufficient historical data — primary factor evidence unavailable.",
    raw.insight_2 ?? "Insufficient historical data — form trend evidence unavailable.",
    raw.insight_3 ?? "Insufficient historical data — venue/competition evidence unavailable.",
  ];
}
