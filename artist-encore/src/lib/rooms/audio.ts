import {isPreviewUrl} from "../catalog.ts";
import {RoomError} from "./types.ts";

export const MAX_PREVIEW_BYTES=3*1024*1024;
interface Preview {bytes:Uint8Array<ArrayBuffer>;type:string}
export function allowedPreview(value:string){
  try{const url=new URL(value);return isPreviewUrl(value)&&!url.port&&!url.username&&!url.password;}catch{return false;}
}
/** Remove descriptive tags without shifting MP4 sample offsets. Never decode
 * or alter the recorded music; only the existing provider preview is proxied. */
export function cleanPreview(input:Uint8Array):Preview {
  let data=Buffer.from(input);
  if(data.length>=12&&data.toString("ascii",4,8)==="ftyp"){
    data=Buffer.from(data);
    const containers=new Set(["moov","trak","mdia","minf","stbl","edts","dinf","mvex","moof","traf"]);
    const visit=(start:number,end:number,depth:number)=>{
      if(depth>12)return;
      for(let offset=start;offset+8<=end;){
        let size=data.readUInt32BE(offset);const type=data.toString("latin1",offset+4,offset+8);let header=8;
        if(size===1){if(offset+16>end)return;const large=data.readBigUInt64BE(offset+8);if(large>BigInt(end-offset))return;size=Number(large);header=16;}
        else if(size===0)size=end-offset;
        if(size<header||offset+size>end)return;
        if(["udta","meta","ID32"].includes(type)){data.write("free",offset+4,4,"ascii");data.fill(0,offset+header,offset+size);}
        else if(containers.has(type))visit(offset+header,offset+size,depth+1);
        offset+=size;
      }
    };visit(0,data.length,0);
    return {bytes:new Uint8Array(data),type:"audio/mp4"};
  }
  if(data.length>=12&&data.toString("ascii",0,4)==="RIFF"&&data.toString("ascii",8,12)==="WAVE"){
    data=Buffer.from(data);for(let offset=12;offset+8<=data.length;){const size=data.readUInt32LE(offset+4);if(offset+8+size>data.length)break;if(data.toString("ascii",offset,offset+4)==="LIST"){data.write("JUNK",offset,4,"ascii");data.fill(0,offset+8,offset+8+size);}offset+=8+size+(size%2);}
    return {bytes:new Uint8Array(data),type:"audio/wav"};
  }
  while(data.length>=10&&data.toString("ascii",0,3)==="ID3"){
    if([...data.subarray(6,10)].some(value=>value>127))throw new RoomError("This preview cannot be decoded.",502,"preview_unavailable");
    const size=(data[6]<<21)|(data[7]<<14)|(data[8]<<7)|data[9];const total=10+size+((data[3]===4&&(data[5]&16))?10:0);
    if(total>data.length)throw new RoomError("This preview cannot be decoded.",502,"preview_unavailable");data=data.subarray(total);
  }
  if(data.length>=128&&data.toString("ascii",data.length-128,data.length-125)==="TAG")data=data.subarray(0,data.length-128);
  if(data.length>2&&data[0]===255&&(data[1]&224)===224)return {bytes:new Uint8Array(data),type:"audio/mpeg"};
  throw new RoomError("This provider preview isn't a supported audio file.",502,"preview_unavailable");
}
export async function downloadPreview(value:string,fetcher:typeof fetch=fetch):Promise<Preview>{
  let target=value;
  const signal=AbortSignal.timeout(20000);
  for(let redirects=0;redirects<=3;redirects++){
    if(!allowedPreview(target))throw new RoomError("This preview provider is not supported.",502,"preview_unavailable");
    const response=await fetcher(target,{redirect:"manual",cache:"no-store",signal,headers:{Accept:"audio/*,video/mp4,application/octet-stream"}});
    if([301,302,303,307,308].includes(response.status)){
      const location=response.headers.get("location");await response.body?.cancel();
      if(!location||redirects===3)break;target=new URL(location,target).href;continue;
    }
    if(!response.ok||!response.body){await response.body?.cancel();break;}
    if(Number(response.headers.get("content-length")||0)>MAX_PREVIEW_BYTES){await response.body.cancel();break;}
    const reader=response.body.getReader();const chunks:Uint8Array[]=[];let size=0;
    try{while(true){const {value,done}=await reader.read();if(done)break;size+=value.byteLength;if(size>MAX_PREVIEW_BYTES){await reader.cancel();throw new RoomError("The preview is too large to play safely.",502,"preview_unavailable");}chunks.push(value);}}finally{reader.releaseLock();}
    return cleanPreview(Buffer.concat(chunks));
  }
  throw new RoomError("This preview couldn't load. Retry it before starting the round.",502,"preview_unavailable");
}
// Optional bounded warm-instance optimization only. Membership and round access
// are checked in durable storage before every call; cache loss affects no game.
const previews=new Map<string,Preview&{expires:number}>();
const pending=new Map<string,Promise<Preview>>();
export async function cachedPreview(url:string):Promise<Preview>{
  const saved=previews.get(url);if(saved&&saved.expires>Date.now())return saved;
  const inFlight=pending.get(url);if(inFlight)return inFlight;
  if(pending.size>=12)throw new RoomError("Previews are busy. Retry audio in a moment.",503,"preview_busy");
  const work=downloadPreview(url).then(value=>{
    for(const [key,entry] of previews)if(entry.expires<=Date.now())previews.delete(key);
    while(previews.size>=8)previews.delete(previews.keys().next().value!);
    previews.set(url,{...value,expires:Date.now()+120000});return value;
  });pending.set(url,work);try{return await work;}finally{pending.delete(url);}
}
