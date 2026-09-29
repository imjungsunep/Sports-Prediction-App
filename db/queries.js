/**
 * db/queries.js
 * Typed query functions for structured retrieval.
 * All functions are synchronous (node:sqlite DatabaseSync).
 * Uses $param syntax for named parameters (node:sqlite convention).
 */

// ─── Team lookups ─────────────────────────────────────────────────────────────

/**
 * Resolve a team name (case-insensitive, partial match fallback) to its DB id.
 * Returns null if no match found.
 * @param {import("node:sqlite").DatabaseSync} db
 * @param {string} name
 * @returns {number|null}
 */
export function getTeamId(db, name) {
  const exact = db.prepare("SELECT id FROM teams WHERE name = $name COLLATE NOCASE").get({ name });
  if (exact) return exact.id;
  const partial = db.prepare("SELECT id FROM teams WHERE name LIKE $pattern COLLATE NOCASE LIMIT 1").get({ pattern: `%${name}%` });
  return partial ? partial.id : null;
}

/**
 * @param {import("node:sqlite").DatabaseSync} db
 * @param {string} name
 * @returns {object|null}
 */
export function getTeamByName(db, name) {
  const row = db.prepare("SELECT id, name, short_name, country FROM teams WHERE name = $name COLLATE NOCASE").get({ name });
  if (row) return row;
  return db.prepare("SELECT id, name, short_name, country FROM teams WHERE name LIKE $pattern COLLATE NOCASE LIMIT 1").get({ pattern: `%${name}%` }) ?? null;
}

/**
 * @param {import("node:sqlite").DatabaseSync} db
 * @returns {object[]}
 */
export function getAllTeams(db) {
  return db.prepare("SELECT id, name, short_name, country FROM teams ORDER BY name").all();
}

// ─── Head-to-head ─────────────────────────────────────────────────────────────

/**
 * Return up to `limit` H2H matches between teamA and teamB (either as home or away),
 * most recent first. Each row includes source provenance.
 *
 * @param {import("node:sqlite").DatabaseSync} db
 * @param {string} teamA
 * @param {string} teamB
 * @param {number} [limit=20]
 * @returns {object[]}
 */
export function getHeadToHead(db, teamA, teamB, limit = 20) {
  const idA = getTeamId(db, teamA);
  const idB = getTeamId(db, teamB);
  if (idA === null || idB === null) return [];

  return db.prepare(`
    SELECT
      m.id,
      m.match_date,
      c.name  AS competition,
      s.label AS season,
      ht.name AS home_team,
      at.name AS away_team,
      m.home_goals,
      m.away_goals,
      m.result,
      v.name  AS venue,
      src.name        AS source_name,
      src.url         AS source_url,
      src.retrieved_at
    FROM matches m
    JOIN teams   ht  ON ht.id  = m.home_team_id
    JOIN teams   at  ON at.id  = m.away_team_id
    LEFT JOIN competitions c ON c.id = m.competition_id
    LEFT JOIN seasons      s ON s.id = m.season_id
    LEFT JOIN venues       v ON v.id = m.venue_id
    LEFT JOIN match_sources ms ON ms.match_id = m.id
    LEFT JOIN sources      src ON src.id = ms.source_id
    WHERE
      (m.home_team_id = $idA AND m.away_team_id = $idB)
      OR
      (m.home_team_id = $idB AND m.away_team_id = $idA)
    ORDER BY m.match_date DESC
    LIMIT $limit
  `).all({ idA, idB, limit });
}

// ─── Team form ────────────────────────────────────────────────────────────────

/**
 * Return last-N matches for a team, most recent first.
 *
 * @param {import("node:sqlite").DatabaseSync} db
 * @param {string} team
 * @param {number} [n=5]
 * @param {'home'|'away'|'all'} [venue='all']
 * @returns {object[]}
 */
