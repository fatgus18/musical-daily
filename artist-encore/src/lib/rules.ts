import { tierPools } from "../../../shared/music-provider/ranking.ts";
import type {Track,ArtistPool} from "./catalog.ts";
import type {Exposure,Pick,Tier,CatalogOffer} from "./types.ts";
export const CLIP_SECONDS=10;
export const GUESS_SECONDS=15;
export const CLIP_OFFSET=7;
export const TIER_NAMES:Record<Tier,string>={hit:"The hits",favorite:"Fan favorites",deep:"The deep cuts",discovery:"Discovery mix"};
export const trackIdentity=(track:Track)=>track.recordingKey||track.id;
export function normalize(text:string){return text.normalize("NFKD").replace(/\p{M}/gu,"").toLowerCase().replace(/[’']/g,"").replace(/&/g," and ").replace(/[^\p{L}\p{N}]+/gu," ").trim().replace(/\s+/g," ");}
export function shuffled<T>(items:T[],seed:string){let n=[...seed].reduce((h,c)=>Math.imul(h^c.charCodeAt(0),16777619)>>>0,2166136261);const result=[...items];for(let i=result.length-1;i>0;i--){n=(Math.imul(n,1664525)+1013904223)>>>0;const j=n%(i+1);[result[i],result[j]]=[result[j],result[i]];}return result;}
export { tierPools } from "../../../shared/music-provider/ranking.ts";
export function selectMix(tracks:Track[],history:Exposure[],seed:string):Pick[]{
  const seen=new Map(history.map(h=>[h.id,h]));const tiers=tierPools(tracks);
  return tiers.flatMap(([tier,pool,count])=>shuffled(pool,`${seed}:${tier}`).sort((a,b)=>(seen.get(trackIdentity(a))?.plays||0)-(seen.get(trackIdentity(b))?.plays||0)||(seen.get(trackIdentity(a))?.lastPlayed||0)-(seen.get(trackIdentity(b))?.lastPlayed||0)).slice(0,count).map(track=>({track,tier})));
}
export function answerMatches(track:Track,input:string){const value=normalize(input);if(!value||value.length>180)return false;return [track.title,...track.aliases].some(title=>[normalize(title),normalize(`${title} ${track.artist}`),normalize(`${title} by ${track.artist}`)].includes(value));}
export function discoverySongs(pool:ArtistPool){return [...new Map((pool.discoveryTracks||pool.tracks).map(t=>[trackIdentity(t),t])).values()];}
export function selectDiscovery(tracks:Track[],history:Exposure[],seed:string):Pick[]{
  const unique=[...new Map(tracks.map(t=>[trackIdentity(t),t])).values()];if(unique.length<10)throw new Error("Ten different playable recordings are needed for a mix. Load more releases or try another artist.");
  const seen=new Map(history.map(h=>[h.id,h]));return shuffled(unique,seed).sort((a,b)=>(seen.get(trackIdentity(a))?.plays||0)-(seen.get(trackIdentity(b))?.plays||0)||(seen.get(trackIdentity(a))?.lastPlayed||0)-(seen.get(trackIdentity(b))?.lastPlayed||0)).slice(0,10).map(track=>({track,tier:"discovery"}));
}
export function catalogOffer(pool:ArtistPool):CatalogOffer{
  let rankedAvailable=false;if(pool.ranking.kind!=="unranked"){try{tierPools(pool.tracks);rankedAvailable=true;}catch{}}
  const previewable=discoverySongs(pool).length;return {artist:pool.artist,previewable,ranked:pool.coverage?.ranked??(pool.ranking.kind==="unranked"?0:pool.tracks.length),rankedAvailable,discoveryAvailable:previewable>=10,coverage:pool.coverage,ranking:pool.ranking};
}
