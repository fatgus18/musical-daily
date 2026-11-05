export type Mode = "daily" | "practice";
export type Phase = "ready" | "loading" | "listening" | "guessing" | "submitting" | "reveal" | "complete";
export interface PublicTrack { id: string; title: string; artist: string; album: string; year: number; artworkUrl: string; previewUrl: string; spotifyUrl: string; appleMusicUrl: string; clipStartSeconds: number; clipSeconds: number }
export interface RoundResult { round: number; trackId: string; guess: number | null; bpm: number; matchedBpm: number; difference: number | null; score: number; label: string }
export interface Puzzle { date: string; number: number; mode: Mode; seed: string; version: string; tracks: PublicTrack[]; token: string; accountProgress?: Progress; accountRevision?: number }
export interface Progress { round: number; phase: Phase; guess: string; deadline: number | null; results: RoundResult[]; token: string }
export interface SavedGame { puzzle: Puzzle; progress: Progress }
export interface Stats { played: number; totalScore: number; best: number; streak: number; longestStreak: number; lastDate: string | null; history: { date: string; score: number }[] }
