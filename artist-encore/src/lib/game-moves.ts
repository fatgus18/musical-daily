import type {Database} from "@musical-daily/database";
import {act} from "./engine.ts";
import {findGame,saveGame,transaction} from "./store.ts";

const ACTIONS=new Set(["listen","heard","answer","pass","next","unavailable","sync","replace-clip","discard","fifty-fifty"]);
export interface GameMove {gameId:string;round:number;action:string;choiceId?:string}

export function validateGameMove(body:Record<string,unknown>):GameMove{
  if(typeof body.gameId!=="string"||body.gameId.length>80||!Number.isInteger(body.round)||Number(body.round)<0||Number(body.round)>9||typeof body.action!=="string"||!ACTIONS.has(body.action)||body.answer!==undefined&&typeof body.answer!=="string")throw new Error("Invalid game action.");
  if(body.action==="answer"&&(typeof body.choiceId!=="string"||body.choiceId.length>80))throw new Error("Choose one of the available answer options.");
  return {gameId:body.gameId,round:Number(body.round),action:body.action,...(typeof body.choiceId==="string"?{choiceId:body.choiceId}:{})};
}

/** API mutations always reload the owner's latest state under a write lock. */
export async function applySavedMove(db:Database,player:string,body:Record<string,unknown>,now?:number){
  const move=validateGameMove(body);
  if(move.action==="replace-clip")throw new Error("Clip replacements require the current provider catalog.");
  return transaction(db,async tx=>{
    const game=await findGame(tx,player,move.gameId);
    if(!game)throw new Error("This mix belongs to another browser or has expired.");
    // Read the clock after waiting for the lock and the latest saved state.
    // Queued requests must not shorten a new guess window or accept a late answer.
    const state=act(game,move.action,move.round,move.choiceId,now??Date.now());
    await saveGame(tx,game);
    return state;
  });
}
