import type { DatabaseSync } from "node:sqlite";
import { request } from "./network.ts";
import { matchRecording, normalize, isAlternate } from "./recordings.ts";
import type { Track } from "./store.ts";

export interface AppleHit { trackId: number; trackName: string; artistName: string; collectionName: string; previewUrl?: string; artworkUrl100?: string; trackViewUrl: string; releaseDate?: string; trackTimeMillis: number }
export async function enrich(db: DatabaseSync, artistLimit: number, refresh = false) {
  const artists=db.prepare(`SELECT primary_artist,artist_key,max(popularity) popularity,count(*) tracks FROM tracks
    WHERE language='en' AND language_review_required=0 AND bpm BETWEEN 40 AND 220 AND duration_ms BETWEEN 90000 AND 600000
    AND (?=1 OR artist_key NOT IN(SELECT job_key FROM jobs WHERE kind='apple-artist' AND status='done' AND updated_at>datetime('now','-30 days')))
    GROUP BY artist_key ORDER BY popularity DESC,tracks DESC LIMIT ?`).all(refresh?1:0,artistLimit) as {primary_artist:string;artist_key:string;popularity:number;tracks:number}[];
  const job=db.prepare("INSERT INTO jobs VALUES('apple-artist',?,?,?,?) ON CONFLICT(kind,job_key) DO UPDATE SET status=excluded.status,updated_at=excluded.updated_at,details=excluded.details");
  const save=db.prepare(`INSERT INTO media(track_id,provider,provider_id,preview_url,artwork_url,purchase_url,album,release_date,matched_at,checked_at,status,duration_ms,match_method)
    VALUES(?,?,?,?,?,?,?,?,?,NULL,'matched',?,?) ON CONFLICT(track_id) DO UPDATE SET
    preview_url=excluded.preview_url,artwork_url=excluded.artwork_url,purchase_url=excluded.purchase_url,
    matched_at=excluded.matched_at,status=CASE WHEN media.preview_url=excluded.preview_url THEN media.status ELSE 'matched' END,
    checked_at=CASE WHEN media.preview_url=excluded.preview_url THEN media.checked_at ELSE NULL END`);
  for (const [index,artist] of artists.entries()) {
    job.run(artist.artist_key,"running",new Date().toISOString(),null);
    try {
      const query=new URLSearchParams({term:artist.primary_artist,entity:"song",attribute:"artistTerm",country:"US",limit:"200"});
      const response=await request(`https://itunes.apple.com/search?${query}`);
      const data=await response.json() as {results:AppleHit[]};
      const tracks=db.prepare("SELECT * FROM tracks WHERE artist_key=? AND language='en'").all(artist.artist_key) as unknown as Track[];
      let matched=0;
      for(const t of tracks){
        const matches=data.results.filter(hit=>hit.previewUrl?.startsWith("https://") && hit.artworkUrl100?.startsWith("https://") && matchRecording(t,hit));
        if(!matches.length)continue;
        matches.sort((a,b)=> Math.abs(a.trackTimeMillis-t.duration_ms!)-Math.abs(b.trackTimeMillis-t.duration_ms!) || (a.releaseDate||"9999").localeCompare(b.releaseDate||"9999"));
        const hit=matches[0];
        save.run(t.id,"apple",String(hit.trackId),hit.previewUrl!,hit.artworkUrl100!.replace("100x100bb","600x600bb"),hit.trackViewUrl,hit.collectionName,hit.releaseDate||null,new Date().toISOString(),hit.trackTimeMillis,"exact-normalized-title + primary-artist + duration<=2.5s");
        matched++;
      }
      job.run(artist.artist_key,"done",new Date().toISOString(),JSON.stringify({matched,returned:data.results.length}));
      console.log(`[${index+1}/${artists.length}] ${artist.primary_artist}: ${matched} recording matches`);
    } catch(error) {
      job.run(artist.artist_key,"failed",new Date().toISOString(),String(error));
      console.warn(`${artist.primary_artist}: ${String(error)} (checkpoint retained; later runs retry)`);
    }
  }
}
export async function checkMedia(db:DatabaseSync,limit:number){
  const rows=db.prepare(`SELECT preview_url FROM media WHERE status!='unavailable' AND (checked_at IS NULL OR checked_at<datetime('now','-7 days')) GROUP BY preview_url LIMIT ?`).all(limit) as {preview_url:string}[];
  let available=0;
  // Small batches; no audio is saved. Only availability headers are checked.
  for(let offset=0;offset<rows.length;offset+=4){
    await Promise.all(rows.slice(offset,offset+4).map(async row=>{
      try{
        const response=await request(row.preview_url,{method:"HEAD"});
        const type=response.headers.get("content-type")||"";
        if(!type.startsWith("audio/")) throw new Error("Unexpected media content type");
        db.prepare("UPDATE media SET status='available',checked_at=? WHERE preview_url=?").run(new Date().toISOString(),row.preview_url);available++;
      }catch(error){
        const unavailable=/HTTP (404|410)/.test(String(error));
        db.prepare("UPDATE media SET status=?,checked_at=? WHERE preview_url=?").run(unavailable?"unavailable":"check-failed",new Date().toISOString(),row.preview_url);
      }
    }));
    if(offset%100===0)console.log(`Preview checks: ${Math.min(offset+4,rows.length)}/${rows.length}`);
  }
  console.log(`Preview checks: ${available}/${rows.length} reachable audio URLs`);
}
