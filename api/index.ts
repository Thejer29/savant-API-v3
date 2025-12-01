const axios = require('axios');
const { parse } = require('csv-parse/sync');

// --- DATA SOURCES ---
const SEASON_YEAR = "2025"; 
const NHL_STANDINGS_URL = "https://api-web.nhle.com/v1/standings/now";
const MONEYPUCK_TEAMS_URL = `https://moneypuck.com/moneypuck/playerData/seasonSummary/${SEASON_YEAR}/regular/teams.csv`;
const ESPN_SCOREBOARD_URL = "https://site.api.espn.com/apis/site/v2/sports/hockey/nhl/scoreboard";

// --- CACHE ---
let cachedMoneyPuck = null;
let cachedNhlStandings = null;
let lastFetchTime = 0;
const CACHE_DURATION = 1000 * 60 * 30; // 30 Minutes

// --- HELPERS ---
const normalizeTeamCode = (input) => {
  if (!input) return "UNK";
  const clean = input.toUpperCase().trim();
  const map = {
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
    "ARI": "UTA", "UTA": "UTA", "UTAH HOCKEY CLUB": "UTA", "UTAH": "UTA",
    "EDM": "EDM", "EDMONTON OILERS": "EDM",
    "CGY": "CGY", "CALGARY FLAMES": "CGY",
    "ANA": "ANA", "ANAHEIM DUCKS": "ANA",
    "SEA": "SEA", "SEATTLE KRAKEN": "SEA"
  };
  return map[clean] || (clean.length === 3 ? clean : "UNK");
};

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

const getHockeyDate = () => {
  return new Date().toLocaleDateString("en-CA", {
    timeZone: "America/New_York"
  }).replace(/-/g, ""); 
};

module.exports = async (req, res) => {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const { home, away, action, date } = req.query;
  const pAction = Array.isArray(action) ? action[0] : action;
  const pDate = Array.isArray(date) ? date[0] : date;
  const currentTime = Date.now();

  const axiosConfig = {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'application/json,text/csv'
    }
  };

  try {
    // --- 1. SCHEDULE MODE ---
    if (pAction === "schedule") {
        const targetDate = pDate ? pDate.replace(/-/g, "") : getHockeyDate();
        const espnRes = await axios.get(`${ESPN_SCOREBOARD_URL}?dates=${targetDate}`, axiosConfig);
        const games = (espnRes.data.events || []).map((evt) => {
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
    const homeCode = normalizeTeamCode(Array.isArray(home) ? home[0] : home);
    const awayCode = normalizeTeamCode(Array.isArray(away) ? away[0] : away);

    // Fetch Data
    if (!cachedTeamStats || (currentTime - lastFetchTime > CACHE_DURATION)) {
        console.log("Fetching Data...");
        const [mpRes, nhlRes] = await Promise.all([
            axios.get(MONEYPUCK_TEAMS_URL, axiosConfig),
            axios.get(NHL_STANDINGS_URL)
        ]);
        cachedMoneyPuck = parse(mpRes.data, { columns: true, skip_empty_lines: true });
        cachedNhlStandings = nhlRes.data.standings;
        lastFetchTime = currentTime;
    }

    const getStats = (code) => {
      // MoneyPuck Rows
      const row5v5 = cachedMoneyPuck.find((r) => normalizeTeamCode(r.team) === code && r.situation === "5on5");
      const rowAll = cachedMoneyPuck.find((r) => normalizeTeamCode(r.team) === code && r.situation === "all");
      const rowPP  = cachedMoneyPuck.find((r) => normalizeTeamCode(r.team) === code && r.situation === "5on4");
      const rowPK  = cachedMoneyPuck.find((r) => normalizeTeamCode(r.team) === code && r.situation === "4on5");

      // NHL Official Row
      const nhlRow = cachedNhlStandings.find((t) => normalizeTeamCode(t.teamAbbrev.default) === code);

      if (!row5v5 || !nhlRow) return { name: code, error: "Data Missing" };

      const gp = nhlRow.gamesPlayed;
      const iceAll = getFloat(rowAll, ['iceTime', 'icetime']) || 1;
      const ice5v5 = getFloat(row5v5, ['iceTime', 'icetime']) || 1;

      // Special Teams Math
      const ppGoals = getFloat(rowPP, ['goalsFor', 'GF']);
      const ppOpps = getFloat(rowAll, ['penaltiesDrawn', 'penaltiesDrawnPer60']);
      const ppPct = ppOpps > 0 ? (ppGoals / ppOpps) * 100 : 0;

      const pkGoalsAgainst = getFloat(rowPK, ['goalsAgainst', 'GA']);
      const pkOpps = getFloat(rowAll, ['penaltiesTaken', 'penaltiesTakenPer60']);
      const pkPct = pkOpps > 0 ? 100 - ((pkGoalsAgainst / pkOpps) * 100) : 0;

      return {
        name: code,
        gfPerGame: nhlRow.goalFor / gp,
        gaPerGame: nhlRow.goalAgainst / gp,
        ppPercent: ppPct,
        pkPercent: pkPct,
        pimsPerGame: (getFloat(rowAll, ['penaltiesMinutes', 'pim', 'penalityMinutes']) / gp),
        faceoffPercent: getFloat(rowAll, ['faceOffWinPercentage', 'faceOffsWonPercentage']) * 100,
        
        // Advanced (MoneyPuck)
        xgfPercent: getFloat(row5v5, ['xGoalsPercentage', 'xGF%']) * 100,
        xgaPer60: (getFloat(row5v5, ['xGoalsAgainst']) / ice5v5) * 3600,
        hdcfPercent: (getFloat(row5v5, ['flurryAdjustedxGoalsFor']) / (getFloat(row5v5, ['flurryAdjustedxGoalsFor']) + getFloat(row5v5, ['flurryAdjustedxGoalsAgainst']))) * 100 || 50,
        corsiPercent: getFloat(row5v5, ['corsiPercentage']) * 100,
        shootingPercent: getFloat(row5v5, ['shootingPercentage']) * 100,
        pdo: getFloat(row5v5, ['PDO']) * 100
      };
    };

    return res.status(200).json({
      home: getStats(homeCode),
      away: getStats(awayCode),
      source: "Savant API (Hybrid)"
    });

  } catch (e) {
    return res.status(500).json({ error: "Internal Server Error", details: String(e) });
  }
};
