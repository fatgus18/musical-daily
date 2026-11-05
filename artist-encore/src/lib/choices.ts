import {randomUUID,randomInt} from "node:crypto";
import type {Track} from "./catalog.ts";
import type {Game,Pick} from "./types.ts";
import {answerMatches,normalize,shuffled,trackIdentity} from "./rules.ts";

function equivalent(a:Track,b:Track){return trackIdentity(a)===trackIdentity(b)||[a.title,...a.aliases].some(label=>answerMatches(b,label))||[b.title,...b.aliases].some(label=>answerMatches(a,label));}
export function withChoices(pick:Pick,pool:Track[],seed:string,avoid=new Set<string>()):Pick{
  const correct=pick.track;const candidates=shuffled(pool.filter(track=>track.artistId===correct.artistId&&normalize(track.artist)===normalize(correct.artist)),`${seed}:distractors`);
  const preferred=[...candidates.filter(t=>!avoid.has(trackIdentity(t))),...candidates.filter(t=>avoid.has(trackIdentity(t)))];
  const selected=[correct];
  for(const candidate of preferred){if(selected.some(track=>equivalent(track,candidate)))continue;selected.push(candidate);if(selected.length===4)break;}
  if(selected.length!==4)throw new Error("This artist needs four distinct song titles for answer choices.");
  const correctChoiceId=randomUUID();const choices=selected.map((track,index)=>({id:index===0?correctChoiceId:randomUUID(),label:track.title}));
  // Positions must not be derivable from the public game ID and round number.
  for(let i=choices.length-1;i>0;i--){const j=randomInt(i+1);[choices[i],choices[j]]=[choices[j],choices[i]];}
  return {...pick,choices,correctChoiceId};
}
/** Upgrade saved mixes using their existing recordings; scores, deadlines and tracks stay fixed. */
export function ensureChoices(game:Game){
  const tracks=game.picks.map(p=>p.track);let changed=false;
  game.picks=game.picks.map((pick,round)=>{if(pick.choices?.length===4&&pick.choices.some(c=>c.id===pick.correctChoiceId))return pick;changed=true;return withChoices(pick,tracks,`${game.id}:${round}`);});return changed;
}
