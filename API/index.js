const axios = require('axios');
const { parse } = require('csv-parse/sync');

// --- CONFIGURATION ---
const SEASON_YEAR = "2025"; // 2025-2026 Season
const NHL_STANDINGS_URL = "https://api-web.nhle.com/v1/standings/now";
const MONEYPUCK_TEAMS_URL = `https://moneypuck.com/moneypuck/playerData/seasonSummary/${SEASON_YEAR}/regular/teams.csv`;

// --- CACHE ---
let cachedMoneyPuck = null;
let cachedNhlStandings = null;
let lastFetchTime = 0;
const CACHE_DURATION = 1000 * 60 * 30; // 30 Minutes

// --- HELPER: NORMALIZE TEAM CODES ---
const normalizeTeamCode = (input) => {
  if (!input) return "UNK";
  const clean = input.toUpperCase().trim();
  
  const map = {
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
const getFloat = (row, keys) => {
  if (!row) return 0;
  for (const key of keys) {
    if (row[key] !== undefined && row[key] !== null && row[key] !== "") {
      const val = parseFloat(row[key]);
      if (!isNaN(val)) return val;
    }
  }
  return 0;
};

module.exports = async (req, res) => {
  // CORS Headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { home, away } = req.query;
  
  // Helper to handle array params
  const pHome = Array.isArray(home) ? home[0] : home;
  const pAway = Array.isArray(away) ? away[0] : away;

  const currentTime = Date.now();
  const axiosConfig = { headers: { 'User-Agent': 'Mozilla/5.0' } };

  if (!pHome || !pAway) return res.status(400).json({ error: "Missing teams" });
  const homeCode = normalizeTeamCode(pHome);
  const awayCode = normalizeTeamCode(pAway);

  try {
    // FETCH DATA SOURCES
    if (!cachedMoneyPuck || (currentTime - lastFetchTime > CACHE_DURATION)) {
      console.log("Fetching Stats Sources...");
      const [mpRes, nhlRes] = await Promise.all([
        axios.get(MONEYPUCK_TEAMS_URL, axiosConfig),
        axios.get(NHL_STANDINGS_URL)
      ]);
      cachedMoneyPuck = parse(mpRes.data, { columns: true, skip_empty_lines: true });
      cachedNhlStandings = nhlRes.data.standings;
      lastFetchTime = currentTime;
    }

    const getStats = (code) => {
      // 1. FIND ROWS IN MONEYPUCK (Advanced)
      const row5v5 = cachedMoneyPuck.find((r) => normalizeTeamCode(r.team) === code && r.situation === "5on5");
      const rowAll = cachedMoneyPuck.find((r) => normalizeTeamCode(r.team) === code && r.situation === "all");
      
      // 2. FIND ROW IN NHL OFFICIAL (Standard)
      const nhlRow = cachedNhlStandings.find((t) => normalizeTeamCode(t.teamAbbrev.default) === code);

      if (!row5v5 || !nhlRow) return { name: code, error: "Data Not Found" };

      const gp = nhlRow.gamesPlayed;
      
      // 3. HYBRID STATS CALCULATION

      // Special Teams (Use NHL.com Official Data for Accuracy)
      // Note: NHL API provides raw percentages usually, or we calculate from counts
      const ppPct = (nhlRow.powerPlayPct || 0) * 100;
      const pkPct = (nhlRow.penaltyKillPct || 0) * 100;
      const gfPerGame = nhlRow.goalFor / gp;
      const gaPerGame = nhlRow.goalAgainst / gp;

      // PIMs (Use MoneyPuck 'all' row as NHL api PIMs structure varies)
      const pims = getFloat(rowAll, ['penaltiesMinutes', 'pim', 'penalityMinutes']);

      // HDCF% (MoneyPuck 5v5 Flurry Adjusted xG is the best proxy for Chance Quality)
      const hdFor = getFloat(row5v5, ['flurryAdjustedxGoalsFor', 'highDangerxGoalsFor']); 
      const hdAg = getFloat(row5v5, ['flurryAdjustedxGoalsAgainst', 'highDangerxGoalsAgainst']);
      const hdcf = (hdFor + hdAg) > 0 ? (hdFor / (hdFor + hdAg)) * 100 : 50;

      return {
        name: code,
        // Standard Stats (Source: NHL.com)
        gfPerGame: gfPerGame,
        gaPerGame: gaPerGame,
        ppPercent: ppPct,
        pkPercent: pkPct,
        
        // Advanced Stats (Source: MoneyPuck 5v5)
        xgfPercent: getFloat(row5v5, ['xGoalsPercentage', 'xGF%']) * 100,
        xgaPer60: (getFloat(row5v5, ['xGoalsAgainst']) / (getFloat(row5v5, ['iceTime']) || 1)) * 3600,
        hdcfPercent: hdcf,
        corsiPercent: getFloat(row5v5, ['corsiPercentage']) * 100,
        shootingPercent: getFloat(row5v5, ['shootingPercentage']) * 100,
        
        // Context
        pimsPerGame: pims / gp,
        faceoffPercent: getFloat(rowAll, ['faceOffWinPercentage']) * 100,
        pdo: getFloat(row5v5, ['PDO', 'pdo']) * 100
      };
    };

    return res.status(200).json({
      home: getStats(homeCode),
      away: getStats(awayCode),
      source: "Savant API v5 (Hybrid)"
    });

  } catch (e) {
    return res.status(500).json({ error: String(e) });
  }
};
