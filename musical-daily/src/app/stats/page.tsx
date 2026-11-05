import type { Metadata } from "next";
import Stats from "@/components/stats";
import "../music-stats.css";

export const metadata: Metadata = { title: "Your stats — Musical Daily", description: "Your little collection of good guesses, favorite songs and personal bests across Musical Daily." };
export default function StatsPage() {
  return <Stats blackjackUrl={process.env.NEXT_PUBLIC_BLACKJACK_URL || "http://localhost:3000"} tempoUrl={process.env.NEXT_PUBLIC_TEMPO_TRAP_URL || "http://localhost:3002"} encoreUrl={process.env.NEXT_PUBLIC_ENCORE_URL || "http://localhost:3004"} doubleDropUrl={process.env.NEXT_PUBLIC_DOUBLE_DROP_URL || "http://localhost:3005"}/>;
}
