import type { Metadata } from "next";
import "./globals.css";
import "./musical-daily-brand.css";
import "./account-client.css";
import "./stats.css";
import { AccountProvider } from "@/components/account-client";
import "./sound-client.css";
import "./home-layout.css";
import "./visual-upgrade.css";
import "./game-discovery.css";
import "./music-fact.css";
import "./studio-promo.css";
import "./pixel-system.css";
import "./pixel-polish.css";
import "./arcade-system.css";
import "./arcade-polish.css";
import "./display.css";
import { contrastBootstrap } from "@/components/display-preferences";
import { SoundProvider } from "@/components/sound-client";
export const metadata: Metadata = {
  title: "Musical Daily — Good music. Great instincts.",
  description: "Your music playground. Make your own beats and melodies in Rhythm Lab, or play Blackjack Music, Tempo Trap, Encore and Double or Drop.",
};
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return <html lang="en" suppressHydrationWarning><head><script dangerouslySetInnerHTML={{ __html: contrastBootstrap }}/></head><body><SoundProvider music musicProfile="lobby"><AccountProvider>{children}</AccountProvider></SoundProvider></body></html>;
}
