export const GAME_IDS = ["blackjack", "tempo", "encore", "double-drop"];

// Stable IDs are persisted; the original Google picture stays available as Default.
export const ACCOUNT_AVATARS = Object.freeze([
  { id: "headphones", emoji: "🎧", label: "Headphones" },
  { id: "microphone", emoji: "🎤", label: "Microphone" },
  { id: "guitar", emoji: "🎸", label: "Guitar" },
  { id: "piano", emoji: "🎹", label: "Piano" },
  { id: "drums", emoji: "🥁", label: "Drums" },
  { id: "trumpet", emoji: "🎺", label: "Trumpet" },
  { id: "saxophone", emoji: "🎷", label: "Saxophone" },
  { id: "violin", emoji: "🎻", label: "Violin" },
  { id: "music-note", emoji: "🎵", label: "Music note" },
  { id: "score", emoji: "🎼", label: "Music score" },
].map(Object.freeze));
export function isAccountAvatar(value) {
  return typeof value === "string" && ACCOUNT_AVATARS.some(avatar => avatar.id === value);
}
