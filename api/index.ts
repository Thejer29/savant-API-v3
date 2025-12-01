import type { VercelRequest, VercelResponse } from '@vercel/node';
import axios from 'axios';
import { parse } from 'csv-parse/sync';

// --- DATA SOURCES ---
// 1. NHL Official (Best for Record, Goals, L10, Streaks)
const NHL_STANDINGS_URL = "https://api-web.nhle.com/v1/standings/now";
// 2. MoneyPuck (Best for xG, HDCF) - Year 2025
const MONEYPUCK_TEAMS_URL = "https://moneypuck.com/moneypuck/playerData/seasonSummary/2025/regular/teams.csv";
// 3. ESPN (Best for Live Odds)
const ESPN_SCOREBOARD_URL = "https://site.api.espn.com/apis/site/v2/sports/hockey/nhl/scoreboard";

// --- CACHE ---
let cachedMoneyPuck: any = null;
let cachedNhlStandings: any = null;
let lastFetchTime = 0;
const CACHE_DURATION = 1000 * 60 * 30; // 30 Minutes

// --- HELPER: DATE ---
const getHockeyDate = () => new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" }).replace(/-/g, "");

// --- HELPER: NORMALIZE TEAM CODES ---
const normalizeTeamCode = (input: string) => {
  if (!input) return "UNK";
  const clean = input.toUpperCase().trim();
  const map: Record<string, string> = {
    "S.J": "SJS", "SJ": "SJS", "SAN JOSE SHARKS": "SJS",
    "T.B": "TBL", "TB": "TBL", "TAMPA BAY LIGHTNING": "TBL",
    "L.A": "LAK", "LA": "LAK", "LOS ANGELES KINGS": "LAK",
    "N.J": "NJD", "NJ": "NJD", "NEW JERSEY DEVILS": "NJD",
    "NYR": "NYR", "NEW YORK RANGERS": "NYR", "NYI": "NYI", "NEW YORK ISLANDERS": "NYI",
    "VEG": "VGK", "VGK": "VGK", "VEGAS GOLDEN KNIGHTS": "VGK",
    "MTL": "MTL", "MONTREAL CANADIENS": "MTL",
    "VAN": "VAN", "VANCOUVER CANUCKS": "VAN",
    "TOR": "TOR", "TORONTO MAPLE LEAFS": "TOR",
    "BOS": "BOS", "BOSTON BRUINS": "BOS",
    "BUF": "BUF", "BUFFALO SABRES": "BUF",
    "OTT": "OTT", "OTTAWA SENATORS": "OTT",
    "FLA": "FLA", "FLORIDA PANTHERS": "FLA",
    "DET": "DET", "DETROIT RED WINGS": "DET",
    "PIT": "PIT", "PITTSBURGH PENGUINS": "PIT",
    "WSH": "WSH", "WASHINGTON CAPITALS": "WSH",
    "PHI": "PHI", "PHILADELPHIA FLYERS": "PHI",
    "CBJ": "CBJ", "COLUMBUS BLUE JACKETS": "CBJ",
    "CAR": "CAR", "CAROLINA HURRICANES": "CAR",
    "CHI": "CHI", "CHICAGO BLACKHAWKS": "CHI",
    "NSH": "NSH", "NASHVILLE PREDATORS": "NSH",
    "STL": "STL", "ST. LOUIS BLUES": "STL",
    "MIN": "MIN", "MINNESOTA WILD": "MIN",
    "WPG": "WPG", "WINNIPEG JETS": "WPG",
    "COL": "COL", "COLORADO AVALANCHE": "COL",
    "DAL": "DAL", "DALLAS STARS": "DAL",
    "ARI": "UTA", "UTA": "UTA", "UTAH HOCKEY CLUB": "UTA",
    "EDM": "EDM", "EDMONTON OILERS": "EDM",
    "CGY": "CGY", "CALGARY FLAMES": "CGY",
    "ANA": "ANA", "ANAHEIM DUCKS": "ANA",
    "SEA": "SEA", "SEATTLE KRAKEN": "SEA"
  };
  return map[clean] || (clean.length === 3 ? clean : "UNK");
};

