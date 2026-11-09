import type {Metadata} from "next";
import "./globals.css";
import "./musical-daily-brand.css";
import "./account-client.css";
import {AccountProvider} from "@/components/account-client";
import "./sound-client.css";
import "./visual-upgrade.css";
import "./fan-features.css";
import "./pixel-system.css";
import "./pixel-polish.css";
import "./display.css";
import { contrastBootstrap } from "@/components/display-preferences";
import { SoundProvider } from "@/components/sound-client";
export const metadata:Metadata={title:"Encore — Musical Daily",description:"Your artist. Ten songs. How well do you really know their music? Six hits, three fan favorites, one deep cut and four choices each round. Play anytime."};
export default function Layout({children}:{children:React.ReactNode}){return <html lang="en" suppressHydrationWarning><head><script dangerouslySetInnerHTML={{__html:contrastBootstrap}}/></head><body><SoundProvider><AccountProvider>{children}</AccountProvider></SoundProvider></body></html>;}
