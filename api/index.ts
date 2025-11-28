const axios = require('axios');
const { parse } = require('csv-parse/sync');

// --- DATA SOURCES ---
const ESPN_SCOREBOARD_URL = "https://site.api.espn.com/apis/site/v2/sports/hockey/nhl/scoreboard";
const MONEYPUCK_TEAMS_URL = "https://moneypuck.com/moneypuck/playerData/seasonSummary/2024/regular/teams.csv";
const MONEYPUCK_GOALIES_URL = "https://moneypuck.com/moneypuck/playerData/seasonSummary/2024/regular/goalies.csv";
const NHL_SCHEDULE_URL = "https://api-web.nhle.com/v1/schedule/now";

// --- CACHE ---
let cachedTeamStats = null;
let cachedGoalieStats = null;
let cachedStarterData = null;
let lastStatsFetch = 0;
let lastStarterFetch = 0;
const STATS_CACHE = 1000 * 60 * 60; // 1 Hour

// --- HELPER ---
const normalizeTeamCode = (input) => {
  if (!input) return "UNK";
  const map = {
    "S.J": "SJS", "SJ": "SJS", "San Jose Sharks": "SJS",
    "T.B": "TBL", "TB": "TBL", "Tampa Bay Lightning": "TBL",
    "L.A": "LAK", "LA": "LAK", "Los Angeles Kings": "LAK",
    "N.J": "NJD", "NJ": "NJD", "New Jersey Devils": "NJD",
    "NYR": "NYR", "New York Rangers": "NYR", 
    "NYI": "NYI", "New York Islanders": "NYI",
    "VEG": "VGK", "VGK": "VGK", "Vegas Golden Knights": "VGK",
    "MTL": "MTL", "Montreal Canadiens": "MTL",
    "VAN": "VAN", "Vancouver Canucks": "VAN",
    "TOR": "TOR", "Toronto Maple Leafs": "TOR",
    "BOS": "BOS", "Boston Bruins": "BOS",
    "BUF": "BUF", "Buffalo Sabres": "BUF",
    "OTT": "OTT", "Ottawa Senators": "OTT",
    "FLA": "FLA", "Florida Panthers": "FLA",
    "DET": "DET", "Detroit Red Wings": "DET",
    "PIT": "PIT", "Pittsburgh Penguins": "PIT",
    "WSH": "WSH", "Washington Capitals": "WSH",
    "PHI": "PHI", "Philadelphia Flyers": "PHI",
    "CBJ": "CBJ", "Columbus Blue Jackets": "CBJ",
    "CAR": "CAR", "Carolina Hurricanes": "CAR",
    "CHI": "CHI", "Chicago Blackhawks": "CHI",
    "NSH": "NSH", "Nashville Predators": "NSH",
    "STL": "STL", "St. Louis Blues": "STL",
    "MIN": "MIN", "Minnesota Wild": "MIN",
    "WPG": "WPG", "Winnipeg Jets": "WPG",
    "COL": "COL", "Colorado Avalanche": "COL",
    "DAL": "DAL", "Dallas Stars": "DAL",
    "ARI": "UTA", "UTA": "UTA", "Utah Hockey Club": "UTA",
    "EDM": "EDM", "Edmonton Oilers": "EDM",
    "CGY": "CGY", "Calgary Flames": "CGY",
    "ANA": "ANA", "Anaheim Ducks": "ANA",
    "SEA": "SEA", "Seattle Kraken": "SEA"
  };
  return map[input] || input.substring(0, 3).toUpperCase();
};

const getFloat = (row, keys) => {
  for (const key of keys) {
    if (row[key] !== undefined && row[key] !== null && row[key] !== "") {
      const val = parseFloat(row[key]);
      if (!isNaN(val)) return val;
    }
  }
  return 0;
};

