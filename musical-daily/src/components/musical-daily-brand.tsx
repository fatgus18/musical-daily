// Shared brand source. Run `node scripts/sync-brand.mjs` from the workspace root.
import Image from "next/image";

export function MusicalDailyBrand({ href, showBack = false }: { href: string; showBack?: boolean }) {
  return <div className="musical-daily-navigation">
    <a className="musical-daily-home" href={href} aria-label="Musical Daily home">
      <Image className="musical-daily-logo" src="/brand/musical-daily.svg" width={224} height={40} alt="Musical Daily" unoptimized loading="eager" />
    </a>
    {showBack && <a className="musical-daily-back" href={href}><span aria-hidden="true">←</span> All games</a>}
  </div>;
}
