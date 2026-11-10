import type { Metadata } from "next";
import RhythmStudio from "@/components/studio/rhythm-studio";
import "./studio.css";
import "./arcade-studio.css";

export const metadata: Metadata = {
  title: "Rhythm Lab — Make something yours. | Musical Daily",
  description: "Your pocket music studio. Play piano, build drum beats, record your performance and download it as a WAV. Keyboard, mouse and touch welcome.",
};

export default function RhythmLabPage() {
  return <RhythmStudio />;
}
