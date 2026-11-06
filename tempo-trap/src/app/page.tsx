import TempoGame from "@/components/tempo-game";
import { hubHref } from "@/lib/app-path";
export default function Page() { return <TempoGame hubUrl={hubHref()} />; }
