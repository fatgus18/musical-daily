import {createHash,randomBytes} from "node:crypto";
import {NextRequest,NextResponse} from "next/server";
import {getAccount} from "@musical-daily/accounts/server";
export function anonymousIdentity(req:NextRequest){let token=req.cookies.get("encore_player")?.value;if(!token||!/^\w{64}$/.test(token))token=randomBytes(32).toString("hex");return {token,player:createHash("sha256").update(token).digest("hex")};}
export async function identity(req:NextRequest,token=anonymousIdentity(req).token){let user;try{user=await getAccount(req,"encore");}catch{throw Object.assign(new Error("Your account connection is unavailable. Please retry to keep your progress safe."),{status:503});}return {token,user,player:user?`account:${user.id}`:createHash("sha256").update(token).digest("hex")};}
export function reply(body:unknown,token:string,status=200){const res=NextResponse.json(body,{status,headers:{"Cache-Control":"no-store"}});res.cookies.set("encore_player",token,{httpOnly:true,secure:process.env.NODE_ENV==="production",sameSite:"lax",path:"/",maxAge:31536000});return res;}
export function audioEnabled(){return process.env.ENCORE_AUDIO_ENABLED==="true"||(process.env.NODE_ENV!=="production"&&process.env.ENCORE_AUDIO_ENABLED!=="false");}
export function errorReply(error:unknown,token:string,fallback=400){const declared=error&&typeof error==="object"&&"status" in error?Number(error.status):fallback;const status=Number.isInteger(declared)&&declared>=400&&declared<=599?declared:fallback;const response=reply({error:error instanceof Error?error.message:"This request couldn't finish. Please retry."},token,status);if(status===429)response.headers.set("Retry-After","60");return response;}
export async function readBody(req:NextRequest){
  const origin=req.headers.get("origin");if(origin&&new URL(origin).host!==req.headers.get("host"))throw Object.assign(new Error("Invalid request origin."),{status:403});
  const tooLarge=()=>Object.assign(new Error("Request too large."),{status:413});if(Number(req.headers.get("content-length")||0)>2048)throw tooLarge();
  const reader=req.body?.getReader();if(!reader)throw new Error("Missing request body.");const chunks:Uint8Array[]=[];let length=0;
  try{while(true){const {value,done}=await reader.read();if(done)break;length+=value.byteLength;if(length>2048){await reader.cancel();throw tooLarge();}chunks.push(value);}}finally{reader.releaseLock();}
  const bytes=new Uint8Array(length);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}const body=JSON.parse(new TextDecoder().decode(bytes));if(!body||typeof body!=="object"||Array.isArray(body))throw new Error("Invalid request body.");return body;
}
