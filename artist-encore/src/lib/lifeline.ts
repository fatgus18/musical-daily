import {randomInt} from "node:crypto";
import type {Game} from "./types.ts";

export function isAssisted(game:Game){return game.fiftyFifty?.round===game.round;}

export function visibleChoices(game:Game){
  const removed=isAssisted(game)?new Set(game.fiftyFifty!.removedChoiceIds):new Set<string>();
  return game.picks[game.round].choices?.filter(choice=>!removed.has(choice.id));
}

/** Called inside the same immediate transaction as every other game move. */
export function useFiftyFifty(game:Game){
  if(game.phase!=="guessing"||game.fiftyFifty)return;
  const pick=game.picks[game.round];
  const wrong=pick.choices?.filter(choice=>choice.id!==pick.correctChoiceId);
  if(pick.choices?.length!==4||wrong?.length!==3)throw new Error("Reconnect to your current song before using 50/50.");
  // Uniformly keep one wrong answer. Neither order nor public seeds reveal which survives.
  const keep=randomInt(wrong.length);
  game.fiftyFifty={round:game.round,removedChoiceIds:wrong.filter((_,index)=>index!==keep).map(choice=>choice.id)};
}
