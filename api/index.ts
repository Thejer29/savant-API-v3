import type { VercelRequest, VercelResponse } from '@vercel/node';
import axios from 'axios';
import { parse } from 'csv-parse/sync';

// --- CONFIGURATION ---
const SEASON_YEAR = "2025"; 
// 1. NHL Official (Truth for Record, GP, GF/GA)
const NHL_STANDINGS_URL = "https://api-web.nhle.com/v1/standings/now";
// 2. MoneyPuck (Truth for xG, HDCF, Corsi)
const MONEYPUCK_TEAMS_URL = `https://moneypuck.com/moneypuck/playerData/seasonSummary/${SEASON_YEAR}/regular/teams.csv`;

// --- CACHE ---
let cachedMoneyPuck: any = null;
let cachedNhlStandings: any = null;
let lastFetchTime = 0;
const CACHE_DURATION = 1000 * 60 * 30; // 30 Minutes

// --- TEAM NORMALIZER ---
const normalizeTeamCode = (input: string) => {
  if (!input) return "UNK";
  const clean = input.toUpperCase().trim();
  
  const map: Record<string, string> = {
    "S.J": "SJS", "SJ": "SJS", "SAN JOSE SHARKS": "SJS",
    "T.B": "TBL", "TB": "TBL", "TAMPA BAY LIGHTNING": "TBL",
    "L.A": "LAK", "LA": "LAK", "LOS ANGELES KINGS": "LAK",
    "N.J": "NJD", "NJ": "NJD", "NEW JERSEY DEVILS": "NJD",
    "NYR": "NYR", "NEW YORK RANGERS": "NYR", 
    "NYI": "NYI", "NEW YORK ISLANDERS": "NYI",
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
    "ARI": "UTA", "UTA": "UTA", "UTAH HOCKEY CLUB": "UTA", "UTAH": "UTA",
    "EDM": "EDM", "EDMONTON OILERS": "EDM",
    "CGY": "CGY", "CALGARY FLAMES": "CGY",
    "ANA": "ANA", "ANAHEIM DUCKS": "ANA",
    "SEA": "SEA", "SEATTLE KRAKEN": "SEA"
  };
  return map[clean] || (clean.length === 3 ? clean : "UNK");
};

