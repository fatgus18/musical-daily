import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";
import "./musical-daily-brand.css";
import "./account-client.css";
import { AccountProvider } from "@/components/account-client";
import "./sound-client.css";
import "./visual-upgrade.css";
import "./hand-remix.css";
import "./pixel-system.css";
import "./pixel-polish.css";
import "./display.css";
import { contrastBootstrap } from "@/components/display-preferences";
import { SoundProvider } from "@/components/sound-client";

export const metadata: Metadata = {
  title: "Stream Blackjack — Musical Daily",
  description: "Pick tracks, beat the daily stream target, and protect your streak.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head><script dangerouslySetInnerHTML={{ __html: contrastBootstrap }} /></head>
      <body><SoundProvider><AccountProvider>{children}</AccountProvider></SoundProvider></body>
    </html>
  );
}
