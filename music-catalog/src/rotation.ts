import { createHash } from "node:crypto";

export function buildRotation<T extends {id:string;artist:string}>(tracks:T[],version:string):string[][]{
  const deck=[...tracks].sort((a,b)=>{
    const key=(id:string)=>createHash("sha256").update(`${version}:${id}`).digest("hex");
    return key(a.id).localeCompare(key(b.id));
  });
  const rounds:string[][]=[];
  while(deck.length>=5){
    const artists=new Set<string>();const round:string[]=[];
    for(let i=0;i<deck.length&&round.length<5;){
      const track=deck[i];
      if(artists.has(track.artist)){i++;continue;}
      artists.add(track.artist);round.push(track.id);deck.splice(i,1);
    }
    if(round.length<5)break;
    rounds.push(round);
  }
  return rounds;
}