export function getTeamForm(db, team, n = 5, venue = "all") {
  const teamId = getTeamId(db, team);
  if (teamId === null) return [];

  let whereExtra = "";
  if (venue === "home") whereExtra = " AND m.home_team_id = $teamId";
  if (venue === "away") whereExtra = " AND m.away_team_id = $teamId";

  return db.prepare(`
    SELECT
      m.id,
      m.match_date,
      c.name  AS competition,
      s.label AS season,
      ht.name AS home_team,
      at.name AS away_team,
      m.home_goals,
      m.away_goals,
      m.result,
      v.name  AS venue,
      src.name        AS source_name,
      src.url         AS source_url,
      src.retrieved_at,
      CASE
        WHEN m.home_team_id = $teamId THEN
          CASE m.result WHEN 'H' THEN 'W' WHEN 'A' THEN 'L' ELSE 'D' END
        ELSE
          CASE m.result WHEN 'A' THEN 'W' WHEN 'H' THEN 'L' ELSE 'D' END
      END AS team_result,
      CASE WHEN m.home_team_id = $teamId THEN m.home_goals ELSE m.away_goals END AS goals_for,
      CASE WHEN m.home_team_id = $teamId THEN m.away_goals ELSE m.home_goals END AS goals_against
    FROM matches m
    JOIN teams   ht  ON ht.id  = m.home_team_id
    JOIN teams   at  ON at.id  = m.away_team_id
    LEFT JOIN competitions c ON c.id = m.competition_id
    LEFT JOIN seasons      s ON s.id = m.season_id
    LEFT JOIN venues       v ON v.id = m.venue_id
    LEFT JOIN match_sources ms ON ms.match_id = m.id
    LEFT JOIN sources      src ON src.id = ms.source_id
    WHERE (m.home_team_id = $teamId OR m.away_team_id = $teamId)
    ${whereExtra}
    ORDER BY m.match_date DESC
    LIMIT $n
  `).all({ teamId, n });
}

// ─── Aggregated team statistics ───────────────────────────────────────────────

/**
 * Compute aggregate statistics for a team over their last N matches.
 * Returns a stats object, or null if the team is not found.
 *
 * @param {import("node:sqlite").DatabaseSync} db
 * @param {string} team
 * @param {number} [n=10]
 * @returns {object|null}
 */
export function getTeamStats(db, team, n = 10) {
  const teamId = getTeamId(db, team);
  if (teamId === null) return null;

  const rows = getTeamForm(db, team, n, "all");
  if (rows.length === 0) return null;

  let wins = 0, draws = 0, losses = 0;
  let goalsFor = 0, goalsAgainst = 0;
  let homeWins = 0, homeMatches = 0;
  let awayWins = 0, awayMatches = 0;
  const formChars = [];

  for (const row of rows) {
    const isHome = row.home_team.toLowerCase() === team.toLowerCase();
    if (isHome) {
      homeMatches++;
      if (row.result === "H") { wins++; homeWins++; }
      else if (row.result === "D") draws++;
      else losses++;
    } else {
      awayMatches++;
      if (row.result === "A") { wins++; awayWins++; }
      else if (row.result === "D") draws++;
      else losses++;
    }
    goalsFor     += row.goals_for;
    goalsAgainst += row.goals_against;
    formChars.push(row.team_result);
  }

  const played = rows.length;
  const dates  = rows.map(r => r.match_date).sort();

  return {
    team,
    matches_played:    played,
    wins,
    draws,
    losses,
    goals_for:         goalsFor,
    goals_against:     goalsAgainst,
    goals_for_avg:     played > 0 ? +(goalsFor / played).toFixed(2)     : 0,
    goals_against_avg: played > 0 ? +(goalsAgainst / played).toFixed(2) : 0,
    win_rate:          played > 0 ? +(wins / played).toFixed(3)          : 0,
    home_win_rate:     homeMatches > 0 ? +(homeWins / homeMatches).toFixed(3)  : 0,
    away_win_rate:     awayMatches > 0 ? +(awayWins / awayMatches).toFixed(3)  : 0,
    home_matches:      homeMatches,
    away_matches:      awayMatches,
    form_string:       formChars.join(""),
    data_range_start:  dates[0] ?? null,
    data_range_end:    dates[dates.length - 1] ?? null,
  };
}