// --- HELPER: SAFE PARSER ---
const getFloat = (row: any, keys: string[]) => {
  if (!row) return 0;
  for (const key of keys) {
    if (row[key] !== undefined && row[key] !== null && row[key] !== "") {
      const val = parseFloat(row[key]);
      if (!isNaN(val)) return val;
    }
  }
  return 0;
};

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // CORS Headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { home, away, action } = req.query;
  
  // --- 1. SCHEDULE PROXY (Optional) ---
  if (action === "schedule") {
     // ... (You can remove this block if you handle schedule elsewhere, 
     // but keeping it minimal here prevents 404s if app still calls it)
     return res.status(200).json({ games: [], message: "Schedule moved to Frontend" });
  }

  // --- 2. STATS ENGINE ---
  if (!home || !away) return res.status(400).json({ error: "Missing teams" });
  
  // Helper to handle array params from Vercel
  const pHome = Array.isArray(home) ? home[0] : home;
  const pAway = Array.isArray(away) ? away[0] : away;
  const homeCode = normalizeTeamCode(pHome);
  const awayCode = normalizeTeamCode(pAway);

  const currentTime = Date.now();
  const axiosConfig = { headers: { 'User-Agent': 'Mozilla/5.0' } };

  try {
    // FETCH DATA SOURCES
    if (!cachedTeamStats || (currentTime - lastFetchTime > CACHE_DURATION)) {
      console.log("Fetching Stats Sources...");
      const [mpRes, nhlRes] = await Promise.all([
        axios.get(MONEYPUCK_TEAMS_URL, axiosConfig),
        axios.get(NHL_STANDINGS_URL)
      ]);
      cachedMoneyPuck = parse(mpRes.data, { columns: true, skip_empty_lines: true });
      cachedNhlStandings = nhlRes.data.standings;
      lastFetchTime = currentTime;
    }

    const getStats = (code: string) => {
      // 1. FIND ROWS
      const row5v5 = cachedMoneyPuck.find((r: any) => normalizeTeamCode(r.team) === code && r.situation === "5on5");
      const rowAll = cachedMoneyPuck.find((r: any) => normalizeTeamCode(r.team) === code && r.situation === "all");
      const rowPP  = cachedMoneyPuck.find((r: any) => normalizeTeamCode(r.team) === code && r.situation === "5on4");
      const rowPK  = cachedMoneyPuck.find((r: any) => normalizeTeamCode(r.team) === code && r.situation === "4on5");
      
      // 2. NHL OFFICIAL STANDINGS (For GP/Record)
      const nhlRow = cachedNhlStandings.find((t: any) => normalizeTeamCode(t.teamAbbrev.default) === code);

      if (!row5v5 || !nhlRow) return { name: code, error: "Data Not Found" };

      const gp = nhlRow.gamesPlayed;
      
      // 3. CALCULATIONS
      
      // Power Play % (Use raw counts from 5on4 row)
      // MoneyPuck: 'goalsFor' in 5on4 row is PP Goals. 'fenwickFor' is a good proxy for opportunity if 'penaltiesDrawn' is messy.
      // Best Method: Use NHL Standings data if MoneyPuck fails, but let's calculate hard.
      const ppGoals = getFloat(rowPP, ['goalsFor', 'GF']);
      // MoneyPuck 'penaltiesDrawn' is in 'all' row
      const ppOpps = getFloat(rowAll, ['penaltiesDrawn', 'penaltiesDrawnPer60']);
      const ppPct = ppOpps > 0 ? (ppGoals / ppOpps) * 100 : 0;

      // Penalty Kill %
      const pkGoalsAgainst = getFloat(rowPK, ['goalsAgainst', 'GA']);
      const pkOpps = getFloat(rowAll, ['penaltiesTaken', 'penaltiesTakenPer60']);
      const pkPct = pkOpps > 0 ? 100 - ((pkGoalsAgainst / pkOpps) * 100) : 100;

      // HDCF% (Using Flurry Adjusted xG as proxy for Chances)
      const hdFor = getFloat(row5v5, ['flurryAdjustedxGoalsFor']); 
      const hdAg = getFloat(row5v5, ['flurryAdjustedxGoalsAgainst']);
      const hdcf = (hdFor + hdAg) > 0 ? (hdFor / (hdFor + hdAg)) * 100 : 50;

      // Standard Stats
      const gfPerGame = nhlRow.goalFor / gp;
      const gaPerGame = nhlRow.goalAgainst / gp;
      
      // PIMs (Use 'all' row)
      const pims = getFloat(rowAll, ['penaltiesMinutes', 'pim', 'penalityMinutes']);

      return {
        name: code,
        // Rate Stats
        gfPerGame: gfPerGame,
        gaPerGame: gaPerGame,
        // Engine Stats (5v5)
        xgfPercent: getFloat(row5v5, ['xGoalsPercentage']) * 100,
        xgaPer60: (getFloat(row5v5, ['xGoalsAgainst']) / (getFloat(row5v5, ['iceTime']) || 1)) * 3600,
        hdcfPercent: hdcf,
        corsiPercent: getFloat(row5v5, ['corsiPercentage']) * 100,
        // Special Teams & Context
        ppPercent: ppPct,
        pkPercent: pkPct,
        pimsPerGame: pims / gp,
        faceoffPercent: getFloat(rowAll, ['faceOffWinPercentage']) * 100,
        shootingPercent: getFloat(row5v5, ['shootingPercentage']) * 100,
        pdo: getFloat(row5v5, ['PDO','pdo']) * 100
      };
    };

    return
