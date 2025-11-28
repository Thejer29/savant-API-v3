import type { VercelRequest, VercelResponse } from '@vercel/node';
import axios from 'axios';
import { parse } from 'csv-parse/sync';

// --- DATA SOURCES ---
const ESPN_SCOREBOARD_URL = "https://site.api.espn.com/apis/site/v2/sports/hockey/nhl/scoreboard";
const MONEYPUCK_TEAMS_URL = "https://moneypuck.com/moneypuck/playerData/seasonSummary/2024/regular/teams.csv";
const MONEYPUCK_GOALIES_URL = "https://moneypuck.com/moneypuck/playerData/seasonSummary/2024/regular/goalies.csv";
const NHL_SCHEDULE_URL = "https://api-web.nhle.com/v1/schedule/now";

// --- CACHE ---
// Vercel reuses instances, so this cache works for warm starts
let cachedTeamStats: any = null;
let cachedGoalieStats: any = null;
let cachedEspnData: any = null;
let cachedStarterData: any = null;

let lastStatsFetch = 0;
let lastOddsFetch = 0;
let lastStarterFetch = 0;

const STATS_CACHE = 1000 * 60 * 60; // 1 Hour
const ODDS_CACHE = 1000 * 60 * 5;   // 5 Minutes
const STARTER_CACHE = 1000 * 60 * 15; // 15 Minutes

// --- HELPER: SAFE NUMBER PARSER ---
const getFloat = (row: any, keys: string[]) => {
  for (const key of keys) {
    if (row[key] !== undefined && row[key] !== null && row[key] !== "") {
      const val = parseFloat(row[key]);
      if (!isNaN(val)) return val;
    }
  }
  return 0;
};

