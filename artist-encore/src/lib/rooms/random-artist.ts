import {randomInt} from "node:crypto";
import {CatalogError,distinctRecordings,isPreviewUrl,loadArtist,normalize,searchArtists,type Artist,type ArtistPool} from "../catalog.ts";
import {loadArtistDirectory} from "../../../../shared/music-provider/stream-provider.ts";
import {catalogOffer} from "../rules.ts";
import {RoomError} from "./types.ts";

export const RANDOM_ARTIST_ATTEMPTS=4;
export const RANDOM_ARTIST_BUDGET_MS=90_000;
export interface RandomArtistOptions {excludeArtistId?:string;excludeArtistName?:string}
export interface RandomArtistDependencies {
  directory:()=>Promise<{value:{id:string;name:string}[];stale:boolean}>;
  search:(name:string)=>Promise<Artist[]>;
  load:(id:string)=>Promise<ArtistPool>;
  randomIndex:(max:number)=>number;
  now:()=>number;
  budgetMs:number;
}
const defaults:RandomArtistDependencies={directory:loadArtistDirectory,search:searchArtists,load:loadArtist,randomIndex:randomInt,now:Date.now,budgetMs:RANDOM_ARTIST_BUDGET_MS};
function unavailable(){return new RoomError("We couldn't find a playable surprise artist right now. Try again, or choose an artist together.",503,"random_artist_unavailable");}
/** Reuse the real preview catalog; malformed, duplicate, and other-artist tracks
 * cannot inflate the minimum. Popularity tiers remain the normal room rules. */
function eligiblePool(pool:ArtistPool):ArtistPool|undefined {
  const usable=(track:ArtistPool["tracks"][number])=>track.artistId===pool.artist.id&&normalize(track.artist)===normalize(pool.artist.name)&&isPreviewUrl(track.preview);
  const tracks=distinctRecordings(pool.tracks.filter(usable));
  const discoveryTracks=distinctRecordings((pool.discoveryTracks??pool.tracks).filter(usable));
  const checked={...pool,tracks,discoveryTracks};const offer=catalogOffer(checked);
  return offer.discoveryAvailable||offer.rankedAvailable?checked:undefined;
}
/** The shared provider cache supplies a broad live directory, never a hand-picked
 * artist list. Only a verified exact Apple artist match may become the room's artist. */
export async function selectRandomArtist(options:RandomArtistOptions={},overrides:Partial<RandomArtistDependencies>={}):Promise<ArtistPool> {
  const deps={...defaults,...overrides};const deadline=deps.now()+deps.budgetMs;
  async function bounded<T>(work:()=>Promise<T>):Promise<T> {
    const remaining=deadline-deps.now();if(remaining<=0)throw unavailable();
    let timer:ReturnType<typeof setTimeout>|undefined;
    // Existing provider operations own their cache leases and network timeouts.
    // A request deadline stops room creation without interrupting those safe cache writes.
    try{return await Promise.race([work(),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(unavailable()),remaining);})]);}
    finally{if(timer)clearTimeout(timer);}
  }
  let source:{value:{id:string;name:string}[];stale:boolean};
  try{source=await bounded(deps.directory);}catch(error){if(error instanceof RoomError)throw error;throw unavailable();}
  const excluded=normalize(options.excludeArtistName??"");
  const names=[...new Map(source.value.filter(candidate=>typeof candidate.name==="string"&&candidate.name.trim().length>=2&&candidate.name.trim().length<=80)
    .map(candidate=>[normalize(candidate.name),candidate.name.trim()])).entries()].filter(([name])=>name&&name!==excluded).map(([,name])=>name);
  let attempts=0;
  while(names.length&&attempts<RANDOM_ARTIST_ATTEMPTS&&deps.now()<deadline){
    const selected=deps.randomIndex(names.length);
    if(!Number.isInteger(selected)||selected<0||selected>=names.length)throw new Error("Random artist index is out of range.");
    const [name]=names.splice(selected,1);attempts++;
    try{
      const matches=(await bounded(()=>deps.search(name))).filter(artist=>normalize(artist.name)===normalize(name)&&/^apple:[1-9]\d{0,14}$/.test(artist.id));
      const unique=[...new Map(matches.map(artist=>[artist.id,artist])).values()];
      if(unique.length!==1||unique[0].id===options.excludeArtistId)continue;
      const artist=unique[0];const pool=await bounded(()=>deps.load(artist.id));
      if(pool.artist.id!==artist.id||normalize(pool.artist.name)!==normalize(artist.name))continue;
      const eligible=eligiblePool(pool);if(eligible)return eligible;
    }catch(error){
      if(error instanceof RoomError&&error.code==="random_artist_unavailable")throw error;
      // More cold lookups would worsen a shared provider rate limit.
      if(error instanceof CatalogError&&(error.status===429||error.code==="provider_busy"))throw error;
      if(deps.now()>=deadline)throw unavailable();
    }
  }
  throw unavailable();
}
