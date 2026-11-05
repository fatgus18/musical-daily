import { readFile } from "node:fs/promises";
import type { DatabaseSync } from "node:sqlite";
import { trackWriter } from "./store.ts";
import { checksum } from "./network.ts";

// Adapter boundary for future licensed feeds/exports. No song limit and no API coupling.
export interface FeedTrack {
  spotifyId:string;title:string;artists:string[];album?:string;durationMs:number;
  releaseDate?:string;language?:string;bpm?:number;bpmSource?:string;popularity?:number;genre?:string;
  streams?:number;streamsAsOf?:string;streamsSource?:string;
}
export async function ingest(db:DatabaseSync,file:string,source:string){
  if(!source||!/^https?:\/\//.test(source))throw new Error("Supply --source with the feed's provenance URL.");
  const text=await readFile(file,"utf8");
  const rows:FeedTrack[]=file.endsWith(".jsonl")?text.split(/\r?\n/).filter(Boolean).map(line=>JSON.parse(line)):JSON.parse(text);
  if(!Array.isArray(rows))throw new Error("Expected a JSON array or JSONL records.");
  const put=trackWriter(db);let count=0;
  db.exec("BEGIN IMMEDIATE");
  try{
    for(const t of rows){
      if(!/^[A-Za-z0-9]{22}$/.test(t.spotifyId)||!t.title||!Array.isArray(t.artists)||!t.artists.length||t.artists.some(a=>typeof a!=="string"||!a.trim())||!Number.isSafeInteger(t.durationMs)||t.durationMs<1000)throw new Error(`Invalid recording at row ${count+1}; entire feed rolled back.`);
      if(t.bpm!==undefined&&(!Number.isFinite(t.bpm)||t.bpm<40||t.bpm>220||!t.bpmSource))throw new Error(`BPM needs a source and a value from 40–220: ${t.title}`);
      if(t.language && !/^[a-z]{2,3}$/.test(t.language))throw new Error(`Invalid ISO language: ${t.title}`);
      put({id:t.spotifyId,title:t.title,artist:t.artists.join(", "),primary_artist:t.artists[0],album:t.album||"",duration_ms:t.durationMs,release_date:t.releaseDate||null,popularity:t.popularity||0,language:t.language||null,language_source:t.language?source:null,bpm:t.bpm??null,bpm_source:t.bpmSource||null,bpm_quality:"source-reported",genre:t.genre||"",source,instrumentalness:null});
      if(t.streams!==undefined){
        if(!Number.isSafeInteger(t.streams)||t.streams<=0||!t.streamsSource||!t.streamsAsOf||!/^\d{4}-\d{2}-\d{2}$/.test(t.streamsAsOf)||!Number.isFinite(Date.parse(t.streamsAsOf))||new Date(t.streamsAsOf).toISOString().slice(0,10)!==t.streamsAsOf)throw new Error(`Stream counts need a source and observation date: ${t.title}`);
        db.prepare("INSERT INTO stream_snapshots VALUES(?,?,?,?,?) ON CONFLICT(track_id,observed_on) DO NOTHING").run(t.spotifyId,t.streamsAsOf,t.streams,t.streamsSource,"explicit-provider-Spotify-ID");
      }
      count++;
    }
    db.prepare("INSERT INTO sources VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET imported_at=excluded.imported_at,row_count=excluded.row_count,sha256=excluded.sha256").run(source,source,"provided feed; see supplier terms",new Date().toISOString(),count,checksum(text));
    db.exec("COMMIT");
  }catch(error){db.exec("ROLLBACK");throw error;}
  console.log(`Ingested ${count} sourced recordings without replacing the existing library.`);
}
