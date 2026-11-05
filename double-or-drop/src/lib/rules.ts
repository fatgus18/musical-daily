import {createHash} from "node:crypto";
import type {CatalogTrack, Metric} from "./catalog.ts";
import {comparableMetricValue} from "./metric-values.ts";
import type {Pair,MetricFilter} from "./types.ts";

export const INITIAL_LIVES=3;
export const GUESS_DURATION_MS=20_000;
export const BASE_POINTS=100;
export const MAX_LADDER=6;
// A defensive storage limit, not a round limit: normal runs can continue indefinitely.
export const MAX_BANKED_POINTS=1_000_000_000;
export const MAX_COMPARISONS=1_000_000;
// Keep historical tempo measurements readable, but never deal a new tempo pick:
// preview coverage is incomplete across the full shared recording catalog.
export const METRICS:Metric[]=["streams","duration","year"];
export const METRIC_LABELS:Record<Metric,{label:string;question:string;unit:string}>={
  streams:{label:"Fame",question:"Which song has more streams?",unit:"streams"},
  duration:{label:"Time",question:"Which song runs longer?",unit:"duration"},
  tempo:{label:"Tempo",question:"Which song has a faster tempo?",unit:"BPM"},
  year:{label:"Time machine",question:"Which song was released earlier?",unit:"year"},
};
export function randomFrom(seed:string){let n=createHash("sha256").update(seed).digest().readUInt32LE(0);return ()=>{n+=0x6D2B79F5;let t=n;t=Math.imul(t^(t>>>15),t|1);t^=t+Math.imul(t^(t>>>7),t|61);return((t^(t>>>14))>>>0)/4294967296;};}
export function shuffle<T>(values:readonly T[],random:()=>number){const copy=[...values];for(let i=copy.length-1;i>0;i--){const j=Math.floor(random()*(i+1));[copy[i],copy[j]]=[copy[j],copy[i]];}return copy;}
export function titleIdentity(track:Pick<CatalogTrack,"title"|"artist">){return `${track.artist}|${track.title}`.normalize("NFKD").replace(/[\u0300-\u036f]/g,"").toLowerCase().replace(/\s*[-–(\[]\s*(?:\d{4}\s*)?(?:remaster(?:ed)?|radio edit|album version|single version).*$/i,"").replace(/[^a-z0-9]/g,"");}
export function displayValue(metric:Metric,value:number){
  if(metric==="duration"){const total=Math.round(value);return `${Math.floor(total/60)}:${String(total%60).padStart(2,"0")}`;}
  if(metric==="tempo")return `${Math.round(value)} BPM`;
  if(metric==="year")return String(Math.round(value));
  return `${Math.round(value).toLocaleString("en-US")} streams`;
}
export const comparableValue=comparableMetricValue;
export function validMetric(track:CatalogTrack,metric:Metric){const item=track.metrics[metric];return Boolean(item&&Number.isFinite(item.value)&&item.value>0&&/^https:\/\//.test(item.sourceUrl));}
export function pairKey(pair:Pair){return `${pair.metric}:${[pair.left.id,pair.right.id].sort().join(":")}`;}
export function winner(pair:Pair):"left"|"right"{const left=pair.left.metrics[pair.metric]!.value;const right=pair.right.metrics[pair.metric]!.value;return (pair.metric==="year"?left<right:left>right)?"left":"right";}
export function eligiblePair(left:CatalogTrack,right:CatalogTrack,metric:Metric){
  if(left.id===right.id||titleIdentity(left)===titleIdentity(right)||!validMetric(left,metric)||!validMetric(right,metric))return false;
  if(metric==="streams"&&left.metrics.streams!.asOf!==right.metrics.streams!.asOf)return false;
  return comparableValue(metric,left.metrics[metric]!.value)!==comparableValue(metric,right.metrics[metric]!.value);
}
/** Two representatives per snapshot suffice: one value, then the first different value.
 * If another recording differs in both identity and value it forms a pair with one of them.
 * This is linear in pool size, including huge pools of equal displayed values. */
export function findEligiblePair(tracks:CatalogTrack[],metric:Metric):Pair|undefined{
  const representatives=new Map<string,{first:CatalogTrack;otherValue?:CatalogTrack}>();
  for(const track of tracks){
    if(!validMetric(track,metric))continue;
    const snapshot=metric==="streams"?track.metrics.streams!.asOf||"":"all";
    const group=representatives.get(snapshot);
    if(!group){representatives.set(snapshot,{first:track});continue;}
    if(eligiblePair(group.first,track,metric))return {left:group.first,right:track,metric};
    if(group.otherValue&&eligiblePair(group.otherValue,track,metric))return {left:group.otherValue,right:track,metric};
    if(!group.otherValue&&comparableValue(metric,group.first.metrics[metric]!.value)!==comparableValue(metric,track.metrics[metric]!.value))group.otherValue=track;
  }
}
export function availableMetrics(tracks:CatalogTrack[],filter:MetricFilter="mixed"){
  return (filter==="mixed"?METRICS:[filter]).filter(metric=>METRICS.includes(metric)&&Boolean(findEligiblePair(tracks,metric)));
}
function normalizedGap(pair:Pair){const a=pair.left.metrics[pair.metric]!.value,b=pair.right.metrics[pair.metric]!.value;
  return pair.metric==="year"?Math.min(1,Math.abs(a-b)/40):Math.abs(a-b)/Math.max(a,b);
}
export interface DrawOptions {seed:string;filter:MetricFilter;round:number;ladder:number;recentTracks:string[];recentPairs:string[];previousMetric?:Metric}
/** Pair selection is reproducible, finite and independent of a provider network call. */
export function drawPair(tracks:CatalogTrack[],options:DrawOptions):Pair{
  const random=randomFrom(options.seed);let metrics=availableMetrics(tracks,options.filter);
  if(!metrics.length)throw new Error("This collection does not have enough comparable songs yet. Choose another collection.");
  if(metrics.length>1&&options.previousMetric)metrics=metrics.filter(metric=>metric!==options.previousMetric);
  metrics=shuffle(metrics,random);
  const recentTrack=new Set(options.recentTracks),recentPair=new Set(options.recentPairs);
  // Easy first comparisons. Risking higher stakes progressively narrows the gap.
  const difficulty=Math.min(1,options.ladder/6+Math.min(options.round,40)/160);
  const targetGap=.55-difficulty*.43;
  let best:{pair:Pair;cost:number}|undefined;
  for(const metric of metrics){
    let pool=tracks.filter(track=>validMetric(track,metric));
    // Early broad-theme rounds favor recognizable recordings without removing deep catalog tracks.
    if(options.round<4&&pool.length>60){
      const recognizable=pool.filter(track=>(track.popularity??0)>=65||(track.metrics.streams?.value??0)>=250_000_000);
      if(recognizable.length>=30)pool=recognizable;
    }
    const valid=shuffle(pool,random);
    // Bound work for very large catalogs, while including fresh tracks ahead of recent ones.
    const sample=[...valid.filter(track=>!recentTrack.has(track.id)),...valid.filter(track=>recentTrack.has(track.id))].slice(0,72);
    for(let i=0;i<sample.length;i++)for(let j=i+1;j<sample.length;j++){
      const left=sample[i],right=sample[j];if(!eligiblePair(left,right,metric))continue;
      const pair:Pair={left,right,metric};
      const repeatPenalty=(recentPair.has(pairKey(pair))?100:0)+(recentTrack.has(left.id)?4:0)+(recentTrack.has(right.id)?4:0);
      const cost=repeatPenalty+Math.abs(normalizedGap(pair)-targetGap)+random()*.12;
      if(!best||cost<best.cost)best={pair,cost};
    }
    // The first randomly chosen metric wins if fresh pairs exist, preserving varied rounds.
    if(best&&best.cost<1)break;
  }
  if(!best){
    // A bounded random sample can contain only displayed ties or incompatible observation dates.
    // Scan the full pool once before declaring it unavailable; never attempt an N-squared search.
    for(const metric of metrics){
      const candidates=shuffle(tracks.filter(track=>validMetric(track,metric)),random);
      const pair=findEligiblePair(candidates.filter(track=>!recentTrack.has(track.id)),metric)??findEligiblePair(candidates,metric);
      if(pair){best={pair,cost:0};break;}
    }
  }
  if(!best)throw new Error("No fair comparison is available for this collection. Choose another collection.");
  const pair=best.pair;return random()<.5?pair:{left:pair.right,right:pair.left,metric:pair.metric};
}