module.exports = async (req, res) => {
  // --- CORS HEADERS (CRITICAL FOR AI STUDIO) ---
  res.setHeader('Access-Control-Allow-Origin', '*'); // Allow ANY site to call this
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  // Handle Preflight Request
  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  const { home, away, homeGoalie, awayGoalie, action, date } = req.query;
  const currentTime = Date.now();
  
  // Headers to spoof browser
  const axiosConfig = {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'application/json,text/csv'
    }
  };

  // --- 1. SCHEDULE MODE ---
  if (action === "schedule") {
    try {
      const cleanDate = date ? date.replace(/-/g, "") : "";
      const url = cleanDate ? `${ESPN_SCOREBOARD_URL}?dates=${cleanDate}` : ESPN_SCOREBOARD_URL;
      const espnRes = await axios.get(url, axiosConfig);
      
      const games = (espnRes.data.events || []).map((evt) => {
        const competition = evt.competitions[0];
        const homeComp = competition.competitors.find((c) => c.homeAway === 'home');
        const awayComp = competition.competitors.find((c) => c.homeAway === 'away');
        return {
          id: evt.id,
          date: evt.date,
          status: evt.status.type.shortDetail,
          homeTeam: { name: homeComp.team.displayName, code: normalizeTeamCode(homeComp.team.abbreviation), score: homeComp.score },
          awayTeam: { name: awayComp.team.displayName, code: normalizeTeamCode(awayComp.team.abbreviation), score: awayComp.score }
        };
      });
      res.status(200).json({ games });
      return;
    } catch (e) {
      res.status(500).json({ error: "Schedule Error", details: e.toString() });
      return;
    }
  }

  // --- 2. STATS MODE ---
  if (!home || !away) {
    res.status(400).json({ error: "Missing home/away" });
    return;
  }

  try {
    // Fetch Stats (Cache)
    if (!cachedTeamStats || (currentTime - lastStatsFetch > STATS_CACHE)) {
      const [mpTeams, mpGoalies] = await Promise.all([
        axios.get(MONEYPUCK_TEAMS_URL, axiosConfig),
        axios.get(MONEYPUCK_GOALIES_URL, axiosConfig)
      ]);
      cachedTeamStats = parse(mpTeams.data, { columns: true, skip_empty_lines: true });
      cachedGoalieStats = parse(mpGoalies.data, { columns: true, skip_empty_lines: true });
      lastStatsFetch = currentTime;
    }

    // Fetch Starters (Cache)
    if (!cachedStarterData || (currentTime - lastStarterFetch > (1000 * 60 * 15))) {
       try {
         const nhlRes = await axios.get(NHL_SCHEDULE_URL);
         cachedStarterData = {};
         (nhlRes.data.gameWeek?.[0]?.games || []).forEach((game) => {
             if(game.awayTeam.startingGoalie) cachedStarterData[normalizeTeamCode(game.awayTeam.abbrev)] = game.awayTeam.startingGoalie;
             if(game.homeTeam.startingGoalie) cachedStarterData[normalizeTeamCode(game.homeTeam.abbrev)] = game.homeTeam.startingGoalie;
         });
         lastStarterFetch = currentTime;
       } catch(e) {}
    }

    // Fetch Odds (Live)
    let gameOdds = { source: "ESPN", line: "OFF", total: "6.5" };
    try {
       const cleanDate = date ? date.replace(/-/g, "") : "";
       const url = cleanDate ? `${ESPN_SCOREBOARD_URL}?dates=${cleanDate}` : ESPN_SCOREBOARD_URL;
       const espnRes = await axios.get(url, axiosConfig);
       const game = espnRes.data.events?.find((evt) => {
          const c = evt.competitions[0].competitors;
          return (normalizeTeamCode(c[0].team.abbreviation) === normalizeTeamCode(home) && 
                  normalizeTeamCode(c[1].team.abbreviation) === normalizeTeamCode(away)) ||
                 (normalizeTeamCode(c[0].team.abbreviation) === normalizeTeamCode(away) && 
                  normalizeTeamCode(c[1].team.abbreviation) === normalizeTeamCode(home));
       });
       if (game?.competitions?.[0]?.odds?.[0]) {
          gameOdds = { 
            source: "ESPN", 
            line: game.competitions[0].odds[0].details, 
            total: game.competitions[0].odds[0].overUnder 
          };
       }
    } catch(e) {}

    // Extract
    const getSavantStats = (code, reqGoalie) => {
       const row = cachedTeamStats.find((r) => normalizeTeamCode(r.team) === code && r.situation === "5on5");
       const allRow = cachedTeamStats.find((r) => normalizeTeamCode(r.team) === code && r.situation === "all");
       if (!row) return null;

       // Goalie
       let gName = reqGoalie;
       let status = "Unconfirmed";
       if (!gName && cachedStarterData?.[code]) {
          gName = `${cachedStarterData[code].firstName.default} ${cachedStarterData[code].lastName.default}`;
          status = "Confirmed";
       }
       
       const teamGoalies = cachedGoalieStats.filter(g => normalizeTeamCode(g.team) === code);
       let gRow = gName ? teamGoalies.find(g => g.name.toLowerCase().includes(gName.toLowerCase().split(" ").pop())) : null;
       
       // Fallback to #1
       if (!gRow && teamGoalies.length > 0) {
          teamGoalies.sort((a,b) => getFloat(b, ['gamesPlayed']) - getFloat(a, ['gamesPlayed']));
          gRow = teamGoalies[0];
          status = "Projected #1";
       }

       const iceAll = getFloat(allRow, ['iceTime']) || 1;
       const ice5v5 = getFloat(row, ['iceTime']) || 1;

       return {
          name: code,
          gfPerGame: (getFloat(allRow, ['goalsFor']) / iceAll) * 3600,
          gaPerGame: (getFloat(allRow, ['goalsAgainst']) / iceAll) * 3600,
          xgaPer60: (getFloat(row, ['xGoalsAgainst']) / ice5v5) * 3600,
          xgfPercent: getFloat(row, ['xGoalsPercentage']) * 100,
          hdcfPercent: (getFloat(row, ['highDangerShotsFor']) / (getFloat(row, ['highDangerShotsFor']) + getFloat(row, ['highDangerShotsAgainst']))) * 100 || 50,
          ppPercent: (getFloat(allRow, ['ppGoalsFor']) / getFloat(allRow, ['penaltiesDrawn'])) * 100 || 0,
          pkPercent: 100 - ((getFloat(allRow, ['ppGoalsAgainst']) / getFloat(allRow, ['penaltiesTaken'])) * 100 || 0),
          pimsPerGame: (getFloat(allRow, ['penaltiesMinutes']) / iceAll) * 3600,
          corsiPercent: getFloat(row, ['corsiPercentage']) * 100,
          faceoffPercent: getFloat(allRow, ['faceOffWinPercentage']) * 100,
          goalie: {
             name: gRow?.name || "Unknown",
             gsax: gRow ? (getFloat(gRow, ['goalsSavedAboveExpected']) / (getFloat(gRow, ['iceTime'])||1)) * 3600 : 0,
             svPct: gRow ? getFloat(gRow, ['savePercentage']) : 0.900,
             gaa: gRow ? (getFloat(gRow, ['goalsAgainst']) * 3600) / (getFloat(gRow, ['iceTime'])||1) : 3.0,
             status
          }
       };
    };

    res.status(200).json({
      home: getSavantStats(normalizeTeamCode(home), homeGoalie),
      away: getSavantStats(normalizeTeamCode(away), awayGoalie),
      odds: gameOdds
    });

  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
};
