export const FAVORITES_KEY="encore:favorite-artists:v1";
export const FAVORITES_LIMIT=8;
export interface FavoriteArtist {id:string;name:string}

/** Keep identity and display text only; storage never supplies URLs or catalog data. */
export function favoriteArtist(value:unknown):FavoriteArtist|null{
  if(!value||typeof value!=="object")return null;
  const input=value as Record<string,unknown>;
  if(typeof input.id!=="string"||!/^apple:\d{1,15}$/.test(input.id)||Number(input.id.slice(6))<=0||typeof input.name!=="string")return null;
  const name=input.name.trim();
  if(!name||name.length>180||/[\u0000-\u001f\u007f]/.test(input.name))return null;
  return {id:input.id,name};
}

export function readFavorites(raw:string|null):FavoriteArtist[]{
  if(!raw||raw.length>6000)return [];
  try{
    const saved=JSON.parse(raw);
    if(!saved||saved.version!==1||!Array.isArray(saved.artists))return [];
    const result:FavoriteArtist[]=[];
    for(const input of saved.artists.slice(0,64)){
      const artist=favoriteArtist(input);
      if(artist&&!result.some(item=>item.id===artist.id))result.push(artist);
      if(result.length===FAVORITES_LIMIT)break;
    }
    return result;
  }catch{return [];}
}

export function toggleFavorite(favorites:FavoriteArtist[],input:unknown):{artists:FavoriteArtist[];message:string;changed:boolean}{
  const artist=favoriteArtist(input);
  if(!artist)return {artists:favorites,message:"Search for this artist again before pinning them.",changed:false};
  if(favorites.some(item=>item.id===artist.id))return {artists:favorites.filter(item=>item.id!==artist.id),message:`${artist.name} unpinned.`,changed:true};
  if(favorites.length>=FAVORITES_LIMIT)return {artists:favorites,message:"Your eight spots are full. Unpin an artist to make room.",changed:false};
  return {artists:[...favorites,artist],message:`${artist.name} pinned to your front row.`,changed:true};
}
