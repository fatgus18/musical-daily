import type { Metadata } from "next";
import MusicStats from "@/components/music-stats";
import "../music-stats.css";

export const metadata: Metadata = {
  title: "Your stats — Blackjack Music — Musical Daily",
  description: "Your Blackjack Music personal bests, recent plays and little victories, saved with your Musical Daily account.",
};
export default function StatsPage() {
  return <MusicStats game="blackjack" hubUrl={process.env.NEXT_PUBLIC_HUB_URL || "http://localhost:3001"} />;
}
