import {createHash,randomBytes} from "node:crypto";
import {NextRequest,NextResponse} from "next/server";
import {getAccount} from "@musical-daily/accounts/server";
import {claimGuestIdentity} from "./guest-claim.ts";
import {store} from "./store.ts";

const COOKIE="double_drop_player";
export function anonymousIdentity(req:NextRequest){let token=req.cookies.get(COOKIE)?.value;if(!token||!/^[a-f0-9]{64}$/.test(token))token=randomBytes(32).toString("hex");return {token,player:createHash("sha256").update(token).digest("hex")};}
export async function identity(req:NextRequest,token=anonymousIdentity(req).token){
  let user;try{user=await getAccount(req,"double-drop");}catch{throw Object.assign(new Error("Your account connection is unavailable. Please retry to keep your progress safe."),{status:503});}
  const guestToken=req.cookies.get(COOKIE)?.value;
  if(user&&process.env.NEXT_PUBLIC_MUSICAL_DAILY_SERVICES==="1"&&guestToken){
    token=await claimGuestIdentity(await store(),guestToken,user.id)??token;
  }
  return {token,user,player:user?`account:${user.id}`:createHash("sha256").update(token).digest("hex")};
}
export function reply(body:unknown,token:string,status=200){const response=NextResponse.json(body,{status,headers:{"Cache-Control":"no-store","X-Content-Type-Options":"nosniff"}});response.cookies.set(COOKIE,token,{httpOnly:true,secure:process.env.NODE_ENV==="production",sameSite:"lax",path:"/",maxAge:31536000});return response;}
export function errorReply(error:unknown,token:string){
  const declared=error&&typeof error==="object"&&"status" in error?Number(error.status):error&&typeof error==="object"&&"code" in error?503:400;
  const status=Number.isInteger(declared)&&declared>=400&&declared<=599?declared:400;
  const message=status>=500?"This request couldn't finish. Your last saved move is safe; please retry.":error instanceof Error?error.message:"This request couldn't finish. Please retry.";
  const response=reply({error:message},token,status);if(status===429)response.headers.set("Retry-After","60");return response;
}
export async function readBody(req:NextRequest):Promise<Record<string,unknown>>{
  const origin=req.headers.get("origin");
  if(origin&&new URL(origin).host!==req.headers.get("host"))throw Object.assign(new Error("Invalid request origin."),{status:403});
  if(req.headers.get("sec-fetch-site")==="cross-site")throw Object.assign(new Error("Invalid request origin."),{status:403});
  if(!req.headers.get("content-type")?.toLowerCase().startsWith("application/json"))throw Object.assign(new Error("Send a JSON game action."),{status:415});
  const tooLarge=()=>Object.assign(new Error("Request too large."),{status:413});
  if(Number(req.headers.get("content-length")||0)>2048)throw tooLarge();
  const reader=req.body?.getReader();if(!reader)throw new Error("Missing request body.");
  const chunks:Uint8Array[]=[];let length=0;
  try{while(true){const {value,done}=await reader.read();if(done)break;length+=value.byteLength;if(length>2048){await reader.cancel();throw tooLarge();}chunks.push(value);}}finally{reader.releaseLock();}
  const bytes=new Uint8Array(length);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
  let body;try{body=JSON.parse(new TextDecoder().decode(bytes));}catch{throw new Error("Invalid JSON game action.");}
  if(!body||typeof body!=="object"||Array.isArray(body))throw new Error("Invalid game action.");return body;
}