// ─── Match notes (semantic retrieval source) ──────────────────────────────────

/**
 * Fetch match notes for a list of match IDs.
 * @param {import("node:sqlite").DatabaseSync} db
 * @param {number[]} matchIds
 * @returns {object[]}
 */
export function getMatchNotes(db, matchIds) {
  if (!matchIds || matchIds.length === 0) return [];
  const placeholders = matchIds.map(() => "?").join(",");
  return db.prepare(`
    SELECT mn.match_id, mn.content, s.name AS source_name
    FROM match_notes mn
    LEFT JOIN sources s ON s.id = mn.source_id
    WHERE mn.match_id IN (${placeholders})
    ORDER BY mn.match_id
  `).all(...matchIds);
}

// ─── Data health ──────────────────────────────────────────────────────────────

/**
 * Return a summary of what data is available in the database.
 * @param {import("node:sqlite").DatabaseSync} db
 * @returns {object}
 */
export function getDataHealth(db) {
  const totals = db.prepare(`
    SELECT
      COUNT(*)                                              AS total_matches,
      MIN(match_date)                                       AS earliest_match,
      MAX(match_date)                                       AS latest_match,
      SUM(CASE WHEN home_shots IS NOT NULL THEN 1 ELSE 0 END) AS matches_with_shots
    FROM matches
  `).get();

  const teams        = db.prepare("SELECT COUNT(*) AS n FROM teams").get();
  const competitions = db.prepare("SELECT COUNT(*) AS n FROM competitions").get();
  const notes        = db.prepare("SELECT COUNT(DISTINCT match_id) AS n FROM match_notes").get();

  return {
    total_matches:      totals.total_matches,
    total_teams:        teams.n,
    total_competitions: competitions.n,
    earliest_match:     totals.earliest_match ?? null,
    latest_match:       totals.latest_match   ?? null,
    matches_with_notes: notes.n,
    matches_with_shots: totals.matches_with_shots,
  };
}

// ─── Fixture list (paginated) ─────────────────────────────────────────────────

/**
 * Return a paginated list of matches.
 * @param {import("node:sqlite").DatabaseSync} db
 * @param {object} opts
 * @returns {{ rows: object[], total: number, page: number, pageSize: number }}
 */
export function getFixtures(db, { team, competition, page = 1, pageSize = 20 } = {}) {
  const conditions = [];
  const params     = {};

  if (team) {
    const teamId = getTeamId(db, team);
    if (teamId !== null) {
      conditions.push("(m.home_team_id = $teamId OR m.away_team_id = $teamId)");
      params.teamId = teamId;
    }
  }
  if (competition) {
    conditions.push("c.name LIKE $competition COLLATE NOCASE");
    params.competition = `%${competition}%`;
  }

  const where = conditions.length ? "WHERE " + conditions.join(" AND ") : "";
  const offset = (page - 1) * pageSize;

  const base = `
    FROM matches m
    JOIN teams   ht  ON ht.id  = m.home_team_id
    JOIN teams   at  ON at.id  = m.away_team_id
    LEFT JOIN competitions c ON c.id = m.competition_id
    LEFT JOIN seasons      s ON s.id = m.season_id
    LEFT JOIN venues       v ON v.id = m.venue_id
    ${where}
  `;

  const total = db.prepare(`SELECT COUNT(*) AS n ${base}`).get(params).n;

  const rows = db.prepare(`
    SELECT
      m.id, m.match_date,
      c.name  AS competition,
      s.label AS season,
      ht.name AS home_team,
      at.name AS away_team,
      m.home_goals,
      m.away_goals,
      m.result,
      v.name  AS venue
    ${base}
    ORDER BY m.match_date DESC
    LIMIT $pageSize OFFSET $offset
  `).all({ ...params, pageSize, offset });

  return { rows, total, page, pageSize };
}
