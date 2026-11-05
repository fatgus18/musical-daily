import TempoGame from "@/components/tempo-game";
export default function Page() { return <TempoGame hubUrl={process.env.NEXT_PUBLIC_HUB_URL || "http://localhost:3001"} />; }
