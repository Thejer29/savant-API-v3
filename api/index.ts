import type { VercelRequest, VercelResponse } from '@vercel/node';
import axios from 'axios';
import { parse } from 'csv-parse/sync';

// --- CONFIGURATION ---
const SEASON_YEAR = "2025"; // Current Season
const MONEYPUCK_TEAMS_URL = `https://moneypuck.com/moneypuck/playerData/seasonSummary/${SEASON_YEAR}/regular/teams.csv`;

// --- CACHE ---
let cachedTeamStats: any = null;
let lastFetchTime = 0;
const CACHE_DURATION = 1000 * 60 * 60; // 1 Hour (Stats don't change mid-game)

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

// --- SAFE PARSER (The Column Hunter) ---
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
  // CORS Headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const { home, away } = req.query;
  const pHome = Array.isArray(home) ? home[0] : home;
  const pAway = Array.isArray(away) ? away[0] : away;
  const currentTime = Date.now();

  if (!pHome || !pAway) return res.status(400).json({ error: "Missing teams" });

  const axiosConfig = {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'application/json,text/csv'
    }
  };

  try {
    // 1. FETCH DATA (MoneyPuck Teams Only)
    if (!cachedTeamStats || (currentTime - lastFetchTime > CACHE_DURATION)) {
      console.log(`Fetching MoneyPuck Data...`);
      const response = await axios.get(MONEYPUCK_TEAMS_URL, axiosConfig);
      cachedTeamStats = parse(response.data, { columns: true, skip_empty_lines: true });
      lastFetchTime = currentTime;
    }

    const targetHome = normalizeTeamCode(pHome);
    const targetAway = normalizeTeamCode(pAway);

    // 2. EXTRACTOR LOGIC
    const getSavantStats = (code: string) => {
      // We need 5v5 for Process Stats and All Situations for Rate Stats
      const row5v5 = cachedTeamStats.find((r: any) => normalizeTeamCode(r.team) === code && r.situation === "5on5");
      const rowAll = cachedTeamStats.find((r: any) => normalizeTeamCode(r.team) === code && r.situation === "all");
      
      if (!row5v5 || !rowAll) return null;

      const iceAll = getFloat(rowAll, ['iceTime', 'icetime']) || 1;
      const ice5v5 = getFloat(row5v5, ['iceTime', 'icetime']) || 1;
      const gamesPlayed = getFloat(rowAll, ['gamesPlayed', 'GP']) || 1;

      // Special Teams Calculations (Explicit Columns)
      const ppGoals = getFloat(rowAll, ['ppGoalsFor', 'fiveOnFourGoalsFor']);
      const ppOpps = getFloat(rowAll, ['penaltiesDrawn', 'penaltiesDrawnPer60']) || 1;
      const ppPercent = ppOpps > 0 ? (ppGoals / ppOpps) * 100 : 0;

      const pkGoalsAgainst = getFloat(rowAll, ['ppGoalsAgainst', 'fiveOnFourGoalsAgainst']);
      const pkOpps = getFloat(rowAll, ['penaltiesTaken', 'penaltiesTakenPer60']) || 1;
      const pkPercent = pkOpps > 0 ? 100 - ((pkGoalsAgainst / pkOpps) * 100) : 100;

      // PIMs Per Game
      const pims = getFloat(rowAll, ['penaltiesMinutes', 'pim', 'penalityMinutes']);
      const pimsPerGame = pims / gamesPlayed;

      return {
        name: code,
        // Base Strength (All Situations)
        gfPerGame: (getFloat(rowAll, ['goalsFor', 'GF']) / iceAll) * 3600,
        gaPerGame: (getFloat(rowAll, ['goalsAgainst', 'GA']) / iceAll) * 3600,
        
        // Play Driving (5v5 Only)
        xgaPer60: (getFloat(row5v5, ['xGoalsAgainst', 'xGA']) / ice5v5) * 3600,
        xgfPercent: getFloat(row5v5, ['xGoalsPercentage', 'xGF%']) * 100,
        hdcfPercent: (getFloat(row5v5, ['highDangerGoalsFor', 'HDGF', 'highDangerShotsFor']) / 
                     (getFloat(row5v5, ['highDangerGoalsFor', 'HDGF', 'highDangerShotsFor']) + getFloat(row5v5, ['highDangerGoalsAgainst', 'HDGA', 'highDangerShotsAgainst']))) * 100 || 50,
        
        // Special Teams & Discipline
        ppPercent: ppPercent,
        pkPercent: pkPercent,
        pimsPerGame: pimsPerGame,
        
        // Context Stats
        faceoffPercent: getFloat(rowAll, ['faceOffWinPercentage', 'faceOffsWonPercentage', 'FOW%']) * 100,
        shootingPercent: getFloat(row5v5, ['shootingPercentage', 'shootingPercentage5on5']) * 100,
        corsiPercent: getFloat(row5v5, ['corsiPercentage', 'CF%']) * 100,
        
        // Added Context: PDO (Luck)
        pdo: getFloat(row5v5, ['PDO', 'pdo']) * 100
      };
    };

    return res.status(200).json({
      home: getSavantStats(targetHome),
      away: getSavantStats(targetAway)
      // No odds, no goalies returned
    });

  } catch (e) {
    return res.status(500).json({ error: String(e) });
  }
}
