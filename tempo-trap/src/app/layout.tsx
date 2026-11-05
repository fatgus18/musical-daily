import type { Metadata } from "next";
import "./globals.css";
import "./musical-daily-brand.css";
import "./account-client.css";
import { AccountProvider } from "@/components/account-client";
import "./sound-client.css";
import "./visual-upgrade.css";
import "./display.css";
import { contrastBootstrap } from "@/components/display-preferences";
import { SoundProvider } from "@/components/sound-client";
export const metadata: Metadata = { title: "Tempo Trap — Musical Daily", description: "Trust your ears. Listen to 15 seconds of real hits, then guess the BPM. Five rounds, a fresh daily mix, and unlimited practice." };
export default function RootLayout({ children }: { children: React.ReactNode }) { return <html lang="en" suppressHydrationWarning><head><script dangerouslySetInnerHTML={{ __html: contrastBootstrap }} /></head><body><SoundProvider><AccountProvider>{children}</AccountProvider></SoundProvider></body></html>; }
