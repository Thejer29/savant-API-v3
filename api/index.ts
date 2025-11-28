import type { VercelRequest, VercelResponse } from '@vercel/node';
import axios from 'axios';
import { parse } from 'csv-parse/sync';

// --- DATA SOURCES ---
// CRITICAL: MoneyPuck uses the START YEAR for the URL.
// 2025-2026 Season = "2025"
const SEASON_YEAR = "2025"; 

const ESPN_SCOREBOARD_URL = "https://site.api.espn.com/apis/site/v2/sports/hockey/nhl/scoreboard";
const MONEYPUCK_TEAMS_URL = `https://moneypuck.com/moneypuck/playerData/seasonSummary/${SEASON_YEAR}/regular/teams.csv`;
const MONEYPUCK_GOALIES_URL = `https://moneypuck.com/moneypuck/playerData/seasonSummary/${SEASON_YEAR}/regular/goalies.csv`;
const NHL_SCHEDULE_URL = "https://api-web.nhle.com/v1/schedule/now";

// --- CACHE ---
let cachedTeamStats: any = null;
let cachedGoalieStats: any = null;
let cachedStarterData: any = null;
let lastFetchTime = 0;
const CACHE_DURATION = 1000 * 60 * 30; // 30 Minutes

// --- HELPER: GET CURRENT DATE (ET) ---
// Fixes the issue where Vercel (UTC) skips to tomorrow too early
const getHockeyDate = () => {
  return new Date().toLocaleDateString("en-CA", {
    timeZone: "America/New_York"
  }).replace(/-/g, ""); // Returns YYYYMMDD
};

// --- HELPER: NORMALIZE TEAM CODES ---
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

