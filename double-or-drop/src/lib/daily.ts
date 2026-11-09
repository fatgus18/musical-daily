import type {Database,SqlExecutor} from "@musical-daily/database";
import type {Catalog} from "./catalog.ts";
import type {DailyChallenge,Game,Pair} from "./types.ts";
import {drawPair,pairKey} from "./rules.ts";

export const DAILY_PICKS=10;
export const utcDate=(now=Date.now())=>new Date(now).toISOString().slice(0,10);
export const dailyReset=(date:string)=>Date.parse(`${date}T00:00:00Z`)+86400000;

/** No player history, UUID or banking decision influences the shared daily sequence. */
export function buildDailyChallenge(catalog:Catalog,date=utcDate()):DailyChallenge{
  if(!/^\d{4}-\d{2}-\d{2}$/.test(date)||utcDate(Date.parse(`${date}T00:00:00Z`))!==date)throw new Error("Invalid challenge date.");
  const pairs:Pair[]=[],recentTracks:string[]=[],recentPairs:string[]=[];
  for(let round=0;round<DAILY_PICKS;round++){
    const pair=drawPair(catalog.tracks,{seed:`double-drop:daily:v1:${date}:${catalog.version}:${round}`,filter:"mixed",round,ladder:Math.min(4,Math.floor(round/2)),recentTracks,recentPairs,previousMetric:pairs.at(-1)?.metric});
    pairs.push(pair);recentTracks.push(pair.left.id,pair.right.id);recentPairs.push(pairKey(pair));
  }
  return {date,catalogVersion:catalog.version,pairs};
}

/** First publication wins across deployments and concurrent functions. The small, self-
 * contained pair snapshot survives replacement or cleanup of the broader catalog. */
export async function ensureDailyChallenge(db:Database,catalog:Catalog,date=utcDate()):Promise<DailyChallenge>{
  const existing=(await db.execute("SELECT payload FROM daily_challenges WHERE date=?",[date])).rows[0];
  if(existing)return JSON.parse(String(existing.payload));
  const candidate=buildDailyChallenge(catalog,date);
  await db.execute("INSERT OR IGNORE INTO daily_challenges(date,payload) VALUES(?,?)",[date,JSON.stringify(candidate)]);
  return JSON.parse(String((await db.execute("SELECT payload FROM daily_challenges WHERE date=?",[date])).rows[0].payload));
}

export async function findDailyGame(db:SqlExecutor,player:string,date=utcDate()):Promise<Game|null>{
  const row=(await db.execute("SELECT state FROM games WHERE player=? AND json_extract(state,'$.mode')='daily' AND json_extract(state,'$.dailyDate')=?",[player,date])).rows[0];
  return row?JSON.parse(String(row.state)):null;
}
