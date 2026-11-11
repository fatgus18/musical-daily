"use client";

import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent } from "react";
import { HubHeader } from "../hub-header";
import { ArcadeMascot } from "../arcade-mascot";
import { DRUMS, INSTRUMENTS, STEPS, type DrumId } from "@/lib/studio/types";
import { PATTERNS } from "@/lib/studio/patterns";
import { useStudio, NOTE_KEYS, midiLabel } from "./use-studio";

function Icon({ name, size = 18 }: { name: "play" | "stop" | "record" | "pause" | "download" | "volume" | "mute" | "reset" | "arrow" | "keys" | "spark"; size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{name === "play" ? <path d="m8 5 11 7-11 7V5Z" fill="currentColor" stroke="none"/> : name === "stop" ? <rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" stroke="none"/> : name === "record" ? <circle cx="12" cy="12" r="6" fill="currentColor" stroke="none"/> : name === "pause" ? <><path d="M8 5v14M16 5v14" strokeWidth="4"/></> : name === "download" ? <><path d="M12 3v12m-5-5 5 5 5-5M4 16v4h16v-4"/></> : name === "volume" || name === "mute" ? <><path d="m11 4-6 5H2v6h3l6 5V4Z"/>{name === "mute" ? <path d="m16 9 6 6m-6 0 6-6"/> : <><path d="M15 8a6 6 0 0 1 0 8M18 4a11 11 0 0 1 0 16"/></>}</> : name === "reset" ? <><path d="M4 10a8 8 0 1 1 1 7M4 4v6h6"/></> : name === "arrow" ? <path d="M5 12h14m-5-5 5 5-5 5"/> : name === "keys" ? <><rect x="3" y="4" width="18" height="16" rx="3"/><path d="M8 4v10h3V4m2 0v10h3V4M9 14v6m6-6v6"/></> : <path d="m12 2 1.7 7.7L22 12l-8.3 2.3L12 22l-1.7-7.7L2 12l8.3-2.3L12 2Z"/>}</svg>;
}

function clock(seconds: number) { const safe = Number.isFinite(seconds) ? Math.max(0, seconds) : 0; return `${Math.floor(safe / 60).toString().padStart(2, "0")}:${Math.floor(safe % 60).toString().padStart(2, "0")}`; }
const blackOffsets = [1, 3, 6, 8, 10];
const isBlack = (offset: number) => blackOffsets.includes(offset % 12);
const whiteBefore = (offset: number) => Array.from({ length: offset }, (_, index) => index).filter(index => !isBlack(index)).length;

export default function RhythmStudio() {
  const lab = useStudio();
  const help = useRef<HTMLDialogElement>(null);
  const controls = useRef<HTMLElement>(null);
  const grid = useRef<HTMLDivElement>(null);
  const assistiveTaps = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const [focusedStep, setFocusedStep] = useState("kick:0");
  const recording = lab.capture === "recording";
  const captureBusy = lab.capture === "arming" || lab.capture === "saving";
  const liveBlocked = !lab.ready || captureBusy || lab.playback;
  const rootMidi = 12 * (lab.octave + 1);
  const stopNote = lab.stopNote;
  useEffect(() => {
    const taps = assistiveTaps.current;
    return () => { for (const [id, timer] of taps) { clearTimeout(timer); stopNote(id); } taps.clear(); };
  }, [stopNote]);
  const assistiveTap = (midi: number) => {
    if (liveBlocked) return;
    const id = `assistive:${midi}`;
    const previous = assistiveTaps.current.get(id);
    if (previous) { clearTimeout(previous); lab.stopNote(id); }
    lab.startNote(id, midi);
    assistiveTaps.current.set(id, setTimeout(() => { lab.stopNote(id); assistiveTaps.current.delete(id); }, 250));
  };
  const recordLabel = recording ? "Stop recording" : lab.capture === "arming" ? "Preparing recorder" : lab.capture === "saving" ? "Saving recording" : lab.capture === "ready" ? "Recording ready" : "Start recording";
  const noteDown = (event: PointerEvent<HTMLButtonElement>, midi: number) => {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    lab.startNote(`ptr:${event.pointerId}`, midi);
  };
  const noteUp = (event: PointerEvent<HTMLButtonElement>) => lab.stopNote(`ptr:${event.pointerId}`);
  const keyDown = (event: KeyboardEvent<HTMLButtonElement>, midi: number) => {
    if (!["Enter", " "].includes(event.key) || event.ctrlKey || event.metaKey || event.altKey) return;
    event.preventDefault();
    if (event.repeat) return;
    lab.startNote(`button:${midi}`, midi);
  };
  const keyUp = (event: KeyboardEvent<HTMLButtonElement>, midi: number) => {
    if (!["Enter", " "].includes(event.key)) return;
    event.preventDefault(); lab.stopNote(`button:${midi}`);
  };
  const moveStep = (event: KeyboardEvent<HTMLButtonElement>, drum: DrumId, step: number) => {
    const row = DRUMS.findIndex(item => item.id === drum);
    const target = event.key === "ArrowLeft" ? [row, (step + STEPS - 1) % STEPS] : event.key === "ArrowRight" ? [row, (step + 1) % STEPS] : event.key === "ArrowUp" ? [(row + DRUMS.length - 1) % DRUMS.length, step] : event.key === "ArrowDown" ? [(row + 1) % DRUMS.length, step] : event.key === "Home" ? [row, 0] : event.key === "End" ? [row, STEPS - 1] : null;
    if (!target) return;
    event.preventDefault(); grid.current?.querySelector<HTMLButtonElement>(`[data-drum="${DRUMS[target[0]].id}"][data-step="${target[1]}"]`)?.focus();
  };
  const waveform = lab.take?.peaks || Array.from({ length: 80 }, () => 0);
  const fraction = lab.take?.duration ? Math.min(1, lab.playhead / lab.take.duration) : 0;
  const newTake = () => {
    lab.newRecording();
    requestAnimationFrame(() => {
      controls.current?.scrollIntoView({ block: "start" });
      controls.current?.querySelector<HTMLButtonElement>(".studio-record-button")?.focus({ preventScroll: true });
    });
  };

  return <div className="studio-shell" data-sound="off">
    <a href="#studio-keys" className="skip-link">Skip to instruments</a>
    <HubHeader active="studio" />
    <div className="studio-atmosphere" aria-hidden="true"><div className="studio-orbit"/><b>✳</b></div>
    {recording && <div className="studio-recording-dock"><div><span><i/> REC</span><output aria-label="Recording duration">{clock(lab.elapsed)}</output><button type="button" onClick={() => void lab.stopRecording()} aria-label="Stop current recording"><Icon name="stop" size={14}/><span>Stop</span></button></div></div>}
    <main className="studio-page" aria-busy={!lab.ready}>
      <header className="studio-intro"><div><h1>Rhythm Lab<span>Make something yours.</span></h1><p className="studio-subtitle">A few keys. A little rhythm. Whatever’s in your head.</p></div><ArcadeMascot className="studio-buddy" playing={lab.transport || lab.activeNotes.length > 0 || lab.activeDrums.length > 0}/><button className="studio-guide-button" type="button" onClick={() => help.current?.showModal()}><Icon name="keys"/><span>How to play</span><b>?</b></button></header>

      {lab.error && <div className="studio-error" role="alert"><span>{lab.error}</span><button type="button" onClick={lab.dismissError} aria-label="Dismiss studio error">×</button></div>}
      <div className="studio-notice" role="status" aria-live="polite">{lab.notice}{lab.take && <a className="studio-take-jump" href="#studio-take">Listen or download <Icon name="arrow" size={16}/></a>}</div>

      <section ref={controls} className="studio-transport" aria-label="Studio controls">
        <div className="studio-transport-actions"><button className={`studio-beat-button${lab.transport ? " is-playing" : ""}`} type="button" onClick={lab.toggleTransport} disabled={liveBlocked} aria-pressed={lab.transport} aria-label={lab.transport ? "Stop beat" : "Play beat"}><Icon name={lab.transport ? "stop" : "play"}/><span>{lab.transport ? "Stop beat" : "Play beat"}</span></button><button className={`studio-record-button${recording ? " is-recording" : ""}`} type="button" onClick={() => { if (recording) void lab.stopRecording(); else void lab.startRecording(); }} disabled={!lab.ready || captureBusy || lab.capture === "ready"} aria-label={recordLabel}><Icon name={recording ? "stop" : "record"}/><span>{recording ? `Stop · ${clock(lab.elapsed)}` : lab.capture === "ready" ? "Take ready" : captureBusy ? "One moment…" : "Record"}</span></button><button className="studio-panic" type="button" onClick={lab.stopAll} title="Stop all live sound" aria-label="Stop all sound"><Icon name="stop" size={16}/></button></div>
        <label className="studio-tempo-control"><span>TEMPO <output>{lab.tempo}<small>BPM</small></output></span><input aria-label="Tempo" type="range" min="60" max="200" step="1" value={lab.tempo} onChange={event => lab.setTempo(Number(event.target.value))}/></label>
        <label className="studio-swing-control"><span>SWING <output>{Math.round(lab.swing * 100)}<small>%</small></output></span><input aria-label="Swing" type="range" min="0" max="50" step="1" value={Math.round(lab.swing * 100)} onChange={event => lab.setSwing(Number(event.target.value) / 100)}/></label>
        <div className="studio-master-control"><button type="button" aria-label={lab.muted ? "Unmute studio" : "Mute studio"} aria-pressed={lab.muted} onClick={() => lab.setMuted(!lab.muted)}><Icon name={lab.muted ? "mute" : "volume"}/></button><label><span>LIVE VOLUME <output>{Math.round(lab.volume * 100)}%</output></span><input aria-label="Live volume" type="range" min="0" max="100" value={Math.round(lab.volume * 100)} onChange={event => lab.setVolume(Number(event.target.value) / 100)}/></label><div ref={lab.meterRef} className="studio-output-meter" aria-hidden="true"><i/><span>OUT</span></div></div>
      </section>

      <div className="studio-workspace">
        <section className="studio-panel studio-keys-panel" aria-labelledby="studio-keys-title" id="studio-keys">
          <div className="studio-panel-heading"><div><div><h2 id="studio-keys-title">The keys<span>✳</span></h2></div></div><span className="studio-chip">POLYPHONIC / PLAY CHORDS</span></div>
          <div className="studio-instruments" role="group" aria-label="Choose instrument">{INSTRUMENTS.map(instrument => <button key={instrument.id} type="button" aria-pressed={lab.instrument === instrument.id} onClick={() => lab.setInstrument(instrument.id)}><i className={`studio-instrument-icon instrument-${instrument.id}`}/>{instrument.label}</button>)}</div>
          <div className="studio-keyboard-tools"><div className="studio-octave"><span>OCTAVE</span><button type="button" aria-label="Lower octave" onClick={() => lab.changeOctave(-1)} disabled={lab.octave <= 2}>−</button><output aria-label="Current octave">C{lab.octave}<small> — C{lab.octave + 2}</small></output><button type="button" aria-label="Higher octave" onClick={() => lab.changeOctave(1)} disabled={lab.octave >= 6}>+</button></div><label className="studio-tone"><span>SOFT</span><input aria-label="Tone" type="range" min="0" max="100" value={Math.round(lab.tone * 100)} onChange={event => lab.setTone(Number(event.target.value) / 100)}/><span>BRIGHT</span></label></div>
          <div className="studio-keyboard" role="group" aria-label="Piano keys">{NOTE_KEYS.map(key => {
            const midi = rootMidi + key.offset;
            const black = isBlack(key.offset);
            return <button type="button" key={key.offset} disabled={liveBlocked} className={`studio-piano-key ${black ? "is-black" : "is-white"}${lab.activeNotes.includes(midi) ? " is-down" : ""}${key.offset > 12 ? " second-octave" : ""}`} style={{ "--key-position": whiteBefore(key.offset) } as CSSProperties} aria-label={`${midiLabel(midi)} key`} aria-pressed={lab.activeNotes.includes(midi)} data-midi={midi} onClick={event => { if (event.detail === 0) assistiveTap(midi); }} onPointerDown={event => noteDown(event, midi)} onPointerUp={noteUp} onPointerCancel={noteUp} onLostPointerCapture={noteUp} onKeyDown={event => keyDown(event, midi)} onKeyUp={event => keyUp(event, midi)} onBlur={() => lab.stopNote(`button:${midi}`)} onContextMenu={event => event.preventDefault()}><span className="studio-note-name"><span>{midiLabel(midi).slice(0, -1)}</span><span className="studio-note-octave">{midiLabel(midi).slice(-1)}</span></span><kbd>{key.label}</kbd></button>;
          })}</div>
          <div className="studio-keyboard-caption"><span><i/> KEYBOARD, MOUSE & TOUCH</span><p>Hold a key. Layer a chord. Make it your own.</p></div>
        </section>

        <section className={`studio-panel studio-recorder${recording ? " is-recording" : ""}`} aria-label="Your recording" id="studio-take">
          <div className="studio-panel-heading"><div><div><h2>The take<span>↗</span></h2></div></div><span className={`studio-rec-light${recording ? " on" : ""}`}/></div>
          <div className="studio-tape" aria-hidden="true"><div className="studio-tape-label"/><div className={`studio-tape-window${recording || lab.playback ? " is-moving" : ""}`}><div className="studio-tape-reel"><i/></div><div className="studio-tape-bridge"><i/><i/><i/><i/><i/><i/><i/></div><div className="studio-tape-reel"><i/></div></div><div className="studio-tape-bottom"><i/><i/></div></div>
          <div className="studio-take-status"><span>{recording ? "RECORDING" : lab.capture === "arming" ? "GETTING READY" : lab.capture === "saving" ? "FINISHING YOUR TAKE" : lab.take ? "READY TO LISTEN" : "WAITING FOR YOUR FIRST NOTE"}</span><strong>{clock(lab.take?.duration || lab.elapsed)}<small> / 05:00</small></strong></div>
          <div className={`studio-take-wave${lab.take ? " has-take" : ""}`} aria-hidden="true">{waveform.map((peak, index) => <i key={index} className={lab.take && index / waveform.length < fraction ? "is-played" : ""} style={{ height: `${Math.max(4, Math.min(1, peak) * 100)}%`, "--bar-weight": 0.35 + Math.abs(Math.sin(index * 1.73)) * 0.65 } as CSSProperties}/>)}</div>
          {lab.take && lab.takeUrl ? <><label className="studio-seek"><span className="sr-only">Recording playback position</span><input aria-label="Recording playback position" type="range" min="0" max={Math.max(0.01, lab.take.duration)} step="0.01" value={Math.min(lab.playhead, lab.take.duration)} onChange={event => lab.seekPlayback(Number(event.target.value))}/><span>{clock(lab.playhead)}<span>{clock(lab.take.duration)}</span></span></label><div className="studio-take-actions"><button className="studio-preview-button" type="button" onClick={lab.togglePlayback} aria-label={lab.playback ? "Pause recording" : "Play recording"}><Icon name={lab.playback ? "pause" : "play"} size={16}/>{lab.playback ? "Pause" : "Listen back"}</button><a className="studio-download" href={lab.takeUrl} download={lab.downloadName} aria-label="Download WAV"><Icon name="download" size={16}/><span>Download WAV</span></a></div><button className="studio-new-take" type="button" onClick={newTake}><Icon name="reset" size={14}/> New recording <span>Discards this take</span></button></> : <p className="studio-take-empty">{recording ? "You’re on. Play the keys, tap the pads, or let your beat roll." : captureBusy ? "Just a moment. Your sound is in good hands." : "Press Record above, then play. Your keys, pads and beat become one recording."}</p>}
          <audio ref={lab.audioRef} src={lab.takeUrl || undefined} preload="metadata" {...lab.audioProps}/>
          <p className="studio-take-footnote">Up to 5 minutes per take. Download to keep it.<br/>New recording or leaving this page discards your take.</p>
        </section>

        <section className="studio-panel studio-sequencer" aria-labelledby="studio-beat-title">
          <div className="studio-panel-heading"><div><div><h2 id="studio-beat-title">Build a beat<span>···</span></h2></div></div><span className="studio-chip">16 STEPS / ONE BAR</span></div>
          <div className="studio-presets" role="group" aria-label="Beat presets">{PATTERNS.filter(preset => preset.id !== "empty").map(preset => <button key={preset.id} type="button" aria-pressed={lab.presetId === preset.id} onClick={() => lab.loadPreset(preset.id)}><span>{preset.id === "lofi" ? "☾" : preset.id === "house" ? "◈" : "ϟ"}</span>{preset.name}</button>)}<button className="studio-clear-pattern" type="button" onClick={lab.clearPattern}>Clear</button></div>
          <div className="studio-step-scroll" tabIndex={0} aria-label="Beat sequencer, scroll horizontally for all sixteen steps"><div className="studio-step-grid" ref={grid}><div className="studio-step-scale"><span>DRUM / LEVEL</span>{Array.from({ length: STEPS }, (_, step) => <span key={step} className={lab.transport && lab.step === step ? "current" : ""}>{step % 4 === 0 ? step / 4 + 1 : "·"}</span>)}</div>{DRUMS.map(drum => <div className={`studio-step-row drum-${drum.id}`} key={drum.id}><div className="studio-step-label"><span>{drum.label}</span><input aria-label={`${drum.label} level`} type="range" min="0" max="100" value={Math.round(lab.drumLevels[drum.id] * 100)} onChange={event => lab.setDrumLevel(drum.id, Number(event.target.value) / 100)}/></div>{Array.from({ length: STEPS }, (_, step) => <button key={step} type="button" className={`studio-step${step % 4 === 0 ? " is-beat" : ""}${lab.transport && lab.step === step ? " is-current" : ""}`} data-drum={drum.id} data-step={step} tabIndex={focusedStep === `${drum.id}:${step}` ? 0 : -1} onFocus={() => setFocusedStep(`${drum.id}:${step}`)} aria-label={`${drum.label}, step ${step + 1}`} aria-pressed={lab.pattern[drum.id][step]} onClick={() => lab.toggleStep(drum.id, step)} onKeyDown={event => moveStep(event, drum.id, step)}><i/></button>)}</div>)}</div></div>
          <div className="studio-sequencer-foot"><p>Tap a step to add a hit. Your pattern loops while you play.<span className="studio-scroll-hint">Swipe the grid to reach all 16 steps →</span></p><span><i className={lab.transport ? "on" : ""}/>{lab.transport ? "IN THE GROOVE" : "READY WHEN YOU ARE"}</span></div>
        </section>

        <section className="studio-panel studio-drums" aria-labelledby="studio-drums-title">
          <div className="studio-panel-heading"><div><div><h2 id="studio-drums-title">Tap it out<span>↯</span></h2></div></div><span className="studio-chip">LIVE PADS</span></div>
          <div className="studio-drum-pads">{DRUMS.map(drum => <button className={`studio-drum-pad drum-${drum.id}${lab.activeDrums.includes(drum.id) ? " is-hit" : ""}`} key={drum.id} disabled={liveBlocked} type="button" aria-label={`Play ${drum.label}`} onPointerDown={event => { if (event.pointerType === "mouse" && event.button !== 0) return; event.preventDefault(); lab.hitDrum(drum.id); }} onClick={event => { if (event.detail === 0) lab.hitDrum(drum.id); }} onContextMenu={event => event.preventDefault()}><kbd>{drum.shortcut}</kbd><svg viewBox="0 0 80 30" aria-hidden="true"><path d={drum.id === "kick" ? "M4 15h10l5-12 7 24 7-20 8 16 7-12 7 8 7-5 14 1" : drum.id === "snare" || drum.id === "clap" ? "M4 15h8l4-10 3 20 4-22 5 24 4-21 4 17 4-18 4 20 4-17 3 14 5-10 7 5 13-2" : drum.id === "tom" ? "M4 15h10q5-22 10 0t17 0q4-14 8 0t12 0h15" : "M4 15h9l3-8 3 15 4-21 4 28 3-22 3 18 3-15 3 12 4-13 4 10 4-8 3 8 5-5 4 3 9-2"}/></svg><strong>{drum.label}</strong></button>)}</div><p className="studio-pad-hint">Use keys <kbd>1</kbd> – <kbd>6</kbd>, click, or tap.<br/>Play over your loop for a little extra personality.</p>
        </section>
      </div>
      <footer className="studio-footer"><p>Made in your browser. No microphone. Nothing uploaded.</p></footer>
    </main>

    <dialog ref={help} className="studio-help" aria-labelledby="studio-help-title" data-sound="off" onClick={event => { if (event.target === event.currentTarget) help.current?.close(); }}><button className="studio-help-close" type="button" onClick={() => help.current?.close()} aria-label="Close studio guide">×</button><h2 id="studio-help-title">You’ve got a sound.<br/><em>Let’s find it.</em></h2><ol><li><b>01</b><div><h3>Start with a melody.</h3><p>Pick a sound, then click or hold the piano keys. On a laptop, follow the letter labels. Touch screens can play several notes at once.</p></div></li><li><b>02</b><div><h3>Give it a little rhythm.</h3><p>Load a beat preset or light up your own steps. Press Play beat to loop it. Tempo controls speed; swing adds a little bounce. Tap the live pads with keys 1–6.</p></div></li><li><b>03</b><div><h3>Make a take. Make it yours.</h3><p>Press Record and play. Stop recording to listen back and download a WAV. Each take can run for five minutes. New recording clears the previous take.</p></div></li></ol><div className="studio-help-shortcuts"><span><kbd>A</kbd> onward <b>Play notes</b></span><span><kbd>1</kbd>–<kbd>6</kbd><b>Drum pads</b></span><span><kbd>Enter</kbd> / <kbd>Space</kbd><b>Play focused control</b></span><span><kbd>←</kbd><kbd>↑</kbd><kbd>↓</kbd><kbd>→</kbd><b>Move between steps</b></span></div><p className="studio-help-note">Your studio sound has its own volume and mute controls. Headphones help you hear every detail. Download a take before leaving—there’s no automatic save.</p><button className="studio-help-go" type="button" onClick={() => help.current?.close()}>Let’s make something <Icon name="arrow"/></button></dialog>
  </div>;
}
