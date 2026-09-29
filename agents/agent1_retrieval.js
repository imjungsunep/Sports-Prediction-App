/**
 * agents/agent1_retrieval.js
 *
 * Agent 1 — Historical Record Lookup
 *
 * This is NOT an LLM call. It performs genuine retrieval from the local
 * SQLite database and returns a typed RetrievalBundle. The name "Agent 1"
 * is retained for pipeline UI continuity.
 *
 * Returns null if the database has no records at all (e.g. seed not run).
 */

import { retrieve } from "../retrieval/retrievalService.js";

/**
 * @param {object} input
 * @param {string} input.team_a
 * @param {string} input.team_b
 * @param {'team_a'|'team_b'|null} [input.venue_host]
 * @param {string} [input.dbPath]  - override for tests
 * @returns {import('../retrieval/retrievalService.js').RetrievalBundle}
 */
export async function agent1_retrieval(input) {
  // retrieve() is synchronous (better-sqlite3), wrapped in async for pipeline consistency
  const bundle = retrieve({
    team_a:     input.team_a,
    team_b:     input.team_b,
    venue_host: input.venue_host ?? null,
    dbPath:     input.dbPath,
  });
  return bundle;
}
