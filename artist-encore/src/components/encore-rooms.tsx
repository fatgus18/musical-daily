"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ACCOUNT_AVATARS } from "@musical-daily/accounts";
import type { Artist } from "@/lib/catalog";
import type { PublicRoom, RoomAction, RoomStanding } from "@/lib/rooms/types";
import { withBasePath } from "@/lib/app-path";
import { AccountButton, useAccount } from "./account-client";
import { MusicalDailyBrand } from "./musical-daily-brand";
import { useSound } from "./sound-client";
import { useRoomAudio } from "./encore-room-audio";

function Avatar({value,name}:{value?:string|null;name:string}) {
  const emoji = ACCOUNT_AVATARS.find(option=>option.id===value)?.emoji;
  return <span className="er-avatar" aria-hidden="true">{emoji || (value && !/^https?:/.test(value) ? value : name.slice(0,1).toUpperCase())}</span>;
}
function RoomArt() {
  return <div className="er-room-art" aria-hidden="true"><div className="er-record"><span>YOU<br/><b>♫</b></span></div><div className="er-record er-record-friend"><span>YOUR FRIENDS<br/><b>✦</b></span></div><span className="er-art-sticker">SAME SONG.<br/>DIFFERENT FLEX.</span><span className="er-pixel-star">✦</span></div>;
}
function seconds(value:number) { return `${(value/1000).toFixed(2)}s`; }
function Standings({room,final=false}:{room:PublicRoom;final?:boolean}) {
  return <section className={`er-standings ${final?"er-standings-final":""}`} aria-label={final?"Final standings":"Live leaderboard"}><div className="er-section-heading"><h2>{final?"The final lineup":"The lineup"}</h2><span>{room.players.filter(player=>!player.left).length} players</span></div><ol>{room.leaderboard.map((player:RoomStanding)=><li key={player.id} className={player.id===room.youId?"is-you":""}><span className="er-rank">{player.winner&&final?"♛":String(player.rank).padStart(2,"0")}</span><Avatar name={player.name} value={player.avatar}/><div className="er-player-name"><strong>{player.name}{player.id===room.youId&&<small>you</small>}</strong><span>{player.left?"Left the room":`${player.correct} correct · ${seconds(player.timeMs)}`}</span></div><b className="er-player-points">{player.score.toLocaleString()}<small>points</small></b></li>)}</ol><p className="er-score-rule">1,000 points per correct answer. Ties go to the lowest total time on correct answers, including listening.</p></section>;
}

