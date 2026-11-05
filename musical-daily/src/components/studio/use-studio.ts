"use client";

import {useCallback,useEffect,useRef,useState} from "react";
import {StudioEngine} from "@/lib/studio/engine";
import {StudioRecorder,MAX_RECORDING_SECONDS,type RecordedTake} from "@/lib/studio/recording";
import {PATTERNS} from "@/lib/studio/patterns";
import {DRUMS,copyPattern,emptyPattern,type DrumId,type Instrument,type Pattern} from "@/lib/studio/types";
import {useSound} from "../sound-client";

export type CaptureState="empty"|"arming"|"recording"|"saving"|"ready";
const KEY_CODES=["KeyA","KeyW","KeyS","KeyE","KeyD","KeyF","KeyT","KeyG","KeyY","KeyH","KeyU","KeyJ","KeyK","KeyO","KeyL","KeyP","Semicolon","Quote","BracketRight","Backslash","KeyZ","KeyX","KeyC","KeyV","KeyB"];
const KEY_LABELS=["A","W","S","E","D","F","T","G","Y","H","U","J","K","O","L","P",";","'","]","\\","Z","X","C","V","B"];
export const NOTE_KEYS=KEY_CODES.map((code,offset)=>({code,label:KEY_LABELS[offset],offset}));
const NOTE_NAMES=["C","C♯","D","D♯","E","F","F♯","G","G♯","A","A♯","B"];
export const midiLabel=(midi:number)=>`${NOTE_NAMES[((midi%12)+12)%12]}${Math.floor(midi/12)-1}`;
const INITIAL=PATTERNS.find(preset=>preset.id==="lofi")!;
const INITIAL_LEVELS:Record<DrumId,number>={kick:.85,snare:.65,clap:.6,hat:.45,openhat:.4,tom:.7};
const clamp=(value:number,min:number,max:number)=>Math.max(min,Math.min(max,value));
const message=(error:unknown)=>error instanceof Error?error.message:"Audio could not start. Please try again.";

