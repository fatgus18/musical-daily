export interface MusicFact {
  id: string;
  kind: "song" | "album" | "artist";
  headline: string;
  text: string;
  subject: string;
  musicLabel: string;
  musicUrl: string;
  sourceTitle: string;
  sourceUrl: string;
}

// Historical facts, individually checked against the linked sources on 2026-11-04.
// Keep copy original and concise. Discovery destinations are real releases or
// official artist pages; the physical Lazaretto edition links to its label.
export const MUSIC_FACTS: readonly MusicFact[] = [
  {
    id: "bad-guy-crosswalk", kind: "song", headline: "This beat has right of way.",
    text: "FINNEAS sampled an Australian pedestrian crossing for Billie Eilish’s “bad guy.” Its walk signal became part of the chorus’s twitchy percussion.",
    subject: "bad guy · Billie Eilish", musicLabel: "Hear bad guy", musicUrl: "https://music.apple.com/us/album/bad-guy/1450695723?i=1450695739",
    sourceTitle: "FINNEAS interview · Hit Songs Deconstructed", sourceUrl: "https://editorial.hitsongsdeconstructed.com/articles/spotlight-series-finneas-oconnell-on-bad-guy/",
  },
  {
    id: "yesterday-scrambled-eggs", kind: "song", headline: "Heartbreak. With a side of eggs.",
    text: "Paul McCartney woke up with “Yesterday” in his head. Before the real lyrics arrived, he sang about scrambled eggs to hold onto the melody.",
    subject: "Yesterday · The Beatles", musicLabel: "Explore Yesterday", musicUrl: "https://www.thebeatles.com/yesterday",
    sourceTitle: "Paul McCartney · The Scrambled Eggs story", sourceUrl: "https://www.paulmccartney.com/news/paul-duets-on-jimmy-fallon-album",
  },
  {
    id: "prince-entire-band", kind: "album", headline: "The whole band was Prince.",
    text: "For his debut “For You,” 19-year-old Prince recorded every vocal and instrument himself. Lead singer, backing singers, band: all Prince.",
    subject: "For You · Prince", musicLabel: "Explore For You", musicUrl: "https://discography.prince.com/albums/for-you",
    sourceTitle: "Prince Estate · Official album credits", sourceUrl: "https://discography.prince.com/albums/for-you",
  },
  {
    id: "metallica-antarctica", kind: "artist", headline: "Metallica. On ice. In headphones.",
    text: "In 2013, Metallica played Antarctica through audience headphones, with amps in isolation cabinets. Heavy metal, inside a dome, on the ice.",
    subject: "Freeze ’Em All · Metallica", musicLabel: "Watch the Antarctic gig", musicUrl: "https://www.youtube.com/watch?v=2Hi2u98VKxc",
    sourceTitle: "Guinness World Records · Metallica in Antarctica", sourceUrl: "https://www.guinnessworldrecords.com/world-records/113181-first-musical-act-to-perform-a-concert-on-every-continent",
  },
  {
    id: "pink-floyd-empty-pompeii", kind: "album", headline: "Great gig. No audience.",
    text: "Pink Floyd filmed their 1971 Pompeii performance in an ancient Roman amphitheatre without an audience. The empty ruins became part of the show.",
    subject: "Live at Pompeii · Pink Floyd", musicLabel: "Hear Live at Pompeii", musicUrl: "https://pinkfloyd.lnk.to/Pompeii_Listen2025WE",
    sourceTitle: "Pink Floyd · Official Pompeii release", sourceUrl: "https://www.pinkfloyd.com/pompeii-mcmlxxii-the-live-album-film-out-now/",
  },
  {
    id: "lazaretto-vinyl", kind: "album", headline: "This record has cheat codes.",
    text: "Jack White’s “Lazaretto” Ultra LP plays one side inside-out, hides tracks beneath its labels, and has a hologram etched into the vinyl.",
    subject: "Lazaretto · Jack White", musicLabel: "Explore the Ultra LP", musicUrl: "https://thirdmanrecords.com/products/lazaretto",
    sourceTitle: "Third Man Records · Ultra LP specifications", sourceUrl: "https://thirdmanrecords.com/products/lazaretto",
  },
  {
    id: "chuck-berry-voyager", kind: "artist", headline: "Rock ’n’ roll went interstellar.",
    text: "Chuck Berry’s “Johnny B. Goode” is aboard both Voyager spacecraft. NASA included it on the Golden Records carrying sounds of Earth.",
    subject: "Johnny B. Goode · Chuck Berry", musicLabel: "Listen to Chuck Berry", musicUrl: "https://www.chuckberry.com/listen",
    sourceTitle: "NASA · Chuck Berry and Carl Sagan", sourceUrl: "https://science.nasa.gov/resource/chuck-berry-and-carl-sagan/",
  },
  {
    id: "level-of-concern-marathon", kind: "song", headline: "Longer than your summer break.",
    text: "Twenty One Pilots’ fan-powered “Level of Concern” video streamed for over 177 days in 2020, using footage submitted by fans.",
    subject: "Level of Concern · twenty one pilots", musicLabel: "Hear Level of Concern", musicUrl: "https://music.apple.com/us/album/level-of-concern-single/1507187367",
    sourceTitle: "Guinness World Records · 177-day music video", sourceUrl: "https://www.guinnessworldrecords.com/world-records/71833-longest-music-video",
  },
  {
    id: "gorillaz-ipad", kind: "album", headline: "A studio that fit in a backpack.",
    text: "Gorillaz recorded “The Fall” on an iPad while on tour. That portable studio became a full album of loops, synths and road-trip restlessness.",
    subject: "The Fall · Gorillaz", musicLabel: "Hear The Fall", musicUrl: "https://music.apple.com/us/album/the-fall/850585388",
    sourceTitle: "Apple Music · The Fall album notes", sourceUrl: "https://music.apple.com/us/album/the-fall/850585388",
  },
  {
    id: "finneas-text-messages", kind: "song", headline: "The receipts became the lyrics.",
    text: "FINNEAS says the verses of “Break My Heart Again” came from texts with an ex. He even added texting sounds to make the connection audible.",
    subject: "Break My Heart Again · FINNEAS", musicLabel: "Hear Break My Heart Again", musicUrl: "https://music.apple.com/us/song/1720958799",
    sourceTitle: "FINNEAS interview · Hit Songs Deconstructed", sourceUrl: "https://editorial.hitsongsdeconstructed.com/articles/spotlight-series-finneas-oconnell-on-bad-guy/",
  },
  {
    id: "beatles-deep-space", kind: "song", headline: "An extremely long-distance dedication.",
    text: "In 2008, NASA beamed the Beatles’ “Across the Universe” toward Polaris. Paul McCartney asked NASA to send his love to the aliens.",
    subject: "Across the Universe · The Beatles", musicLabel: "Explore Across the Universe", musicUrl: "https://www.thebeatles.com/across-universe",
    sourceTitle: "NASA JPL · Across the Universe transmission", sourceUrl: "https://www.jpl.nasa.gov/news/nasa-and-the-beatles-celebrate-anniversaries-by-beaming-song-across-the-universe-into-deep-space/",
  },
  {
    id: "jolene-two-inspirations", kind: "song", headline: "Jolene was two people at once.",
    text: "Dolly Parton borrowed “Jolene” from a young fan’s name. The jealous storyline came from a bank teller who paid her husband plenty of attention.",
    subject: "Jolene · Dolly Parton", musicLabel: "Hear Jolene", musicUrl: "https://music.apple.com/us/album/jolene/1062400323",
    sourceTitle: "Dolly Parton interview · NPR / Ideastream", sourceUrl: "https://www.ideastream.org/news/2008-10-09/dolly-partons-jolene-still-haunts-singers",
  },
];

export const FACT_HISTORY_KEY = "musical-daily:fact-history:v1";
const knownIds = new Set(MUSIC_FACTS.map(fact => fact.id));

export function readFactHistory(raw: string | null): string[] {
  if (!raw || raw.length > 4096) return [];
  try {
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value)) return [];
    return [...new Set(value.slice(-64).filter((id): id is string => typeof id === "string" && knownIds.has(id)))];
  } catch { return []; }
}

/** A shuffled rotation with no immediate repeat across its boundary. */
export function drawMusicFact(history: readonly string[], random = Math.random) {
  let seen = [...new Set(history.filter(id => knownIds.has(id)))];
  let pool = MUSIC_FACTS.filter(fact => !seen.includes(fact.id));
  if (!pool.length) { pool = MUSIC_FACTS.filter(fact => fact.id !== seen.at(-1)); seen = []; }
  const index = Math.min(pool.length - 1, Math.max(0, Math.floor(random() * pool.length) || 0));
  const fact = pool[index];
  return { fact, history: [...seen, fact.id] };
}
