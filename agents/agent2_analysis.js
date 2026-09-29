/**
 * agents/agent2_analysis.js
 *
 * Agent 2 — Performance Analysis
 *
 * LLM call. Receives the retrieval bundle and interprets the retrieved
 * evidence into momentum labels and a tactical summary. It does NOT invent
 * statistics — all numbers come from the bundle.
 */

import Groq from "groq-sdk";

const groq  = new Groq({ apiKey: process.env.GROQ_API_KEY });
const MODEL = process.env.GROQ_MODEL ?? "llama3-8b-8192";

const SYSTEM = `You are a football performance analyst.
You are given RETRIEVED HISTORICAL DATA for two teams. Do not invent statistics.
Your job is to interpret the provided numbers only.

Return this exact JSON (no markdown):
{
  "team_a_momentum": "Positive" | "Neutral" | "Negative",
  "team_b_momentum": "Positive" | "Neutral" | "Negative",
  "team_a_momentum_score": <float -1 to 1>,
  "team_b_momentum_score": <float -1 to 1>,
  "venue_advantage": "<one sentence citing the specific home/away records provided>",
  "key_matchup_advantage": "<one sentence citing specific retrieved H2H or form data>",
  "tactical_summary": "<two sentences citing evidence from the retrieved records only>"
}
Rules:
- Every claim must reference a specific number from the retrieved data.
- If a field has no supporting data, write "Insufficient historical data."
- String values ≤200 characters each.`;

/**
 * @param {object} bundle - RetrievalBundle from agent1
 * @returns {Promise<object>} performance vectors
 */
export async function agent2_performanceAnalysis(bundle) {
  // Build a compact evidence summary to pass to the LLM
  const statsA = bundle.team_a_stats;
  const statsB = bundle.team_b_stats;

  const evidence = {
    team_a: bundle.team_a,
    team_b: bundle.team_b,
    venue_host: bundle.venue_host ?? "neutral",
    team_a_recent_form: bundle.team_a_form.slice(0, 5).map(r => ({
      date:   r.match_date,
      match:  `${r.home_team} ${r.home_goals}-${r.away_goals} ${r.away_team}`,
      result: r.team_result,
    })),
    team_b_recent_form: bundle.team_b_form.slice(0, 5).map(r => ({
      date:   r.match_date,
      match:  `${r.home_team} ${r.home_goals}-${r.away_goals} ${r.away_team}`,
      result: r.team_result,
    })),
    team_a_stats: statsA ? {
      matches: statsA.matches_played,
      wins: statsA.wins, draws: statsA.draws, losses: statsA.losses,
      goals_for_avg: statsA.goals_for_avg,
      goals_against_avg: statsA.goals_against_avg,
      win_rate: statsA.win_rate,
      home_win_rate: statsA.home_win_rate,
      away_win_rate: statsA.away_win_rate,
      form_string: statsA.form_string,
    } : null,
    team_b_stats: statsB ? {
      matches: statsB.matches_played,
      wins: statsB.wins, draws: statsB.draws, losses: statsB.losses,
      goals_for_avg: statsB.goals_for_avg,
      goals_against_avg: statsB.goals_against_avg,
      win_rate: statsB.win_rate,
      home_win_rate: statsB.home_win_rate,
      away_win_rate: statsB.away_win_rate,
      form_string: statsB.form_string,
    } : null,
    h2h_summary: `${bundle.head_to_head.length} H2H records available`,
    data_warnings: bundle.data_warnings,
  };

  const completion = await groq.chat.completions.create({
    model: MODEL,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: SYSTEM },
      { role: "user",   content: `Retrieved data:\n${JSON.stringify(evidence, null, 2)}` },
    ],
    temperature: 0.1,
    max_tokens: 800,
  });

  const raw = JSON.parse(completion.choices[0]?.message?.content ?? "{}");

  // Ensure required fields exist
  return {
    team_a_momentum:       raw.team_a_momentum       ?? "Neutral",
    team_b_momentum:       raw.team_b_momentum       ?? "Neutral",
    team_a_momentum_score: raw.team_a_momentum_score ?? 0,
    team_b_momentum_score: raw.team_b_momentum_score ?? 0,
    venue_advantage:       raw.venue_advantage        ?? "Insufficient historical data.",
    key_matchup_advantage: raw.key_matchup_advantage  ?? "Insufficient historical data.",
    tactical_summary:      raw.tactical_summary       ?? "Insufficient historical data.",
  };
}