// --- HELPER: SAFE NUMBER ---
const getFloat = (row: any, keys: string[]) => {
  for (const key of keys) {
    if (row[key] !== undefined && row[key] !== null && row[key] !== "") {
      const val = parseFloat(row[key]);
      if (!isNaN(val)) return val;
    }
  }
  return 0;
};

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { home, away, action, date } = req.query;
  const pAction = Array.isArray(action) ? action[0] : action;
  const pDate = Array.isArray(date) ? date[0] : date;
  
  const axiosConfig = {
    headers: { 'User-Agent': 'Mozilla/5.0' }
  };

  try {
    // --- 1. SCHEDULE MODE ---
    if (pAction === "schedule") {
        const targetDate = pDate ? pDate.replace(/-/g, "") : getHockeyDate();
        const espnRes = await axios.get(`${ESPN_SCOREBOARD_URL}?dates=${targetDate}`, axiosConfig);
        const games = (espnRes.data.events || []).map((evt: any) => {
            const c = evt.competitions[0];
            return {
                id: evt.id,
                date: evt.date,
                status: evt.status.type.shortDetail,
                homeTeam: { name: c.competitors[0].team.displayName, code: normalizeTeamCode(c.competitors[0].team.abbreviation) },
                awayTeam: { name: c.competitors[1].team.displayName, code: normalizeTeamCode(c.competitors[1].team.abbreviation) }
            };
        });
        return res.status(200).json({ games, count: games.length, date: targetDate });
    }

    // --- 2. STATS MODE ---
    if (!home || !away) return res.status(400).json({ error: "Missing teams" });
    const homeCode = normalizeTeamCode(home as string);
    const awayCode = normalizeTeamCode(away as string);

    const currentTime = Date.now();

    // FETCH: MoneyPuck (Advanced) & NHL (Standard)
    if (!cachedMoneyPuck || (currentTime - lastFetchTime > CACHE_DURATION)) {
        console.log("Fetching Data Sources...");
        const [mpRes, nhlRes] = await Promise.all([
            axios.get(MONEYPUCK_TEAMS_URL, axiosConfig),
            axios.get(NHL_STANDINGS_URL)
        ]);
        cachedMoneyPuck = parse(mpRes.data, { columns: true, skip_empty_lines: true });
        cachedNhlStandings = nhlRes.data.standings;
        lastFetchTime = currentTime;
    }

    // FETCH: Odds (Live)
    let gameOdds = { source: "ESPN", line: "OFF", total: "6.5" };
    try {
        const oddsDate = getHockeyDate();
        const espnRes = await axios.get(`${ESPN_SCOREBOARD_URL}?dates=${oddsDate}`, axiosConfig);
        const game = espnRes.data.events?.find((evt: any) => {
           const c = evt.competitions[0].competitors;
           const h = normalizeTeamCode(c[0].team.abbreviation);
           const a = normalizeTeamCode(c[1].team.abbreviation);
           return (h === homeCode && a === awayCode) || (h === awayCode && a === homeCode);
        });
        if(game?.competitions?.[0]?.odds?.[0]) {
           gameOdds = { source: "ESPN", line: game.competitions[0].odds[0].details || "OFF", total: game.competitions[0].odds[0].overUnder || "6.5" };
        }
    } catch(e) {}

    const getStats = (code: string) => {
        // A. MoneyPuck (Advanced 5v5)
        const mpRow = cachedMoneyPuck.find((r: any) => normalizeTeamCode(r.team) === code && r.situation === "5on5");
        const mpAll = cachedMoneyPuck.find((r: any) => normalizeTeamCode(r.team) === code && r.situation === "all");

        // B. NHL Official (Standard)
        const nhlRow = cachedNhlStandings.find((t: any) => normalizeTeamCode(t.teamAbbrev.default) === code);

        if (!mpRow || !nhlRow) return { name: code, error: "Data Missing" };

        // C. Calculations
        const gamesPlayed = nhlRow.gamesPlayed;
        const goalsFor = nhlRow.goalFor;
        const goalsAgainst = nhlRow.goalAgainst;
        
        // Special Teams (MoneyPuck All Situations is best for raw counts)
        // MoneyPuck 'fiveOnFourGoalsFor' = PP Goals
        const ppGoals = getFloat(mpAll, ['fiveOnFourGoalsFor', 'ppGoalsFor']);
        const ppOpps = getFloat(mpAll, ['penaltiesDrawn']);
        const ppPct = ppOpps > 0 ? (ppGoals / ppOpps) * 100 : 0;

        const pkGoalsAgainst = getFloat(mpAll, ['fourOnFiveGoalsAgainst', 'ppGoalsAgainst']);
        const pkOpps = getFloat(mpAll, ['penaltiesTaken']);
        const pkPct = pkOpps > 0 ? 100 - ((pkGoalsAgainst / pkOpps) * 100) : 0;

        // HDCF% Fix (Using xGoals from High Danger vs Total High Danger xG)
        // This aligns closer to NST's "Chances" model
        const hdFor = getFloat(mpRow, ['flurryAdjustedxGoalsFor']); 
        const hdAg = getFloat(mpRow, ['flurryAdjustedxGoalsAgainst']);
        const hdcf = (hdFor + hdAg) > 0 ? (hdFor / (hdFor + hdAg)) * 100 : 50;

        return {
            name: code,
            // Standard (From NHL.com - Reliable)
            gfPerGame: goalsFor / gamesPlayed,
            gaPerGame: goalsAgainst / gamesPlayed,
            ppPercent: ppPct,
            pkPercent: pkPct,
            pimsPerGame: (getFloat(mpAll, ['penaltiesMinutes']) / gamesPlayed),
            faceoffPercent: getFloat(mpAll, ['faceOffWinPercentage']) * 100,

            // Advanced (From MoneyPuck 5v5)
            xgfPercent: getFloat(mpRow, ['xGoalsPercentage']) * 100,
            xgaPer60: (getFloat(mpRow, ['xGoalsAgainst']) / getFloat(mpRow, ['iceTime'])) * 3600,
            hdcfPercent: hdcf, 
            corsiPercent: getFloat(mpRow, ['corsiPercentage']) * 100,
            shootingPercent: getFloat(mpRow, ['shootingPercentage']) * 100,
        };
    };

    return res.status(200).json({
        home: getStats(homeCode),
        away: getStats(awayCode),
        odds: gameOdds
    });

  } catch (e) {
    return res.status(500).json({ error: String(e) });
  }
                       }
