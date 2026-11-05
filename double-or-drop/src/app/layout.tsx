import type { Metadata } from "next";
import "./globals.css";
import "./musical-daily-brand.css";
import "./account-client.css";
import { AccountProvider } from "@/components/account-client";
import "./sound-client.css";
import "./collection-controls.css";
import "./visual-upgrade.css";
import "./run-goals.css";
import "./display.css";
import { contrastBootstrap } from "@/components/display-preferences";
import { SoundProvider } from "@/components/sound-client";

export const metadata: Metadata = {
  title: "Double or Drop — Musical Daily",
  description: "Two songs. One choice. Compare real music, double your points or bank your winnings. An endless game of music intuition.",
};
export default function Layout({ children }: { children: React.ReactNode }) {
  return <html lang="en" suppressHydrationWarning><head><script dangerouslySetInnerHTML={{ __html: contrastBootstrap }} /></head><body><SoundProvider music><AccountProvider>{children}</AccountProvider></SoundProvider></body></html>;
}
