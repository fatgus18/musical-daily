"use client";

import {useEffect,useRef,useState} from "react";
import {FAVORITES_KEY,FAVORITES_LIMIT,readFavorites,toggleFavorite,type FavoriteArtist} from "@/lib/favorite-artists";

export function useArtistFavorites(){
  const [artists,setArtists]=useState<FavoriteArtist[]>([]);
  const [ready,setReady]=useState(false);
  const [persistent,setPersistent]=useState(true);
  const [notice,setNotice]=useState("");
  const current=useRef<FavoriteArtist[]>([]);
  const usableStorage=useRef(true);
  useEffect(()=>{
    try{current.current=readFavorites(localStorage.getItem(FAVORITES_KEY));setArtists(current.current);}catch{usableStorage.current=false;setPersistent(false);}
    setReady(true);
    const sync=(event:StorageEvent)=>{if(event.key!==FAVORITES_KEY&&event.key!==null)return;current.current=readFavorites(event.newValue);setArtists(current.current);setNotice("");};
    window.addEventListener("storage",sync);return()=>window.removeEventListener("storage",sync);
  },[]);
  useEffect(()=>{if(!notice)return;const timer=setTimeout(()=>setNotice(""),5000);return()=>clearTimeout(timer);},[notice]);
  function toggle(input:FavoriteArtist){
    if(!ready)return;
    if(usableStorage.current){try{current.current=readFavorites(localStorage.getItem(FAVORITES_KEY));}catch{usableStorage.current=false;setPersistent(false);}}
    const next=toggleFavorite(current.current,input);setNotice(next.message);
    if(!next.changed)return;
    current.current=next.artists;setArtists(next.artists);
    try{localStorage.setItem(FAVORITES_KEY,JSON.stringify({version:1,artists:next.artists}));usableStorage.current=true;setPersistent(true);}catch{usableStorage.current=false;setPersistent(false);}
  }
  return {artists,ready,persistent,notice,toggle};
}

export function PinArtistButton({artist,pinned,onToggle,disabled=false,showLabel=false}:{artist:FavoriteArtist;pinned:boolean;onToggle:(artist:FavoriteArtist)=>void;disabled?:boolean;showLabel?:boolean}){
  return <button type="button" className={`pin-artist ${showLabel?"pin-artist-label":""}`} aria-label={`${pinned?"Unpin":"Pin"} ${artist.name}${pinned?"":" as a favorite"}`} aria-pressed={pinned} disabled={disabled} onClick={()=>onToggle(artist)} title={pinned?"Unpin this artist":"Pin this artist for next time"}><svg aria-hidden="true" width="17" height="17" viewBox="0 0 24 24" fill={pinned?"currentColor":"none"} stroke="currentColor" strokeWidth="1.6"><path d="m12 3 2.8 5.8 6.4.9-4.6 4.5 1.1 6.3-5.7-3-5.7 3 1.1-6.3L2.8 9.7l6.4-.9L12 3Z"/></svg>{showLabel&&<span>{pinned?"Pinned to your front row":"Pin to your front row"}</span>}</button>;
}

export function FavoriteArtists({favorites,onChoose,disabled=false}:{favorites:ReturnType<typeof useArtistFavorites>;onChoose:(artist:FavoriteArtist)=>void;disabled?:boolean}){
  return <section className="favorite-artists" aria-labelledby="favorite-heading"><div className="favorite-heading"><div><p className="eyebrow">YOUR FRONT ROW</p><h3 id="favorite-heading">The ones you come back to.</h3></div><span>{favorites.artists.length}<span> / {FAVORITES_LIMIT}</span></span></div>
    {favorites.artists.length?<div className="favorite-grid">{favorites.artists.map((artist,index)=><div className="favorite-card" key={artist.id}><button className="favorite-play" type="button" disabled={disabled} onClick={()=>onChoose(artist)} aria-label={`Play a mix by ${artist.name}`}><span className="favorite-disc" aria-hidden="true"><span>{artist.name.split(/\s+/).filter(Boolean).slice(0,2).map(word=>Array.from(word)[0]).join("")}</span></span><span><strong>{artist.name}</strong><small>PLAY A FRESH MIX ↗</small></span><i aria-hidden="true">{String(index+1).padStart(2,"0")}</i></button><PinArtistButton artist={artist} pinned onToggle={favorites.toggle} disabled={!favorites.ready}/></div>)}</div>:<p className="favorites-empty"><span aria-hidden="true">☆</span> Pin artists with the star beside their name. Your next encore is one click away.</p>}
    <p className="favorite-storage">{favorites.persistent?"Saved on this browser · up to 8 artists":"Favorites are temporary in this tab. Browser storage is unavailable."}</p>
  </section>;
}
