import Home from "@/components/home";
export default function Page() {
  return <Home blackjackUrl={process.env.NEXT_PUBLIC_BLACKJACK_URL || "http://localhost:3000"} tempoUrl={process.env.NEXT_PUBLIC_TEMPO_TRAP_URL || "http://localhost:3002"} encoreUrl={process.env.NEXT_PUBLIC_ENCORE_URL || "http://localhost:3004"} doubleDropUrl={process.env.NEXT_PUBLIC_DOUBLE_DROP_URL || "http://localhost:3005"} />;
}