// --- TEAM MAPPING HELPER ---
const normalizeTeamCode = (input: string) => {
  if (!input) return "UNK";
  const map: Record<string, string> = {
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
  
  // If input is already 3 chars, assume it's a code, otherwise standardize
  if (input.length === 3 && !map[input]) return input.toUpperCase();
  return map[input] || input.substring(0, 3).toUpperCase();
};

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // 1. PARSE QUERY PARAMS (Vercel style)
  const { home, away, homeGoalie, awayGoalie, action, date } = req.query;
  
  // Helper to ensure string
  const str = (v: string | string[] | undefined) => Array.isArray(v) ? v[0] : v || "";
  
  const pAction = str(action);
  const pDate = str(date);
  
  const currentTime = Date.now();

  // CONFIG: Spoof Browser
  const axiosConfig = {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'application/json,text/csv'
    }
  };

  // ==========================================
  // MODE A: SCHEDULE
  // ==========================================
  if (pAction === "schedule") {
    try {
      // Fix Date Format: 2025-11-28 -> 20251128
      const cleanDate = pDate ? pDate.replace(/-/g, "") : "";
      const url = cleanDate ? `${ESPN_SCOREBOARD_URL}?dates=${cleanDate}` : ESPN_SCOREBOARD_URL;
      
      const espnRes = await axios.get(url, axiosConfig);
      const events = espnRes.data.events || [];

      const games = events.map((evt: any) => {
        const competition = evt.competitions[0];
        const homeComp = competition.competitors.find((c: any) => c.homeAway === 'home');
        const awayComp = competition.competitors.find((c: any) => c.homeAway === 'away');
        
        return {
          id: evt.id,
          date: evt.date,
          status: evt.status.type.shortDetail, 
          homeTeam: {
            name: homeComp.team.displayName,
            code: normalizeTeamCode(homeComp.team.abbreviation),
            score: homeComp.score,
            logo: homeComp.team.logo
          },
          awayTeam: {
            name: awayComp.team.displayName,
            code: normalizeTeamCode(awayComp.team.abbreviation),
            score: awayComp.score,
            logo: awayComp.team.logo
          }
        };
      });

      return res.status(200).json({ games, count: games.length, dateUsed: cleanDate });
    } catch (error) {
      return res.status(500).json({ error: "Schedule Fetch Failed", details: String(error) });
    }
  }

  // ==========================================
  // MODE B: GAME STATS
  // ==========================================
  if (!home || !away) {
    return res.status(400).json({ error: "Missing 'home' or 'away' parameters." });
  }

  const targetHome = normalizeTeamCode(str(home));
  const targetAway = normalizeTeamCode(str(away));

  try {
    // 1. FETCH MONEYPUCK STATS
    if (!cachedTeamStats || (currentTime - lastStatsFetch > STATS_CACHE)) {
      console.log("Fetching MoneyPuck Stats...");
      const [mpTeamsRes, mpGoaliesRes] = await Promise.all([
        axios.get(MONEYPUCK_TEAMS_URL, axiosConfig),
        axios.get(MONEYPUCK_GOALIES_URL, axiosConfig)
      ]);
      cachedTeamStats = parse(mpTeamsRes.data, { columns: true, skip_empty_lines: true });
      cachedGoalieStats = parse(mpGoaliesRes.data, { columns: true, skip_empty_lines: true });
      lastStatsFetch = currentTime;
    }

    // 2. FETCH STARTERS (NHL)
    if (!cachedStarterData || (currentTime - lastStarterFetch > STARTER_CACHE)) {
      try {
        const nhlRes = await axios.get(NHL_SCHEDULE_URL);
        const todayGames = nhlRes.data.gameWeek?.[0]?.games || [];
        cachedStarterData = {};
        todayGames.forEach((game: any) => {
           const mapGoalie = (g: any) => ({
               name: `${g.firstName.default} ${g.lastName.default}`,
               status: "Confirmed"
           });
           if(game.awayTeam.startingGoalie) cachedStarterData[normalizeTeamCode(game.awayTeam.abbrev)] = mapGoalie(game.awayTeam.startingGoalie);
           if(game.homeTeam.startingGoalie) cachedStarterData[normalizeTeamCode(game.homeTeam.abbrev)] = mapGoalie(game.homeTeam.startingGoalie);
        });
        lastStarterFetch = currentTime;
      } catch (e) { console.log("Starter fetch failed"); }
    }

    // 3. FETCH ODDS (ESPN)
    let gameOdds = null;
    if (!cachedEspnData || (currentTime - lastOddsFetch > ODDS_CACHE)) {
       try {
         // Use date if provided, else default
         const cleanDate = pDate ? pDate.replace(/-/g, "") : "";
         const url = cleanDate ? `${ESPN_SCOREBOARD_URL}?dates=${cleanDate}` : ESPN_SCOREBOARD_URL;
         const espnRes = await axios.get(url, axiosConfig);
         cachedEspnData = espnRes.data;
         lastOddsFetch = currentTime;
       } catch (e) { console.log("Odds fetch failed"); }
    }

    // Match Odds Logic
    if (cachedEspnData && cachedEspnData.events) {
      const game = cachedEspnData.events.find((evt: any) => {
        const competitors = evt.competitions[0].competitors;
        const teamA = normalizeTeamCode(competitors[0].team.abbreviation);
        const teamB = normalizeTeamCode(competitors[1].team.abbreviation);
        return (teamA === targetHome && teamB === targetAway) || 
               (teamA === targetAway && teamB === targetHome);
      });
      if (game) {
        const comp = game.competitions?.[0];
        const oddsObj = comp?.odds?.[0] || null;
        if (oddsObj) {
          gameOdds = {
            source: "ESPN (Live)",
            line: oddsObj.details || "N/A",
            total: oddsObj.overUnder || 6.5
          };
        }
      }
    }

    // 4. EXTRACT STATS
    const getSavantStats = (teamCode: string, requestedGoalie?: string) => {
      const teamRow = cachedTeamStats.find((row: any) => normalizeTeamCode(row.team) === teamCode && row.situation === "5on5");
      const teamAllRow = cachedTeamStats.find((row: any) => normalizeTeamCode(row.team) === teamCode && row.situation === "all");

      if (!teamRow) return null;

      // Goalie Logic
      let targetGoalieName = requestedGoalie;
      let starterStatus = "Unconfirmed";

      if (!targetGoalieName && cachedStarterData && cachedStarterData[teamCode]) {
          targetGoalieName = cachedStarterData[teamCode].name;
          starterStatus = cachedStarterData[teamCode].status;
      }

      const teamGoalies = cachedGoalieStats.filter((g: any) => normalizeTeamCode(g.team) === teamCode);
      let goalieRow = null;

      if (targetGoalieName) {
          goalieRow = teamGoalies.find((g: any) => g.name.toLowerCase().includes(targetGoalieName!.toLowerCase().split(" ").pop()!));
      }

      // Fallback: #1 Goalie by GP
      if (!goalieRow && teamGoalies.length > 0) {
          teamGoalies.sort((a: any, b: any) => getFloat(b, ['gamesPlayed']) - getFloat(a, ['gamesPlayed']));
          goalieRow = teamGoalies[0];
          starterStatus = "Projected #1";
      }

      let goalieStats = { gsax: 0, gaa: 0, svPct: 0.900, name: "Average Goalie" };
      if (goalieRow) {
          const gTime = getFloat(goalieRow, ['iceTime']) || 1;
          goalieStats = {
              name: goalieRow.name,
              gsax: (getFloat(goalieRow, ['goalsSavedAboveExpected']) / gTime) * 3600,
              gaa: (getFloat(goalieRow, ['goalsAgainst']) * 3600) / gTime,
              svPct: getFloat(goalieRow, ['savePercentage'])
          };
      }

      const iceTimeAll = getFloat(teamAllRow, ['iceTime']) || 1;
      const iceTime5v5 = getFloat(teamRow, ['iceTime']) || 1;
      
      // HDCF% Calculation
      const hdFor = getFloat(teamRow, ['highDangerShotsFor', 'highDangerGoalsFor', 'flurryAdjustedxGoalsFor']);
      const hdAg = getFloat(teamRow, ['highDangerShotsAgainst', 'highDangerGoalsAgainst', 'flurryAdjustedxGoalsAgainst']);
      const hdcf = (hdFor + hdAg) > 0 ? (hdFor / (hdFor + hdAg)) * 100 : 50;

      return {
        name: teamCode,
        gfPerGame: (getFloat(teamAllRow, ['goalsFor']) / iceTimeAll) * 3600,
        gaPerGame: (getFloat(teamAllRow, ['goalsAgainst']) / iceTimeAll) * 3600,
        xgaPer60: (getFloat(teamRow, ['xGoalsAgainst']) / iceTime5v5) * 3600,
        ppPercent: (getFloat(teamAllRow, ['ppGoalsFor']) / getFloat(teamAllRow, ['penaltiesDrawn'])) * 100 || 0,
        pkPercent: 100 - ((getFloat(teamAllRow, ['ppGoalsAgainst']) / getFloat(teamAllRow, ['penaltiesTaken'])) * 100 || 0),
        pimsPerGame: (getFloat(teamAllRow, ['penaltiesMinutes']) / (iceTimeAll / 3600)) || 8.0,
        xgfPercent: getFloat(teamRow, ['xGoalsPercentage']) * 100,
        hdcfPercent: hdcf,
        shootingPercent: getFloat(teamRow, ['shootingPercentage']) * 100,
        faceoffPercent: getFloat(teamAllRow, ['faceOffWinPercentage']) * 100,
        corsiPercent: getFloat(teamRow, ['corsiPercentage']) * 100,
        goalie: { ...goalieStats, status: starterStatus }
      };
    };

    return res.status(200).json({
      home: getSavantStats(targetHome, str(homeGoalie)),
      away: getSavantStats(targetAway, str(awayGoalie)),
      odds: gameOdds || { source: "Not Found", line: "OFF", total: "6.5" }
    });

  } catch (error) {
    return res.status(500).json({ error: "Engine Error", details: String(error) });
  }
}