// --- HELPER: COLUMN HUNTER ---
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
  const { home, away, action, date } = req.query;
  const currentTime = Date.now();

  const pAction = Array.isArray(action) ? action[0] : action;
  const pDate = Array.isArray(date) ? date[0] : date;
  const pHome = Array.isArray(home) ? home[0] : home;
  const pAway = Array.isArray(away) ? away[0] : away;

  const axiosConfig = {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'application/json,text/csv'
    }
  };

  try {
    // --- FETCH & CACHE STATS ---
    if (!cachedTeamStats || (currentTime - lastFetchTime > CACHE_DURATION)) {
      console.log(`Fetching MoneyPuck Data for ${SEASON_YEAR}...`);
      const [mpTeams, mpGoalies] = await Promise.all([
        axios.get(MONEYPUCK_TEAMS_URL, axiosConfig),
        axios.get(MONEYPUCK_GOALIES_URL, axiosConfig)
      ]);
      cachedTeamStats = parse(mpTeams.data, { columns: true, skip_empty_lines: true });
      cachedGoalieStats = parse(mpGoalies.data, { columns: true, skip_empty_lines: true });
      lastFetchTime = currentTime;
    }

    // --- FETCH STARTERS ---
    if (!cachedStarterData) {
        try {
            const nhlRes = await axios.get(NHL_SCHEDULE_URL);
            const todayGames = nhlRes.data.gameWeek?.[0]?.games || [];
            cachedStarterData = {};
            todayGames.forEach((g: any) => {
                const mapGoalie = (goalie: any) => ({
                    name: `${goalie.firstName.default} ${goalie.lastName.default}`,
                    status: "Confirmed"
                });
                if(g.awayTeam.startingGoalie) cachedStarterData[normalizeTeamCode(g.awayTeam.abbrev)] = mapGoalie(g.awayTeam.startingGoalie);
                if(g.homeTeam.startingGoalie) cachedStarterData[normalizeTeamCode(g.homeTeam.abbrev)] = mapGoalie(g.homeTeam.startingGoalie);
            });
        } catch(e) { console.log("Starter fetch warning"); }
    }

    // --- MODE 1: SCHEDULE ---
    if (pAction === "schedule") {
      const targetDate = pDate ? pDate.replace(/-/g, "") : getHockeyDate();
      const url = `${ESPN_SCOREBOARD_URL}?dates=${targetDate}`;
      
      const espnRes = await axios.get(url, axiosConfig);
      const games = (espnRes.data.events || []).map((evt: any) => {
        const c = evt.competitions[0];
        return {
          id: evt.id,
          date: evt.date,
          status: evt.status.type.shortDetail,
          homeTeam: { name: c.competitors[0].team.displayName, code: normalizeTeamCode(c.competitors[0].team.abbreviation), score: c.competitors[0].score },
          awayTeam: { name: c.competitors[1].team.displayName, code: normalizeTeamCode(c.competitors[1].team.abbreviation), score: c.competitors[1].score }
        };
      });
      return res.status(200).json({ games, count: games.length, date: targetDate });
    }

    // --- MODE 2: GAME STATS ---
    if (!pHome || !pAway) return res.status(400).json({ error: "Missing home/away" });
    
    const targetHome = normalizeTeamCode(pHome);
    const targetAway = normalizeTeamCode(pAway);

    // FETCH LIVE ODDS
    let gameOdds = { source: "ESPN", line: "OFF", total: "6.5" };
    try {
        const oddsDate = getHockeyDate(); // Ensure we look for TODAY'S odds
        const espnRes = await axios.get(`${ESPN_SCOREBOARD_URL}?dates=${oddsDate}`, axiosConfig);
        const game = espnRes.data.events?.find((evt: any) => {
           const c = evt.competitions[0].competitors;
           const h = normalizeTeamCode(c[0].team.abbreviation);
           const a = normalizeTeamCode(c[1].team.abbreviation);
           return (h === targetHome && a === targetAway) || (h === targetAway && a === targetHome);
        });
        if (game?.competitions?.[0]?.odds?.[0]) {
            gameOdds = { 
               source: "ESPN", 
               line: game.competitions[0].odds[0].details || "OFF", 
               total: game.competitions[0].odds[0].overUnder || "6.5"
            };
        }
    } catch(e) {}

    // EXTRACTOR LOGIC
    const getSavantStats = (code: string) => {
        // Find Stats (5v5 for xG, All for PP/PK)
        const row5v5 = cachedTeamStats.find((r: any) => normalizeTeamCode(r.team) === code && r.situation === "5on5");
        const rowAll = cachedTeamStats.find((r: any) => normalizeTeamCode(r.team) === code && r.situation === "all");
        
        if (!row5v5 || !rowAll) return null;

        const iceAll = getFloat(rowAll, ['iceTime', 'timeOnIce']) || 1;
        const ice5v5 = getFloat(row5v5, ['iceTime', 'timeOnIce']) || 1;

        // Goalie Logic
        const teamGoalies = cachedGoalieStats.filter((g: any) => normalizeTeamCode(g.team) === code);
        let gRow = null;
        let status = "Unconfirmed";
        
        // Check Confirmed Starter
        if (cachedStarterData?.[code]) {
            const starterName = cachedStarterData[code].name;
            // Fuzzy Match (Last name)
            gRow = teamGoalies.find((g: any) => g.name.toLowerCase().includes(starterName.toLowerCase().split(" ").pop()));
            if(gRow) status = "Confirmed";
        }
        
        // Fallback to #1 by Games Played
        if (!gRow && teamGoalies.length > 0) {
            teamGoalies.sort((a: any, b: any) => getFloat(b, ['gamesPlayed']) - getFloat(a, ['gamesPlayed']));
            gRow = teamGoalies[0];
            status = "Projected #1";
        }

        const gTime = gRow ? (getFloat(gRow, ['iceTime']) || 1) : 1;

        return {
            name: code,
            gfPerGame: (getFloat(rowAll, ['goalsFor', 'GF']) / iceAll) * 3600,
            gaPerGame: (getFloat(rowAll, ['goalsAgainst', 'GA']) / iceAll) * 3600,
            xgaPer60: (getFloat(row5v5, ['xGoalsAgainst', 'xGA']) / ice5v5) * 3600,
            xgfPercent: getFloat(row5v5, ['xGoalsPercentage', 'xGF%']) * 100,
            hdcfPercent: (getFloat(row5v5, ['highDangerGoalsFor', 'highDangerShotsFor']) / (getFloat(row5v5, ['highDangerGoalsFor', 'highDangerShotsFor']) + getFloat(row5v5, ['highDangerGoalsAgainst', 'highDangerShotsAgainst']))) * 100 || 50,
            
            // Special Teams (Using RAW COUNTS to avoid 0% bug)
            ppPercent: (getFloat(rowAll, ['ppGoalsFor', 'fiveOnFourGoalsFor']) / (getFloat(rowAll, ['penaltiesDrawn', 'penaltiesDrawn']) || 1)) * 100,
            pkPercent: 100 - ((getFloat(rowAll, ['ppGoalsAgainst', 'fiveOnFourGoalsAgainst']) / (getFloat(rowAll, ['penaltiesTaken', 'penaltiesTaken']) || 1)) * 100),
            pimsPerGame: (getFloat(rowAll, ['penaltiesMinutes', 'pim', 'penalityMinutes']) / iceAll) * 3600,
            
            faceoffPercent: getFloat(rowAll, ['faceOffWinPercentage', 'faceOffsWonPercentage']) * 100,
            shootingPercent: getFloat(row5v5, ['shootingPercentage', 'shootingPercentage5on5']) * 100,
            corsiPercent: getFloat(row5v5, ['corsiPercentage', 'shotAttemptsPercentage']) * 100,
            
            goalie: {
                name: gRow?.name || "Avg Goalie",
                gsax: gRow ? (getFloat(gRow, ['goalsSavedAboveExpected', 'xGoalsSaved']) / gTime) * 3600 : 0,
                svPct: gRow ? getFloat(gRow, ['savePercentage']) : 0.900,
                gaa: gRow ? (getFloat(gRow, ['goalsAgainst']) * 3600) / gTime : 2.90,
                status
            }
        };
    };

    return res.status(200).json({
        home: getSavantStats(normalizeTeamCode(home)),
        away: getSavantStats(normalizeTeamCode(away)),
        odds: gameOdds
    });

  } catch (e) {
    return res.status(500).json({ error: "API Error", details: String(e) });
  }
}
