import { mkdir,readFile,writeFile,rename } from "node:fs/promises";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { WORKSPACE,type Track,stats,ROOT } from "./store.ts";
import { isAlternate } from "./recordings.ts";
import { buildRotation } from "./rotation.ts";
import { flagLanguageUncertainty } from "./importers.ts";

type MediaTrack=Track & {preview_url:string;artwork_url:string;purchase_url:string;provider_id:string;media_album:string;media_release:string;checked_at:string;status:string;streams?:number;observed_on?:string};
interface Release {version:string;effectiveOn:string;selection:string;count:number}
interface Index {schema:number;releases:Release[]}
export async function atomicJson(path:string,data:unknown){await mkdir(resolve(path,".."),{recursive:true});await writeFile(path+".tmp",JSON.stringify(data,null,2)+"\n");await rename(path+".tmp",path);}
export function uniqueRecordings<T extends {recording_key:string}>(tracks:T[]):T[]{ const seen=new Set<string>();return tracks.filter(t=>{if(seen.has(t.recording_key))return false;seen.add(t.recording_key);return true;}); }
export function tomorrow(){return new Date(Date.now()+86400000).toISOString().slice(0,10);}
export function nextAvailableDate(start:string,occupied:Iterable<string>){
  const used=new Set(occupied);let date=start;
  while(used.has(date))date=new Date(Date.parse(date)+86400000).toISOString().slice(0,10);
  return date;
}
export async function publish(db:DatabaseSync,effectiveOn?:string){
  if(!effectiveOn){
    const indexes=await Promise.all(["tempo-trap","blackjack-music"].map(async name=>JSON.parse(await readFile(resolve(WORKSPACE,name,"data/catalog-releases.json"),"utf8")) as Index));
    effectiveOn=nextAvailableDate(tomorrow(),indexes.flatMap(index=>index.releases.map(release=>release.effectiveOn)));
  }
  if(!/^\d{4}-\d{2}-\d{2}$/.test(effectiveOn)||!Number.isFinite(Date.parse(effectiveOn))||new Date(effectiveOn).toISOString().slice(0,10)!==effectiveOn||effectiveOn<=new Date().toISOString().slice(0,10))throw new Error("Publish to a future UTC date so today's puzzle cannot change.");
  flagLanguageUncertainty(db);
  const cutoff=new Date(Date.now()-7*86400000).toISOString();
  const candidates=db.prepare(`SELECT t.*,m.preview_url,m.artwork_url,m.purchase_url,m.provider_id,m.album media_album,m.release_date media_release,m.checked_at,m.status FROM tracks t JOIN media m ON m.track_id=t.id
    WHERE t.language='en' AND t.language_review_required=0 AND t.bpm BETWEEN 40 AND 220 AND (t.instrumentalness IS NULL OR t.instrumentalness<0.5)
    AND m.status='available' AND m.checked_at>=? ORDER BY t.popularity DESC,t.id`).all(cutoff) as unknown as MediaTrack[];
  const tempo=uniqueRecordings(candidates.filter(t=>!isAlternate(t.title))).map(t=>({
    id:t.id,title:t.title,artist:t.artist,album:t.media_album||t.album,bpm:Math.round(t.bpm!),bpmSource:t.bpm_source,bpmQuality:t.bpm_quality,
    language:t.language,languageSource:t.language_source,spotifyUrl:`https://open.spotify.com/track/${t.id}`,
    appleMusicUrl:t.purchase_url,appleTrackId:Number(t.provider_id),artworkUrl:t.artwork_url,previewUrl:t.preview_url,
    year:Number((t.release_date||t.media_release||"").slice(0,4)),clipStartSeconds:7.5,clipSeconds:15,previewCheckedAt:t.checked_at,
  })).filter(t=>t.year>=1900&&t.year<=new Date().getUTCFullYear());
  const streamRows=db.prepare(`SELECT t.*,s.streams,s.observed_on,m.preview_url,m.artwork_url,m.release_date media_release FROM tracks t
    JOIN stream_snapshots s ON s.track_id=t.id AND s.observed_on=(SELECT max(s2.observed_on) FROM stream_snapshots s2 WHERE s2.track_id=t.id)
    LEFT JOIN media m ON m.track_id=t.id WHERE t.language='en' AND t.language_review_required=0 AND s.observed_on>=? ORDER BY s.streams DESC,t.popularity DESC,t.id`).all(cutoff.slice(0,10)) as unknown as MediaTrack[];
  const blackjack=uniqueRecordings(streamRows.filter(t=>!isAlternate(t.title))).map(t=>({
    id:t.id,title:t.title,artist:t.artist,releaseYear:Number((t.release_date||t.media_release||"").slice(0,4)),streams:t.streams!,
    ...(t.artwork_url?{albumArtUrl:t.artwork_url}:{}),...(t.preview_url?{previewUrl:t.preview_url}:{}),
    streamsObservedOn:t.observed_on,streamsSource:"https://kworb.net/spotify/songs.html",language:t.language,languageSource:t.language_source,
  })).filter(t=>t.releaseYear>=1900&&t.releaseYear<=new Date().getUTCFullYear());
  if(tempo.length<100)throw new Error(`Only ${tempo.length} eligible Tempo tracks. Enrich/check more recordings before publication (minimum 100).`);
  if(blackjack.filter(t=>t.streams>=1800000000).length<2||blackjack.filter(t=>t.streams>=850000000&&t.streams<1800000000).length<4||blackjack.filter(t=>t.streams<850000000).length<3)throw new Error("Insufficient Blackjack stream tiers; import more real stream snapshots first.");
  const staged: {name:string;version:string;tracks:unknown[];rotation?:string[][];index:Index;path:string}[]=[];
  for(const [name,tracks] of [["tempo-trap",tempo],["blackjack-music",blackjack]] as const){
    const version=createHash("sha256").update(JSON.stringify(tracks)).digest("hex").slice(0,16);
    const indexPath=resolve(WORKSPACE,name,"data/catalog-releases.json");
    const index=JSON.parse(await readFile(indexPath,"utf8")) as Index;
    if(index.releases.some(r=>r.version===version)){console.log(`${name}: identical release already exists`);continue;}
    if(index.releases.some(r=>r.effectiveOn===effectiveOn))throw new Error(`${name}: a release is already scheduled for ${effectiveOn}; published daily data is immutable.`);
    staged.push({name,version,tracks,index,path:indexPath,...(name==="tempo-trap"?{rotation:buildRotation(tempo,version)}:{})});
  }
  // Validate both pools before writing either. Each app's pointer is atomically replaced last.
  for(const item of staged){
    await atomicJson(resolve(WORKSPACE,item.name,"data/catalog-releases",`${item.version}.json`),{version:item.version,effectiveOn,createdAt:new Date().toISOString(),tracks:item.tracks,...(item.rotation?{rotation:item.rotation}:{}),provenance:"music-catalog/data/music.sqlite"});
    item.index.releases.push({version:item.version,effectiveOn,selection:item.rotation?"rotation":"seeded",count:item.tracks.length});
    item.index.releases.sort((a,b)=>a.effectiveOn.localeCompare(b.effectiveOn));
    await atomicJson(item.path,item.index);
    db.prepare("INSERT INTO releases VALUES(?,?,?,?,?)").run(item.name,item.version,effectiveOn,item.tracks.length,new Date().toISOString());
    console.log(`${item.name}: ${item.tracks.length} tracks; practice uses new pool immediately, daily activates ${effectiveOn}${item.rotation?`; ${item.rotation.length} daily mixes before a recording repeats`:""}`);
  }
  await atomicJson(resolve(ROOT,"data/coverage.json"),{generatedAt:new Date().toISOString(),...stats(db),eligibleTempo:tempo.length,eligibleBlackjack:blackjack.length,releases:db.prepare("SELECT * FROM releases ORDER BY effective_on").all()});
}
