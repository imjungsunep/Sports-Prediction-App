# Football Historical Match Data — Seed Dataset

## Source

| Field          | Value |
|----------------|-------|
| **Dataset**    | Curated fixture from publicly available match records |
| **Competitions** | English Premier League (EPL) 2022/23 & 2023/24; UEFA Euro 2024; UEFA Champions League 2023/24; FIFA World Cup Qualifiers 2023/24; International Friendlies |
| **Record count** | ~95 matches |
| **Date range** | August 2022 – July 2024 |
| **Retrieved** | 2024-07-15 |
| **License**    | Public domain match results (scores, dates, venues are factual events and not copyrightable) |

## Original data sources consulted

- [football-data.co.uk](https://www.football-data.co.uk/) — Free historical EPL results CSV
- [UEFA official results](https://www.uefa.com/uefaeuro/history/) — Euro 2024 scores
- [FIFA.com results](https://www.fifa.com/en/match-centre) — International fixtures
- [Premier League official](https://www.premierleague.com/results) — Official EPL results

## Columns

| Column | Description |
|--------|-------------|
| `match_date` | ISO-8601 date of the match |
| `competition` | Competition name (EPL, UEFA Euro 2024, etc.) |
| `season` | Season label (e.g. 2023/24) |
| `home_team` | Home team name (canonical) |
| `away_team` | Away team name (canonical) |
| `home_goals` | Goals scored by home team |
| `away_goals` | Goals scored by away team |
| `home_shots` | Shots (home team, where available) |
| `away_shots` | Shots (away team, where available) |
| `home_shots_on_target` | Shots on target (home) |
| `away_shots_on_target` | Shots on target (away) |
| `home_corners` | Corners (home) |
| `away_corners` | Corners (away) |
| `home_fouls` | Fouls committed (home) |
| `away_fouls` | Fouls committed (away) |
| `home_yellow_cards` | Yellow cards (home) |
| `away_yellow_cards` | Yellow cards (away) |
| `home_red_cards` | Red cards (home) |
| `away_red_cards` | Red cards (away) |
| `venue` | Stadium/ground name |
| `notes` | Brief match notes / report snippet |

## Extending the dataset

To add more records, append rows to `football_historical.csv` and re-run:

```bash
node data/seed.js
```

The seeder is idempotent — duplicate rows (same date + home_team + away_team) are skipped.
