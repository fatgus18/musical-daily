import StreamBlackjackPage from "@/features/blackjack/blackjack-game";

export default function Page() {
  return <StreamBlackjackPage hubUrl={process.env.NEXT_PUBLIC_HUB_URL || "http://localhost:3001"} />;
}
