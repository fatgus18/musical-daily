import StreamBlackjackPage from "@/features/blackjack/blackjack-game";
import { hubHref } from "@/lib/app-path";

export default function Page() {
  return <StreamBlackjackPage hubUrl={hubHref()} />;
}