export default function EncoreRooms({hubUrl,initialCode=""}:{hubUrl:string;initialCode?:string}) {
  const account = useAccount();
  const {play:playSound} = useSound();
  const [code,setCode] = useState(initialCode.toUpperCase());
  const [joinCode,setJoinCode] = useState(initialCode.toUpperCase());
  const [nickname,setNickname] = useState("");
  const nicknameEdited = useRef(false);
  const [query,setQuery] = useState("");
  const [artists,setArtists] = useState<Artist[]>([]);
  const [artist,setArtist] = useState<Artist|null>(null);
  const [artistMode,setArtistMode] = useState<"chosen"|"random">("chosen");
  const [searching,setSearching] = useState(false);
  const [searchError,setSearchError] = useState("");
  const [room,setRoom] = useState<PublicRoom|null>(null);
  const roomRef = useRef<PublicRoom|null>(null);
  const [busy,setBusy] = useState("");
  const actionLock = useRef(false);
  const [error,setError] = useState("");
  const [network,setNetwork] = useState("");
  const [loading,setLoading] = useState(Boolean(initialCode));
  const [needsJoin,setNeedsJoin] = useState(false);
  const [entryPanel,setEntryPanel] = useState<"host"|"join">(initialCode?"join":"host");
  const [initialized,setInitialized] = useState(false);
  const [audioEnabled,setAudioEnabled] = useState(true);
  const [copied,setCopied] = useState(false);
  const [copyText,setCopyText] = useState("");
  const [now,setNow] = useState(0);
  const [leaving,setLeaving] = useState(false);
  const [refresh,setRefresh] = useState(0);
  const help = useRef<HTMLDialogElement>(null);
  const leaveDialog = useRef<HTMLDialogElement>(null);
  const firstChoice = useRef<HTMLButtonElement>(null);
  const pending = useRef(new Set<AbortController>());
  const pollAbort = useRef<AbortController|null>(null);
  const epoch = useRef(0);
  const requestId = useRef("");
  const serverClock = useRef({offset:0, initialized:false});
  const serverTime = useCallback(()=>Date.now()+serverClock.current.offset,[]);
  const accept = useCallback((value:PublicRoom,started:number)=>{
    const midpoint = Date.now()-(performance.now()-started)/2;
    const offset = value.serverNow-midpoint;
    serverClock.current.offset = serverClock.current.initialized ? serverClock.current.offset*.75+offset*.25 : offset;
    serverClock.current.initialized = true;
    const current = roomRef.current;
    // Revisions increase across rematches as well as rounds. An older in-flight
    // heartbeat must never restore the previous match after a rematch succeeds.
    if (current && current.code===value.code && current.revision>value.revision) return;
    roomRef.current=value; setRoom(value); setNeedsJoin(false); setLoading(false); setNetwork("");
  },[]);
  const command = useCallback(async (action:RoomAction,extra:Record<string,unknown>={},silent=false) => {
    const current=roomRef.current;
    if(!current || (actionLock.current&&!silent)) return false;
    if(!silent){actionLock.current=true;setBusy(action);setError("");pollAbort.current?.abort();}
    const generation=epoch.current;
    const controller=new AbortController(); pending.current.add(controller);
    const started=performance.now();
    try {
      const response=await fetch(withBasePath(`/api/rooms/${current.code}`),{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({action,matchId:current.matchId,round:current.round,...extra}),signal:AbortSignal.any([controller.signal,AbortSignal.timeout(action==="rematch"?120_000:15_000)])});
      const data=await response.json();
      if(!response.ok)throw new Error(data.error||"Your move didn't reach the room. Please retry.");
      if(generation!==epoch.current)return false;
      if(data.room)accept(data.room,started);
      return true;
    }catch(cause){if(generation===epoch.current&&!controller.signal.aborted){if(silent)setNetwork("Reconnecting to the room…");else setError(cause instanceof Error?cause.message:"Connection interrupted. Please retry.");}return false;}
    finally {pending.current.delete(controller);if(!silent&&generation===epoch.current){actionLock.current=false;setBusy("");}}
  },[accept]);
  const loaded = useCallback(async(identity:{matchId:string;round:number;audioRevision:number})=>{if(!await command("loaded",identity,true))throw new Error("Audio is ready, but your connection needs a retry before we can start.");},[command]);
  const audio=useRoomAudio(room,serverTime,loaded);
  useEffect(()=>{if(!nicknameEdited.current&&account.user?.name)setNickname(account.user.name.trim().slice(0,20));},[account.user?.name]);
  useEffect(()=>{const controller=new AbortController();void fetch(withBasePath("/api/rooms"),{cache:"no-store",signal:controller.signal}).then(async response=>{const data=await response.json();if(!response.ok)throw new Error(data.error||"The room service couldn't connect.");if(!controller.signal.aborted){setInitialized(true);setAudioEnabled(data.audioEnabled!==false);}}).catch(cause=>{if(!controller.signal.aborted){setError(cause instanceof Error?cause.message:"Could not connect to rooms. Please retry.");setLoading(false);}});return()=>controller.abort();},[refresh]);
  useEffect(()=>{if(leaving)leaveDialog.current?.showModal();else leaveDialog.current?.close();},[leaving]);
  useEffect(()=>{
    const term=query.trim();const controller=new AbortController();setArtists([]);setSearchError("");
    if(artistMode!=="chosen"||term.length<2){setSearching(false);return;}
    setSearching(true);
    const timer=setTimeout(async()=>{try{const response=await fetch(withBasePath(`/api/artists?q=${encodeURIComponent(term)}`),{signal:controller.signal});const data=await response.json();if(!response.ok)throw new Error(data.error||"Search couldn't load.");if(!controller.signal.aborted){setArtists(data.artists||[]);if(!data.artists?.length)setSearchError("No artists found. Try another spelling.");}}catch(cause){if(!controller.signal.aborted)setSearchError(cause instanceof Error?cause.message:"Search interrupted. Try again.");}finally{if(!controller.signal.aborted)setSearching(false);}},450);
    return()=>{clearTimeout(timer);controller.abort();};
  },[query,artistMode]);
  useEffect(()=>{
    if(!code||!initialized)return;
    const generation=epoch.current;let disposed=false;let timer:ReturnType<typeof setTimeout>;let failures=0;
    const poll=async()=>{
      if(disposed)return;
      if(actionLock.current){timer=setTimeout(poll,500);return;}
      const controller=new AbortController();pollAbort.current=controller;const started=performance.now();
      try{
        const response=await fetch(withBasePath(`/api/rooms/${code}`),{cache:"no-store",signal:AbortSignal.any([controller.signal,AbortSignal.timeout(12_000)])});
        const data=await response.json();if(disposed||generation!==epoch.current)return;
        if(response.status===401||response.status===403){setNeedsJoin(true);setLoading(false);setRoom(null);roomRef.current=null;return;}
        if(!response.ok)throw new Error(data.error||"The room couldn't be reached.");
        if(data.room){accept(data.room,started);failures=0;}
      }catch(cause){if(!disposed&&!controller.signal.aborted){failures++;setLoading(false);setNetwork(cause instanceof Error?cause.message:"Reconnecting to the room…");}}
      finally{if(pollAbort.current===controller)pollAbort.current=null;if(!disposed)timer=setTimeout(poll,Math.min(12_000,(document.hidden?5000:roomRef.current?.phase==="lobby"?3000:1500)*Math.max(1,failures)));}
    };
    void poll();
    const resume=()=>{if(!document.hidden&&!pollAbort.current){clearTimeout(timer);void poll();}};
    window.addEventListener("online",resume);document.addEventListener("visibilitychange",resume);
    return()=>{disposed=true;clearTimeout(timer);pollAbort.current?.abort();window.removeEventListener("online",resume);document.removeEventListener("visibilitychange",resume);};
  },[code,refresh,accept,initialized]);
  useEffect(()=>{if(!room)return;const timer=setInterval(()=>setNow(serverTime()),100);setNow(serverTime());return()=>clearInterval(timer);},[Boolean(room),serverTime]);
  useEffect(()=>{if(!code||!room?.youId||room.you.left)return;void command("heartbeat",{},true);const timer=setInterval(()=>{if(!document.hidden)void command("heartbeat",{},true);},15_000);return()=>clearInterval(timer);},[code,room?.youId,room?.matchId,room?.you.left,command]);
  useEffect(()=>{if(room?.phase!=="playing"||!room.startAt||room.you.guessAt||room.you.answered)return;const timer=setTimeout(()=>{if(!document.hidden)void command("heartbeat",{},true);},Math.max(0,room.startAt+room.clipSeconds*1000-serverTime()+75));return()=>clearTimeout(timer);},[room?.phase,room?.matchId,room?.round,room?.startAt,room?.you.guessAt,room?.you.answered,room?.clipSeconds,command,serverTime]);
  useEffect(()=>{
    if(room?.phase!=="playing"||!room.choices?.length||room.you.answered)return;
    firstChoice.current?.focus({preventScroll:true});
    const frame=requestAnimationFrame(()=>{const panel=firstChoice.current?.closest(".er-guessing");if(!panel)return;const bounds=panel.getBoundingClientRect();const available=window.visualViewport?.height||innerHeight;if(bounds.top<12||bounds.bottom>available-16)panel.scrollIntoView({block:"start",behavior:"instant"});});
    return()=>cancelAnimationFrame(frame);
  },[room?.phase,room?.round,Boolean(room?.choices?.length),room?.you.answered]);
  useEffect(()=>{
    if(!room||!["loading","reveal","complete"].includes(room.phase)||!window.matchMedia("(max-width: 760px)").matches)return;
    const frame=requestAnimationFrame(()=>{const panel=document.querySelector(room.phase==="complete"?".er-finale":".er-stage");if(!panel)return;const bounds=panel.getBoundingClientRect();if(bounds.top<8||bounds.top>innerHeight*.4)panel.scrollIntoView({block:"start",behavior:"instant"});});
    return()=>cancelAnimationFrame(frame);
  },[room?.phase,room?.round]);
  const lastReveal = room?.reveals.at(-1);
  useEffect(()=>{if(room?.phase==="reveal"&&lastReveal&&!lastReveal.voided){const mine=lastReveal.answers.find(answer=>answer.playerId===room.youId);playSound(mine?.correct?"correct":"wrong");}if(room?.phase==="complete")playSound("complete");},[room?.phase,room?.matchId,lastReveal?.round,playSound]);
  useEffect(()=>()=>{epoch.current++;for(const controller of pending.current)controller.abort();pollAbort.current?.abort();},[]);
  async function enter(action:"create"|"join") {
    if(actionLock.current||!initialized||!audioEnabled)return;
    if(!nickname.trim()){setError("Choose a name for the room first.");return;}
    const target=joinCode.trim().toUpperCase();
    if(action==="join"&&!/^[A-Z0-9]{6}$/.test(target)){setError("Enter the six-character room code from your friend.");return;}
    if(action==="create"&&artistMode==="chosen"&&!artist){setError("Pick an artist for your room.");return;}
    actionLock.current=true;setBusy(action);setError("");setNetwork("");
    if(!requestId.current)requestId.current=crypto.randomUUID();
    const controller=new AbortController();pending.current.add(controller);const started=performance.now();const generation=epoch.current;
    try {
      const response=await fetch(withBasePath(action==="create"?"/api/rooms":`/api/rooms/${target}`),{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(action==="create"?{action,artistMode,...(artistMode==="chosen"?{artistId:artist!.id}:{}),nickname:nickname.trim(),requestId:requestId.current}:{action,nickname:nickname.trim()}),signal:AbortSignal.any([controller.signal,AbortSignal.timeout(120_000)])});
      const data=await response.json();if(!response.ok)throw new Error(data.error||"This room couldn't be opened. Please retry.");if(generation!==epoch.current)return;
      if(!data.room)throw new Error("No room was returned. Please retry.");
      accept(data.room,started);setCode(data.room.code);setJoinCode(data.room.code);requestId.current="";
      window.history.replaceState(null,"",withBasePath(`/rooms/${data.room.code}`));
    }catch(cause){if(!controller.signal.aborted)setError(cause instanceof Error?cause.message:"Could not connect. Please retry.");}finally{pending.current.delete(controller);actionLock.current=false;setBusy("");}
  }
  async function ready(){if(!room)return;if(room.you.ready){await command("ready",{ready:false});return;}if(await audio.unlock())await command("ready",{ready:true});}
  async function guess(){if(busy)return;audio.stopForGuess();await command("guess");}
  async function leave(){audio.stop();if(await command("leave")){epoch.current++;roomRef.current=null;setRoom(null);setCode("");setJoinCode("");setNeedsJoin(false);setLeaving(false);setError("");setNetwork("");window.history.replaceState(null,"",withBasePath("/rooms"));}}
  async function copy(final=false){if(!room)return;const url=`${location.origin}${withBasePath(`/rooms/${room.code}`)}`;const own=room.leaderboard.find(player=>player.id===room.youId);const text=final?`Encore Rooms · ${room.artist.name}\n${own?.score||0} points · ${own?.correct||0} correct\n${seconds(own?.timeMs||0)} on correct answers\nBring your biggest fan.\n${location.origin}${withBasePath("/rooms")}`:url;try{await navigator.clipboard.writeText(text);setCopied(true);setTimeout(()=>setCopied(false),3000);}catch{setCopyText(text);}}
  const host=room?.youId===room?.hostId;
  const players=room?.players.filter(player=>!player.left)||[];
  const presentPlayers=players.filter(player=>player.present);
  const allReady=presentPlayers.length>=2&&presentPlayers.every(player=>player.ready);
  const countdown=room?.startAt?Math.max(0,Math.ceil((room.startAt-now)/1000)):0;
  const listening=room?.phase==="playing"&&!room.you.guessAt&&!room.you.answered;
  const guessLeft=room?.you.guessDeadline?Math.max(0,(room.you.guessDeadline-now)/1000):0;
  const clipLeft=room?.startAt?Math.max(0,room.clipSeconds-(now-room.startAt)/1000):15;
  const stageRemaining=room?.phase==="loading"?Math.max(0,Math.ceil(((room.loadingDeadline||now)-now)/1000)):room?.phase==="reveal"?Math.max(0,Math.ceil(((room.revealUntil||now)-now)/1000)):0;
  const ownReveal=lastReveal?.answers.find(answer=>answer.playerId===room?.youId);
  const winner=room?.leaderboard.filter(player=>player.winner)||[];
  return <div className="site er-site" data-room-phase={room?.phase||"entry"}><a className="skip" href="#room-main">Skip to room</a><header className="md-arcade-header"><MusicalDailyBrand href={hubUrl} showBack/><a className="md-game-stats-link" href={withBasePath("/")}>Play solo <span aria-hidden="true">↗</span></a><AccountButton statsHref={withBasePath("/stats")}/><button className="help-button" onClick={()=>help.current?.showModal()}>Room rules <span>?</span></button></header>
    <main id="room-main" className="er-main"><div className="er-title-row"><a className="er-wordmark" href={withBasePath("/rooms")} onClick={event=>{if(room){event.preventDefault();setLeaving(true);}}} aria-label="Encore Rooms home">en<span>core</span><b>rooms</b><i aria-hidden="true">✦</i></a><span className="er-live-label"><i/> FRIENDS. RIVALS. SUPERFANS.</span></div>
    {(error||network)&&<div className="er-message" role={error?"alert":"status"}><p>{error||network}</p><button onClick={()=>{setError("");setRefresh(value=>value+1);}} disabled={Boolean(busy)}>Retry connection</button></div>}
    {!audioEnabled&&<div className="er-message" role="status"><p>Audio rooms are not available on this deployment yet.</p></div>}{!room?<><section className="er-hero"><div><span className="er-kicker">YOUR ARTIST. YOUR FRIENDS. YOUR MOMENT.</span><h1>Who knows it<br/><em>first?</em></h1><p>Same ten songs. Up to eight friends. One room full of people who swear they know every word.</p><div className="er-hero-tags"><span>♫ 15-second clips</span><span>✦ 4 answer choices</span><span>↗ No sign-in needed</span></div></div><RoomArt/></section>
      {loading?<div className="er-panel er-loading" role="status"><span className="er-spinner"/>Finding your room…</div>:<section className="er-entry" data-entry-panel={needsJoin?"join":entryPanel} aria-label="Create or join an Encore room">{!needsJoin&&<div className="er-entry-switch" aria-label="Choose how to play"><button aria-pressed={entryPanel==="host"} onClick={()=>setEntryPanel("host")}>Host a room <span aria-hidden="true">+</span></button><button aria-pressed={entryPanel==="join"} onClick={()=>setEntryPanel("join")}>Join a room <span aria-hidden="true">↗</span></button></div>}<div className="er-identity"><label htmlFor="er-name">Your room name</label><input id="er-name" disabled={!initialized||Boolean(busy)} value={nickname} maxLength={20} autoComplete="nickname" placeholder="Your stage name" onChange={event=>{nicknameEdited.current=true;setNickname(event.target.value);}}/><p>{account.user?"Your account avatar comes along. Room scores stay separate from solo stats.":"Pick a name your friends will recognize. No account needed."}</p></div><div className="er-entry-grid">{!needsJoin&&<section className="er-panel er-create"><div className="er-panel-number">01 <span>MAKE THE GUEST LIST</span></div><h2>Host the encore.</h2><p>Pick your shared favorite, or let the room surprise you. Everyone plays the same artist.</p><fieldset className="er-artist-modes" disabled={!initialized||Boolean(busy)}><legend>Artist selection</legend><div><button type="button" aria-pressed={artistMode==="chosen"} onClick={()=>{setArtistMode("chosen");requestId.current="";}}><span aria-hidden="true">♫</span>Choose an artist</button><button type="button" aria-pressed={artistMode==="random"} onClick={()=>{setArtistMode("random");requestId.current="";}}><span aria-hidden="true">✦</span>Surprise us</button></div></fieldset>{artistMode==="chosen"?<><label htmlFor="er-artist">Find an artist</label><input id="er-artist" disabled={!initialized||Boolean(busy)} value={query} maxLength={80} autoComplete="off" placeholder="Who are we listening to?" onChange={event=>{setQuery(event.target.value);setArtist(null);requestId.current="";}}/><div className="er-search-suggestions">{["The Weeknd","Taylor Swift","Hozier"].map(name=><button key={name} disabled={!initialized||Boolean(busy)} onClick={()=>{setQuery(name);setArtist(null);requestId.current="";}}>{name}</button>)}</div><p className="er-search-status" role="status">{searching?"Finding your artist…":searchError}</p><div className="er-artists">{artists.map(item=><button key={item.id} disabled={!initialized||Boolean(busy)} aria-label={`Choose ${item.name}`} aria-pressed={artist?.id===item.id} onClick={()=>{setArtist(item);requestId.current="";}}>{item.image?<img src={withBasePath(item.image)} alt=""/>:<span aria-hidden="true">♫</span>}<span><strong>{item.name}</strong><small>{item.genre||"Artist"}</small></span><b aria-hidden="true">{artist?.id===item.id?"✓":"+"}</b></button>)}</div></>:<div className="er-random-artist"><span className="er-random-die" aria-hidden="true"><svg viewBox="0 0 32 32" fill="none"><rect x="4" y="4" width="24" height="24" rx="5" stroke="currentColor" strokeWidth="2"/><circle cx="11" cy="11" r="2" fill="currentColor"/><circle cx="21" cy="21" r="2" fill="currentColor"/><circle cx="16" cy="16" r="2" fill="currentColor"/></svg></span><h3>Meet your mystery headliner.</h3><p>We pick an artist with enough playable songs for a full ten-song match. The artist is revealed in the lobby, and everyone gets the same set.</p><span className="er-random-note">One artist. Ten songs. A fresh challenge.</span></div>}<button className="er-button er-button-primary" disabled={Boolean(busy)||!initialized||!audioEnabled||(artistMode==="chosen"&&!artist)||!nickname.trim()} onClick={()=>void enter("create")}>{busy==="create"?(artistMode==="random"?"Finding your headliner…":"Building your room…"):"Create room"}<span aria-hidden="true">↗</span></button>{busy==="create"&&<p role="status">Preparing ten real songs. A first visit to an artist can take a moment.</p>}</section>}
      <section className="er-panel er-join"><div className="er-panel-number">02 <span>YOU'RE ON THE LIST</span></div><h2>{needsJoin?"Your friends are waiting.":"Got an invite?"}</h2><p>Bring your ears and your best guesses. Enter the six-character code to jump in.</p><label htmlFor="er-code">Room code</label><input id="er-code" disabled={!initialized||Boolean(busy)} className="er-code-input" value={joinCode} maxLength={6} autoCapitalize="characters" autoComplete="off" spellCheck={false} placeholder="ABC123" onChange={event=>setJoinCode(event.target.value.toUpperCase().replace(/[^A-Z0-9]/g,""))}/><button className="er-button er-button-lilac" disabled={Boolean(busy)||!initialized||!audioEnabled||joinCode.length!==6||!nickname.trim()} onClick={()=>void enter("join")}>{busy==="join"?"Joining…":"Join room"}<span aria-hidden="true">↗</span></button><div className="er-invite-doodle" aria-hidden="true"><span>♫</span><span>+1</span><span>♪</span></div><p className="er-fine-print">Headphones recommended. You each hear the same clip on your own device.</p>{needsJoin&&<a href={withBasePath("/rooms")}>Or host your own room ↗</a>}</section></div></section>}</>:<>
      <section className="er-room-strip"><div><span className="er-kicker">{room.phase==="lobby"?"THE ROOM IS YOURS":"ON THE SAME WAVELENGTH"}</span><h1>{room.artist.name}</h1><span className="er-mode-badge">{room.artistMode==="random"?"Random headliner":"Chosen artist"}</span></div><div className="er-room-code"><span>ROOM CODE</span><strong>{room.code}</strong><button className="er-icon-button" onClick={()=>void copy()} aria-label="Copy room invite">{copied?"✓":"↗"}</button></div><button className="er-text-button" onClick={()=>setLeaving(true)}>Leave room</button></section>
      {copyText&&<div className="er-copy-fallback"><label htmlFor="er-share-text">Copy this and send it to your friends</label><textarea id="er-share-text" readOnly value={copyText} onFocus={event=>event.target.select()}/><button onClick={()=>setCopyText("")}>Done</button></div>}
      {room.you.left?<section className="er-panel"><h2>You've left this room.</h2><p>Your earlier answers remain in its scorecard.</p><a className="er-button" href={withBasePath("/rooms")}>Find another encore ↗</a></section>:room.phase==="lobby"?<div className="er-lobby-grid"><section className="er-panel er-lobby"><div className="er-section-heading"><h2>Gather your superfans.</h2><span>{players.length} / 8</span></div><p>Share the room link, then everyone taps Ready up to enable sound.</p><button className="er-button er-button-lilac" onClick={()=>void copy()}>{copied?"Invite copied!":"Copy invite link"}<span aria-hidden="true">↗</span></button><ul className="er-lobby-players">{players.map(player=><li key={player.id}><Avatar value={player.avatar} name={player.name}/><span><strong>{player.name}{player.id===room.youId&&<small>you</small>}</strong><small>{player.id===room.hostId?"★ Host":player.present?"In the room":"Reconnecting…"}</small></span><b className={player.ready?"er-ready":"er-waiting"}>{player.ready?"Ready ✓":"Getting ready"}</b></li>)}</ul>{audio.error&&<p className="er-audio-error" role="alert">{audio.error}</p>}<div className="er-lobby-actions"><button className={`er-button ${room.you.ready?"er-button-outline":"er-button-primary"}`} disabled={Boolean(busy)} onClick={()=>void ready()}>{room.you.ready?"Not ready":"Ready up"}<span aria-hidden="true">{room.you.ready?"↶":"♫"}</span></button>{host&&<button className="er-button er-button-lilac" disabled={Boolean(busy)||!allReady} onClick={()=>void command("start")}>{busy==="start"?"Starting…":"Start the match"}<span aria-hidden="true">▶</span></button>}</div><p className="er-fine-print" role="status">{presentPlayers.length<2?"At least two players must be online to start.":!allReady?"Everyone online must be ready.":host?"Everyone's ready. Give them an encore.":"Everyone's ready. Waiting for the host to start."}</p></section><aside className="er-panel er-rules-card"><span className="er-ticket-icon" aria-hidden="true">♫</span><h2>Know it? Go for it.</h2><ol><li><b>Listen together.</b> Each round starts with the same 15-second clip.</li><li><b>Skip straight to guessing.</b> Recognize it early? Tap Guess now. Audio stops and four titles appear.</li><li><b>Lock it in.</b> You get 15 seconds to pick once guessing starts. One answer, no take-backs.</li><li><b>Accuracy wins.</b> Correct = 1,000 points. Ties use total time on correct answers, including listening.</li></ol><p>Ten rounds. Everyone sees the answer together. Room scores don't change solo stats.</p></aside></div>:room.phase==="complete"?<><section className="er-panel er-finale"><span className="er-kicker">TEN SONGS. ONE BEAUTIFUL SHOWDOWN.</span><div className="er-trophy" aria-hidden="true">✦</div><h2>{!winner.length?"No correct guesses this time.":winner.length>1?"An encore worth sharing.":winner[0]?.id===room.youId?"You owned the encore.":`${winner[0]?.name||"Your room"} takes the spotlight.`}</h2><p>{!winner.length?"A fresh mix could be your comeback. Skipped rounds count toward neither points nor time.":winner.length>1?`${winner.map(player=>player.name).join(" & ")} finish tied on points and time.`:"The points are in. The group chat can take it from here."}</p><div className="er-finale-actions">{host&&<button className="er-button er-button-primary" disabled={Boolean(busy)} onClick={()=>void command("rematch",{requestId:crypto.randomUUID()})}>{busy==="rematch"?(room.artistMode==="random"?"Finding your next headliner…":"Making a fresh mix…"):(room.artistMode==="random"?"New random artist":"Run it back")}<span aria-hidden="true">↻</span></button>}<button className="er-button er-button-lilac" onClick={()=>void copy(true)}>{copied?"Copied!":"Share your result"}<span aria-hidden="true">↗</span></button><button className="er-text-button" onClick={()=>setLeaving(true)}>Choose another artist</button></div>{!host&&<p>Ask the host for a rematch, or start a new room with another artist.</p>}</section><Standings room={room} final/><details className="er-round-history"><summary>The setlist · {room.reveals.filter(reveal=>!reveal.voided).length} scored songs</summary><ol>{room.reveals.map(reveal=><li key={reveal.round}><span>{String(reveal.round+1).padStart(2,"0")}</span><div><strong>{reveal.voided?"Round skipped for everyone":reveal.title}</strong><small>{reveal.voided?"No points or time counted":reveal.answers.find(answer=>answer.playerId===room.youId)?.correct?"You got it ✓":"One for your next listen"}</small></div>{!reveal.voided&&<a href={reveal.url} target="_blank" rel="noreferrer" aria-label={`Listen to ${reveal.title}`}>↗</a>}</li>)}</ol></details></>:<div className="er-game-grid"><section className="er-panel er-stage" aria-label="Current round"><div className="er-stage-top"><strong>Round {room.round+1} of {room.totalRounds}</strong><span>{room.phase==="loading"?"GETTING IN SYNC":room.phase==="reveal"?"THE REVEAL":"NAME THAT SONG"}</span></div><div className="er-round-track" aria-label={`Round ${room.round+1} of ${room.totalRounds}`}>{Array.from({length:room.totalRounds},(_,index)=><i key={index} className={index===room.round?"current":index<room.round?"done":""}/>)}</div>
      {room.phase==="loading"?<div className="er-loading-round"><div className="er-disc er-disc-loading" aria-hidden="true">♫</div><h2>Getting everyone in sync.</h2><p>We load the complete clip on every device before the countdown.</p><strong>{players.filter(player=>player.loaded).length} / {players.length} players have the audio</strong><span>{stageRemaining}s loading window</span>{!audio.enabled?<button className="er-button er-button-primary" onClick={()=>void audio.unlock()}>Enable sound</button>:audio.error?<><p className="er-audio-error" role="alert">{audio.error}</p><button className="er-button er-button-primary" onClick={audio.retry}>Retry audio</button></>:<span className="er-loading-note" role="status">{room.you.loaded?"Your clip is ready ✓":"Loading your clip…"}</span>}{host&&<div className="er-loading-actions"><button className="er-text-button" disabled={Boolean(busy)} onClick={()=>void command("retry")}>Retry for everyone</button><button className="er-text-button" disabled={Boolean(busy)} onClick={()=>void command("skip")}>Skip round for everyone</button></div>}<p className="er-fine-print">If anyone's audio fails, the round is void for everyone. No points or time count.</p></div>:room.phase==="reveal"&&lastReveal?<div className={`er-reveal ${ownReveal?.correct?"is-correct":""}`}><span className="er-verdict">{lastReveal.voided?"A FAIR RESTART":ownReveal?.correct?"THAT'S YOUR SONG. +1,000":ownReveal?.timedOut?"TIME'S UP. NEXT ONE'S YOURS.":"ONE FOR THE PLAYLIST."}</span>{!lastReveal.voided&&<img src={withBasePath(lastReveal.artwork)} alt=""/>}<h2>{lastReveal.voided?"This round won't count.":lastReveal.title}</h2><p>{lastReveal.voided?"A shared listening round needs a working clip for everyone.":lastReveal.artist}</p>{ownReveal?.correct&&!lastReveal.voided&&<strong className="er-reveal-time">Locked in at {seconds(ownReveal.elapsedMs)}</strong>}<ul className="er-reveal-players">{lastReveal.answers.map(answer=>{const player=room.players.find(item=>item.id===answer.playerId);return <li key={answer.playerId}><span>{player?.name||"Player"}</span><strong>{lastReveal.voided?"—":answer.correct?`✓ ${seconds(answer.elapsedMs)}`:answer.timedOut?"Time's up":"Not this one"}</strong></li>;})}</ul><p className="er-next-round">{room.round===room.totalRounds-1?"Your final standings":"Next song"} in {stageRemaining}s</p></div>:<div className="er-playing">
      {countdown>0?<div className="er-countdown" role="status"><span>HEADPHONES ON.</span><strong>{countdown}</strong><p>Same song. Same start. Trust your ears.</p></div>:room.you.answered?<div className="er-locked"><span className="er-lock-symbol" aria-hidden="true">✓</span><h2>{room.you.passed?"You've passed this one.":"Answer locked."}</h2><p>{room.you.passed?"The next song could be yours.":"No spoilers yet. Let's see what your friends heard."}</p><div className="er-answered-pills">{players.map(player=><span key={player.id} className={player.answered?"answered":""}>{player.name} {player.answered?"✓":"…"}</span>)}</div><p className="er-fine-print">The reveal starts when everyone answers or time runs out.</p></div>:room.choices?.length?<div className={`er-guessing ${guessLeft>0&&guessLeft<=5?"is-urgent":""}`}><div className="er-guess-heading"><h2>Which song is it?</h2><div className="er-guess-clock" role="timer" aria-live="off" aria-label={`${Math.ceil(guessLeft)} seconds remaining`}><strong>{String(Math.ceil(guessLeft)).padStart(2,"0")}</strong><span>SEC LEFT</span></div></div><div className="er-time-track" aria-hidden="true"><i style={{width:`${Math.max(0,guessLeft/room.guessSeconds)*100}%`}}/></div><fieldset className="er-choices" disabled={Boolean(busy)||guessLeft<=0}><legend className="sr-only">Which song is it?</legend>{room.choices.map((choice,index)=><button ref={index===0?firstChoice:undefined} key={choice.id} onClick={()=>void command("answer",{choiceId:choice.id})}><span aria-hidden="true">{"ABCD"[index]}</span><strong>{choice.label}</strong><i aria-hidden="true">↗</i></button>)}</fieldset><button className="er-text-button" disabled={Boolean(busy)||guessLeft<=0} onClick={()=>void command("pass")}>Pass this song</button><p className="er-fine-print">{guessLeft<=0?"Time's up. Waiting for the room…":"One answer. Make it count."}</p></div>:<div className="er-listening"><div className={`er-disc ${audio.status==="playing"?"is-spinning":""}`} aria-hidden="true"><span>♫</span></div><h2>You know this one?</h2><p>Don't wait for the chorus if you already know.</p><div className="er-wave" aria-hidden="true">{Array.from({length:27},(_,index)=><i key={index} style={{height:`${20+Math.abs(Math.sin(index*1.9))*75}%`,animationDelay:`${index*-.08}s`}}/>)}</div><span className="er-clip-clock">{Math.max(0,Math.min(15,Math.ceil(clipLeft)))}s of audio left</span>{(audio.status==="locked"||!audio.enabled)&&<button className="er-button er-button-outline" onClick={()=>void audio.unlock()}>Enable sound</button>}{audio.error&&<p className="er-audio-error" role="alert">{audio.error} Your round timer keeps running.</p>}<button className="er-button er-button-primary er-guess-now" disabled={Boolean(busy)||!listening} onClick={()=>void guess()}>{busy==="guess"?"Opening answers…":"Guess now"}<span aria-hidden="true">↗</span></button><p className="er-fine-print">Stops the audio. Starts your 15-second answer timer.</p></div>}
      </div>}</section><Standings room={room}/></div>}
    </>}
    </main><footer className="er-footer"><a href={withBasePath("/")}>← Encore solo</a><span>Same music. Better company.</span><a href={hubUrl}>All games ↗</a></footer>
    <dialog ref={leaveDialog} className="er-leave-dialog" aria-labelledby="er-leave-title" onCancel={()=>setLeaving(false)} onClick={event=>{if(event.target===event.currentTarget)setLeaving(false);}}><h2 id="er-leave-title">Leaving the encore?</h2><p>{room?.phase==="lobby"?"Your friends can keep the room going. Host duties pass to another player if needed.":"Your earlier answers stay in the standings. You can't rejoin a match after leaving it."}</p><div><button className="er-button er-button-outline" autoFocus disabled={Boolean(busy)} onClick={()=>setLeaving(false)}>Stay in the room</button><button className="er-button er-button-lilac" disabled={Boolean(busy)} onClick={()=>void leave()}>{busy==="leave"?"Leaving…":"Leave room"}</button></div></dialog>
    <dialog className="er-help" ref={help} onClick={event=>{if(event.target===event.currentTarget)help.current?.close();}}><button className="close" aria-label="Close room rules" onClick={()=>help.current?.close()}>×</button><h2>Your friends. Your encore.</h2><ol><li>Host chooses an artist or selects Surprise us for a random headliner. The whole room gets the same artist. Share the invite link or six-character code with 1–7 friends.</li><li>Everyone taps Ready up to enable sound. Each song is loaded on every device before a shared countdown.</li><li>Hear up to 15 seconds. Know it early? Tap Guess now to stop listening and reveal four song titles.</li><li>You have 15 seconds after entering guessing to lock in one answer. You cannot replay the clip after entering guessing.</li><li>Each correct answer earns 1,000 points. Ties are ranked by the lowest combined time on correct answers, measured from the shared clip start. Speed alone never beats accuracy.</li><li>All ten rounds use the same songs for everyone. Answers appear together after everyone submits or their timer ends. Failed audio loading voids the round for everyone.</li></ol><p>Keep your tab open. Leaving or hiding it stops sound; the match clock continues. Room results stay separate from Encore solo stats.</p><button className="er-button er-button-primary" onClick={()=>help.current?.close()}>Let's hear it ↗</button></dialog>
  </div>;
}