export function useStudio(){
  const {setMusic,setPreviewing}=useSound();
  const [ready,setReady]=useState(false);
  const [instrument,instrumentState]=useState<Instrument>("keys");
  const [octave,octaveState]=useState(4);
  const [tempo,tempoState]=useState(INITIAL.bpm);
  const [swing,swingState]=useState(INITIAL.swing);
  const [volume,volumeState]=useState(.72);
  const [tone,toneState]=useState(.64);
  const [muted,mutedState]=useState(false);
  const [pattern,patternState]=useState<Pattern>(()=>copyPattern(INITIAL.pattern));
  const [presetId,presetState]=useState(INITIAL.id);
  const [drumLevels,drumLevelsState]=useState({...INITIAL_LEVELS});
  const [transport,setTransport]=useState(false);
  const [step,setStep]=useState(-1);
  const [activeNotes,setActiveNotes]=useState<number[]>([]);
  const [activeDrums,setActiveDrums]=useState<DrumId[]>([]);
  const [capture,captureState]=useState<CaptureState>("empty");
  const [elapsed,setElapsed]=useState(0);
  const [take,setTake]=useState<RecordedTake|null>(null);
  const [takeUrl,setTakeUrl]=useState<string|null>(null);
  const [downloadName,setDownloadName]=useState("musical-daily-rhythm-lab.wav");
  const [playback,setPlayback]=useState(false);
  const [playhead,setPlayhead]=useState(0);
  const [error,setError]=useState("");
  const [notice,setNotice]=useState("Your studio is ready. Play a key, tap a pad, or start the beat.");

  const engine=useRef<StudioEngine|null>(null);
  const recorder=useRef<StudioRecorder|null>(null);
  const mounted=useRef(false);
  const generation=useRef(0);
  const captureRef=useRef<CaptureState>("empty");
  const urlRef=useRef<string|null>(null);
  const takeRef=useRef<RecordedTake|null>(null);
  const playingRef=useRef(false);
  const playbackGeneration=useRef(0);
  const transportRef=useRef(false);
  const transportGeneration=useRef(0);
  const voices=useRef(new Map<string,number>());
  const drumTimers=useRef(new Map<DrumId,ReturnType<typeof setTimeout>>());
  const startedAt=useRef(0);
  const finish=useRef<(reason?:string)=>Promise<void>>(async()=>{});
  const meterRef=useRef<HTMLDivElement>(null);
  const audioRef=useRef<HTMLAudioElement>(null);
  const settings=useRef({instrument:"keys" as Instrument,octave:4,tempo:INITIAL.bpm,swing:INITIAL.swing,volume:.72,tone:.64,muted:false,pattern:copyPattern(INITIAL.pattern),levels:{...INITIAL_LEVELS}});

  const updateCapture=useCallback((value:CaptureState)=>{captureRef.current=value;if(mounted.current)captureState(value);},[]);
  const releaseKeys=useCallback(()=>{
    voices.current.clear();engine.current?.allNotesOff();
    if(mounted.current)setActiveNotes([]);
  },[]);
  const silence=useCallback(()=>{
    transportGeneration.current++;transportRef.current=false;
    engine.current?.stopAll();voices.current.clear();
    for(const timer of drumTimers.current.values())clearTimeout(timer);
    drumTimers.current.clear();
    if(mounted.current){setTransport(false);setStep(-1);setActiveNotes([]);setActiveDrums([]);}
    meterRef.current?.style.setProperty("--level","0");
    meterRef.current?.closest<HTMLElement>(".studio-shell")?.style.setProperty("--studio-signal","0");
  },[]);
  const pausePlayback=useCallback(()=>{++playbackGeneration.current;audioRef.current?.pause();playingRef.current=false;if(mounted.current)setPlayback(false);},[]);

  const stopRecording=useCallback(async(reason?:string)=>{
    if(captureRef.current!=="recording")return;
    const current=recorder.current,version=generation.current;
    if(!current)return;
    updateCapture("saving");silence();
    try{
      const result=await current.stop();
      if(!mounted.current||version!==generation.current)return;
      recorder.current=null;current.dispose();
      if(!result||!result.frames){updateCapture("empty");setElapsed(0);setNotice("No audio frames were captured. Start another recording when you’re ready.");return;}
      if(urlRef.current)URL.revokeObjectURL(urlRef.current);
      const url=URL.createObjectURL(result.blob);urlRef.current=url;takeRef.current=result;
      setDownloadName(`rhythm-lab-${new Date().toISOString().replace(/[.:]/g,"-")}.wav`);
      setTake(result);setTakeUrl(url);setElapsed(result.duration);setPlayhead(0);updateCapture("ready");
      setNotice(reason||"Your take is ready. Listen back, download it, or start a fresh recording.");
    }catch(cause){
      if(mounted.current&&version===generation.current){current.dispose();recorder.current=null;updateCapture("empty");setError(message(cause));}
    }
  },[silence,updateCapture]);
  useEffect(()=>{finish.current=stopRecording;},[stopRecording]);

  const newRecording=useCallback(()=>{
    ++generation.current;silence();pausePlayback();
    recorder.current?.dispose();recorder.current=null;
    if(audioRef.current){audioRef.current.removeAttribute("src");audioRef.current.load();}
    if(urlRef.current)URL.revokeObjectURL(urlRef.current);
    urlRef.current=null;takeRef.current=null;setTake(null);setTakeUrl(null);setDownloadName("musical-daily-rhythm-lab.wav");setPlayhead(0);setElapsed(0);updateCapture("empty");setError("");
    setNotice("Fresh tape. The previous in-browser take is discarded. Press Start recording when you’re ready.");
  },[pausePlayback,silence,updateCapture]);

  const startRecording=useCallback(async()=>{
    if(!engine.current||captureRef.current!=="empty")return;
    if(settings.current.muted||settings.current.volume===0){setError("Turn up the live volume and unmute the studio before recording.");return;}
    const currentEngine=engine.current,version=++generation.current;
    pausePlayback();setError("");setElapsed(0);updateCapture("arming");setNotice("Preparing your recording…");
    try{
      await currentEngine.unlock();
      if(!mounted.current||version!==generation.current)return;
      const context=currentEngine.getContext(),source=currentEngine.getRecordingSource();
      if(!context||!source)throw new Error("Tap a key to enable audio, then try recording again.");
      const current=new StudioRecorder(context,source,{
        onLimit:()=>{void finish.current("Five-minute take captured. Download it, or choose New recording to keep creating.");},
        onError:(detail)=>{if(mounted.current&&version===generation.current){setError(detail);void finish.current("Recording was interrupted. Your captured audio is ready to review.");}},
      });
      recorder.current=current;await current.start();
      if(!mounted.current||version!==generation.current){current.dispose();return;}
      startedAt.current=context.currentTime;updateCapture("recording");setNotice("Recording your studio. Everything you play from here is in the take.");
    }catch(cause){
      if(mounted.current&&version===generation.current){recorder.current?.dispose();recorder.current=null;updateCapture("empty");setError(message(cause));setNotice("The take did not start. Your instruments are still available.");}
    }
  },[pausePlayback,updateCapture]);

  const stopAll=useCallback(()=>{
    silence();pausePlayback();
    if(captureRef.current==="recording")void finish.current();
    else if(captureRef.current==="arming"){++generation.current;recorder.current?.dispose();recorder.current=null;updateCapture("empty");setNotice("Recording cancelled. Ready when you are.");}
  },[pausePlayback,silence,updateCapture]);

  const inputAvailable=useCallback(()=>mounted.current&&!playingRef.current&&!document.hidden&&!["arming","saving"].includes(captureRef.current),[]);
  const startNote=useCallback((id:string,midi:number)=>{
    if(!inputAvailable()||voices.current.has(id)||!Number.isInteger(midi)||midi<36||midi>108)return;
    voices.current.set(id,midi);setActiveNotes([...new Set(voices.current.values())]);
    void engine.current?.noteOn(id,midi,settings.current.instrument);
  },[inputAvailable]);
  const stopNote=useCallback((id:string)=>{
    voices.current.delete(id);engine.current?.noteOff(id);
    if(mounted.current)setActiveNotes([...new Set(voices.current.values())]);
  },[]);
  const hitDrum=useCallback((drum:DrumId)=>{
    if(!inputAvailable())return;
    void engine.current?.hit(drum);
    const previous=drumTimers.current.get(drum);if(previous)clearTimeout(previous);
    setActiveDrums(current=>[...new Set([...current,drum])]);
    const timer=setTimeout(()=>{drumTimers.current.delete(drum);if(mounted.current)setActiveDrums(current=>current.filter(id=>id!==drum));},150);
    drumTimers.current.set(drum,timer);
  },[inputAvailable]);

  const toggleTransport=useCallback(async()=>{
    if(!engine.current||!inputAvailable())return;
    const version=++transportGeneration.current;
    if(transportRef.current){transportRef.current=false;engine.current.stopSequencer();setTransport(false);return;}
    transportRef.current=true;setTransport(true);setError("");
    await engine.current.startSequencer();
    if(mounted.current&&version===transportGeneration.current&&engine.current?.getContext()?.state!=="running"){transportRef.current=false;setTransport(false);}
  },[inputAvailable]);

  const setInstrument=useCallback((value:Instrument)=>{
    if(!["keys","synth","bass","bell"].includes(value))return;
    releaseKeys();settings.current.instrument=value;instrumentState(value);
  },[releaseKeys]);
  const changeOctave=useCallback((delta:number)=>{
    if(!Number.isFinite(delta))return;releaseKeys();const value=clamp(settings.current.octave+Math.trunc(delta),2,6);settings.current.octave=value;octaveState(value);
  },[releaseKeys]);
  const setTempo=useCallback((value:number)=>{if(Number.isFinite(value)){value=clamp(Math.round(value),60,200);settings.current.tempo=value;tempoState(value);engine.current?.setTempo(value);}},[]);
  const setSwing=useCallback((value:number)=>{if(Number.isFinite(value)){value=clamp(value,0,.5);settings.current.swing=value;swingState(value);engine.current?.setSwing(value);}},[]);
  const setVolume=useCallback((value:number)=>{if(Number.isFinite(value)){value=clamp(value,0,1);settings.current.volume=value;volumeState(value);engine.current?.setMasterVolume(settings.current.muted?0:value);}},[]);
  const setTone=useCallback((value:number)=>{if(Number.isFinite(value)){value=clamp(value,0,1);settings.current.tone=value;toneState(value);engine.current?.setTone(value);}},[]);
  const setMuted=useCallback((value:boolean)=>{settings.current.muted=value;mutedState(value);engine.current?.setMasterVolume(value?0:settings.current.volume);if(audioRef.current)audioRef.current.muted=value;},[]);
  const setDrumLevel=useCallback((drum:DrumId,value:number)=>{
    if(!DRUMS.some(item=>item.id===drum)||!Number.isFinite(value))return;
    value=clamp(value,0,1);const next={...settings.current.levels,[drum]:value};settings.current.levels=next;drumLevelsState(next);engine.current?.setDrumLevel(drum,value);
  },[]);
  const toggleStep=useCallback((drum:DrumId,index:number)=>{
    if(!DRUMS.some(item=>item.id===drum)||!Number.isInteger(index)||index<0||index>=16)return;
    const next=copyPattern(settings.current.pattern);next[drum][index]=!next[drum][index];settings.current.pattern=next;patternState(next);presetState("custom");engine.current?.setPattern(next);
  },[]);
  const clearPattern=useCallback(()=>{const next=emptyPattern();settings.current.pattern=next;patternState(next);presetState("empty");engine.current?.setPattern(next);setNotice("Blank canvas. Tap the steps to build your beat.");},[]);
  const loadPreset=useCallback((id:string)=>{
    const preset=PATTERNS.find(item=>item.id===id);if(!preset)return;
    const next=copyPattern(preset.pattern);settings.current.pattern=next;patternState(next);presetState(id);engine.current?.setPattern(next);
    setTempo(preset.bpm);setSwing(preset.swing);setNotice(`${preset.name} loaded. Make it your own.`);
  },[setSwing,setTempo]);

  const togglePlayback=useCallback(async()=>{
    const player=audioRef.current;
    if(!player||!takeRef.current||captureRef.current!=="ready")return;
    if(playingRef.current){pausePlayback();return;}
    silence();setError("");const version=generation.current,operation=++playbackGeneration.current;
    if(player.ended||player.currentTime>=takeRef.current.duration)player.currentTime=0;
    player.muted=settings.current.muted;
    playingRef.current=true;setPlayback(true);
    try{await player.play();}
    catch(cause){if(mounted.current&&version===generation.current&&operation===playbackGeneration.current&&takeRef.current){playingRef.current=false;setPlayback(false);setError(`Playback could not start. ${message(cause)}`);}}
  },[pausePlayback,silence]);
  const seekPlayback=useCallback((seconds:number)=>{
    if(!audioRef.current||!takeRef.current||!Number.isFinite(seconds))return;
    const next=clamp(seconds,0,takeRef.current.duration);audioRef.current.currentTime=next;setPlayhead(next);
  },[]);

  useEffect(()=>{
    mounted.current=true;
    const audio=new StudioEngine({
      onStep:next=>{if(mounted.current)setStep(next);},
      onMeter:level=>{meterRef.current?.style.setProperty("--level",String(level));meterRef.current?.closest<HTMLElement>(".studio-shell")?.style.setProperty("--studio-signal",String(level));},
      onError:detail=>{if(mounted.current){setError(detail);if(engine.current?.getContext()?.state!=="running"){transportRef.current=false;setTransport(false);setStep(-1);}}},
    });
    engine.current=audio;const s=settings.current;
    audio.setPattern(s.pattern);audio.setTempo(s.tempo);audio.setSwing(s.swing);audio.setMasterVolume(s.muted?0:s.volume);audio.setTone(s.tone);
    for(const drum of DRUMS)audio.setDrumLevel(drum.id,s.levels[drum.id]);
    setMusic(false);setPreviewing(true);
    const frame=requestAnimationFrame(()=>{if(mounted.current)setReady(true);});
    return()=>{
      mounted.current=false;++generation.current;++transportGeneration.current;cancelAnimationFrame(frame);
      recorder.current?.dispose();recorder.current=null;audioRef.current?.pause();
      audio.dispose();if(engine.current===audio)engine.current=null;
      for(const timer of drumTimers.current.values())clearTimeout(timer);drumTimers.current.clear();voices.current.clear();
      if(urlRef.current)URL.revokeObjectURL(urlRef.current);urlRef.current=null;takeRef.current=null;
      setPreviewing(false);
    };
  },[setMusic,setPreviewing]);

  useEffect(()=>{
    if(capture!=="recording")return;
    const timer=setInterval(()=>{
      const context=engine.current?.getContext();
      if(context)setElapsed(clamp(context.currentTime-startedAt.current,0,MAX_RECORDING_SECONDS));
    },100);
    return()=>clearInterval(timer);
  },[capture]);

  useEffect(()=>{
    const textTarget=(target:EventTarget|null)=>target instanceof Element&&!!target.closest("input,select,textarea,[contenteditable]:not([contenteditable=false]),[role=textbox]");
    const down=(event:KeyboardEvent)=>{
      if(event.repeat||event.ctrlKey||event.metaKey||event.altKey||textTarget(event.target)||document.querySelector("dialog[open]"))return;
      const note=NOTE_KEYS.find(key=>key.code===event.code);
      if(note){event.preventDefault();startNote(`kbd:${event.code}`,12*(settings.current.octave+1)+note.offset);return;}
      const drum=DRUMS.find(item=>event.code===`Digit${item.shortcut}`||event.code===`Numpad${item.shortcut}`);
      if(drum){event.preventDefault();hitDrum(drum.id);return;}
      if(event.code==="Minus"||event.code==="Equal"){event.preventDefault();changeOctave(event.code==="Minus"?-1:1);return;}
      if(event.code==="Space"&&!(event.target instanceof Element&&event.target.closest("button,a,summary"))){event.preventDefault();void toggleTransport();}
      if(event.code==="Escape"){event.preventDefault();stopAll();}
    };
    const up=(event:KeyboardEvent)=>{if(NOTE_KEYS.some(key=>key.code===event.code))stopNote(`kbd:${event.code}`);};
    const blur=()=>{releaseKeys();};
    const hidden=()=>{
      if(document.visibilityState!=="hidden")return;
      silence();pausePlayback();
      if(captureRef.current==="recording")void finish.current("We stopped when you left the studio. Your captured take is ready.");
      else if(captureRef.current==="arming"){++generation.current;recorder.current?.dispose();recorder.current=null;updateCapture("empty");}
    };
    const pagehide=()=>{silence();pausePlayback();if(captureRef.current==="recording")void finish.current();};
    window.addEventListener("keydown",down);window.addEventListener("keyup",up);window.addEventListener("blur",blur);
    document.addEventListener("visibilitychange",hidden);window.addEventListener("pagehide",pagehide);
    return()=>{window.removeEventListener("keydown",down);window.removeEventListener("keyup",up);window.removeEventListener("blur",blur);document.removeEventListener("visibilitychange",hidden);window.removeEventListener("pagehide",pagehide);};
  },[changeOctave,hitDrum,pausePlayback,releaseKeys,silence,startNote,stopAll,stopNote,toggleTransport,updateCapture]);

  return {ready,instrument,octave,tempo,swing,volume,tone,muted,pattern,presetId,drumLevels,transport,step,activeNotes,activeDrums,capture,elapsed,take,takeUrl,downloadName,playback,playhead,error,notice,
    setInstrument,changeOctave,setTempo,setSwing,setVolume,setTone,setMuted,toggleStep,setDrumLevel,loadPreset,clearPattern,toggleTransport,stopAll,startNote,stopNote,hitDrum,startRecording,stopRecording,newRecording,togglePlayback,seekPlayback,dismissError:()=>setError(""),meterRef,audioRef,
    audioProps:{onTimeUpdate:()=>{if(audioRef.current)setPlayhead(audioRef.current.currentTime);},onEnded:()=>{playingRef.current=false;setPlayback(false);setPlayhead(takeRef.current?.duration||0);},onPause:()=>{playingRef.current=false;if(mounted.current)setPlayback(false);},onPlay:()=>{if(!takeRef.current||captureRef.current!=="ready"){audioRef.current?.pause();return;}if(audioRef.current?.paused)return;playingRef.current=true;if(mounted.current)setPlayback(true);}},
  };
}
