import type { VercelRequest, VercelResponse } from '@vercel/node';
import axios from 'axios';
import { parse } from 'csv-parse/sync';

// --- CONFIGURATION ---
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

// --- DATE HELPER ---
const getHockeyDate = () => {
  return new Date().toLocaleDateString("en-CA", {
    timeZone: "America/New_York"
  }).replace(/-/g, ""); 
};

// --- TEAM NORMALIZER ---
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
    "ARI": "UTA", "UTA": "UTA", "UTAH HOCKEY CLUB": "UTA", "UTAH": "UTA",
    "EDM": "EDM", "EDMONTON OILERS": "EDM",
    "CGY": "CGY", "CALGARY FLAMES": "CGY",
    "ANA": "ANA", "ANAHEIM DUCKS": "ANA",
    "SEA": "SEA", "SEATTLE KRAKEN": "SEA"
  };
  return map[clean] || (clean.length === 3 ? clean : "UNK");
};

// --- SAFE PARSER ---
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
    // --- 1. FETCH MONEYPUCK ---
    if (!cachedTeamStats || (currentTime - lastFetchTime > CACHE_DURATION)) {
      console.log(`Fetching MoneyPuck Data...`);
      const [mpTeams, mpGoalies] = await Promise.all([
        axios.get(MONEYPUCK_TEAMS_URL, axiosConfig),
        axios.get(MONEYPUCK_GOALIES_URL, axiosConfig)
      ]);
      cachedTeamStats = parse(mpTeams.data, { columns: true, skip_empty_lines: true });
      cachedGoalieStats = parse(mpGoalies.data, { columns: true, skip_empty_lines: true });
      lastFetchTime = currentTime;
    }

    // --- 2. FETCH STARTERS ---
    if (!cachedStarterData) {
       try {
         const nhlRes = await axios.get(NHL_SCHEDULE_URL);
         const todayGames = nhlRes.data.gameWeek?.[0]?.games || [];
         cachedStarterData = {};
         todayGames.forEach((g: any) => {
             const mapG = (gl: any) => ({ 
                 name: `${gl.firstName.default} ${gl.lastName.default}`, 
                 status: "Confirmed" 
             });
             // Note: NHL API sends "probable" sometimes, we treat as confirmed for now
             if(g.awayTeam.startingGoalie) cachedStarterData[normalizeTeamCode(g.awayTeam.abbrev)] = mapG(g.awayTeam.startingGoalie);
             if(g.homeTeam.startingGoalie) cachedStarterData[normalizeTeamCode(g.homeTeam.abbrev)] = mapG(g.homeTeam.startingGoalie);
         });
       } catch(e) {}
    }

    // --- SCHEDULE MODE ---
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

    if (!pHome || !pAway) return res.status(400).json({ error: "Missing teams" });
    const targetHome = normalizeTeamCode(pHome);
    const targetAway = normalizeTeamCode(pAway);

    // --- GET ODDS ---
    let gameOdds = { source: "ESPN", line: "OFF", total: "6.5" };
    try {
      const oddsDate = getHockeyDate();
      const espnRes = await axios.get(`${ESPN_SCOREBOARD_URL}?dates=${oddsDate}`, axiosConfig);
      const game = espnRes.data.events?.find((evt: any) => {
        const c = evt.competitions[0].competitors;
        return (normalizeTeamCode(c[0].team.abbreviation) === targetHome && normalizeTeamCode(c[1].team.abbreviation) === targetAway) || 
               (normalizeTeamCode(c[0].team.abbreviation) === targetAway && normalizeTeamCode(c[1].team.abbreviation) === targetHome);
      });
      if(game?.competitions?.[0]?.odds?.[0]) {
         gameOdds = { source: "ESPN", line: game.competitions[0].odds[0].details || "OFF", total: game.competitions[0].odds[0].overUnder || "6.5" };
      }
    } catch(e) {}

    // --- EXTRACT STATS ---
    const getSavantStats = (code: string) => {
      // Find Specific Rows for Special Teams Logic
      const row5v5 = cachedTeamStats.find((r: any) => normalizeTeamCode(r.team) === code && r.situation === "5on5");
      const rowAll = cachedTeamStats.find((r: any) => normalizeTeamCode(r.team) === code && r.situation === "all");
      const rowPP = cachedTeamStats.find((r: any) => normalizeTeamCode(r.team) === code && r.situation === "5on4"); // Power Play Row
      const rowPK = cachedTeamStats.find((r: any) => normalizeTeamCode(r.team) === code && r.situation === "4on5"); // Penalty Kill Row
      
      if (!row5v5 || !rowAll) return null;

      const iceAll = getFloat(rowAll, ['iceTime', 'icetime']) || 1;
      const ice5v5 = getFloat(row5v5, ['iceTime', 'icetime']) || 1;

      // Special Teams Logic (Using Specific Situational Rows)
      // PP% = (5v4 Goals) / (Penalties Drawn)
      const ppGoals = rowPP ? getFloat(rowPP, ['goalsFor', 'GF']) : 0;
      const ppOpps = getFloat(rowAll, ['penaltiesDrawn', 'penaltiesDrawnPer60']) || 1; 
      const ppPercent = (ppGoals / ppOpps) * 100;

      // PK% = 1 - ((4v5 Goals Against) / (Penalties Taken))
      const pkGoalsAgainst = rowPK ? getFloat(rowPK, ['goalsAgainst', 'GA']) : 0;
      const pkOpps = getFloat(rowAll, ['penaltiesTaken', 'penaltiesTakenPer60']) || 1;
      const pkPercent = 100 - ((pkGoalsAgainst / pkOpps) * 100);

      // Goalie Logic
      const teamGoalies = cachedGoalieStats.filter((g: any) => normalizeTeamCode(g.team) === code);
      let gRow = null;
      let status = "Unconfirmed";

      if (cachedStarterData?.[code]) {
          gRow = teamGoalies.find((g: any) => g.name.toLowerCase().includes(cachedStarterData[code].name.split(" ").pop().toLowerCase()));
          if (gRow) status = "Confirmed";
      }

      if (!gRow && teamGoalies.length > 0) {
          // Sort by Ice Time
          teamGoalies.sort((a: any, b: any) => getFloat(b, ['iceTime']) - getFloat(a, ['iceTime']));
          gRow = teamGoalies[0];
          status = "Season Starter (Unconfirmed)";
      }

      return {
        name: code,
        gfPerGame: (getFloat(rowAll, ['goalsFor']) / iceAll) * 3600,
        gaPerGame: (getFloat(rowAll, ['goalsAgainst']) / iceAll) * 3600,
        xgaPer60: (getFloat(row5v5, ['xGoalsAgainst']) / ice5v5) * 3600,
        xgfPercent: getFloat(row5v5, ['xGoalsPercentage']) * 100,
        hdcfPercent: (getFloat(row5v5, ['highDangerGoalsFor']) / (getFloat(row5v5, ['highDangerGoalsFor']) + getFloat(row5v5, ['highDangerGoalsAgainst']))) * 100 || 50,
        
        // Corrected Special Teams
        ppPercent: ppPercent,
        pkPercent: pkPercent,
        pimsPerGame: (getFloat(rowAll, ['penaltiesMinutes']) / iceAll) * 3600,
        
        // Context Stats
        faceoffPercent: getFloat(rowAll, ['faceOffWinPercentage']) * 100,
        shootingPercent: getFloat(row5v5, ['shootingPercentage']) * 100,
        corsiPercent: getFloat(row5v5, ['corsiPercentage']) * 100,
        
        goalie: {
           name: gRow?.name || "Avg Goalie",
           gsax: gRow ? (getFloat(gRow, ['goalsSavedAboveExpected']) / (getFloat(gRow, ['iceTime'])||1)) * 3600 : 0,
           svPct: gRow ? getFloat(gRow, ['savePercentage']) : 0.900,
           gaa: gRow ? (getFloat(gRow, ['goalsAgainst']) * 3600) / (getFloat(gRow, ['iceTime'])||1) : 3.0,
           status
        }
      };
    };

    return res.status(200).json({
      home: getSavantStats(normalizeTeamCode(pHome)),
      away: getSavantStats(normalizeTeamCode(pAway)),
      odds: gameOdds
    });

  } catch (e) {
    return res.status(500).json({ error: String(e) });
  }
}                                                                      }
