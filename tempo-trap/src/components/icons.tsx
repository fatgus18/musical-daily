import type { CSSProperties } from "react";
export function Icon({ name, size = 20 }: { name: "arrow" | "play" | "headphones" | "clock" | "back" | "volume" | "share" | "check" | "close" | "chart" | "external"; size?: number }) {
  const paths = {
    arrow: <path d="M4 12h15m-6-6 6 6-6 6" />,
    play: <path d="m8 4 12 8-12 8Z" fill="currentColor" stroke="none" />,
    headphones: <><path d="M4 15v-4a8 8 0 0 1 16 0v4" /><rect x="3" y="12" width="4" height="8" rx="2" /><rect x="17" y="12" width="4" height="8" rx="2" /></>,
    clock: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>,
    back: <path d="M20 12H4m6-6-6 6 6 6" />,
    volume: <><path d="m11 4-6 5H2v6h3l6 5ZM16 8a6 6 0 0 1 0 8M19 5a10 10 0 0 1 0 14" /></>,
    share: <><path d="M12 15V3m-4 4 4-4 4 4M5 12v8h14v-8" /></>,
    check: <path d="m5 12 4 4L19 6" />,
    close: <path d="m6 6 12 12M6 18 18 6" />,
    chart: <><path d="M4 20h16M7 16v-5M12 16V4M17 16V8" /></>,
    external: <><path d="M14 3h7v7M21 3 10 14M10 4H4v16h16v-6" /></>,
  };
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}
export function SoundBars({ active = false, count = 47 }: { active?: boolean; count?: number }) {
  return <div className={`sound-bars ${active ? "active" : ""}`} aria-hidden="true">{Array.from({ length: count }, (_, i) => <i key={i} style={{ height: `${Math.round(20 + Math.abs(Math.sin(i * 1.8) * Math.cos(i * .3)) * 80)}%`, "--delay": `${((i % 9) * -.13).toFixed(2)}s` } as CSSProperties} />)}</div>;
}
