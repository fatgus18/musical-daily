import {loadCatalog} from "@/lib/catalog";
import {store,transaction} from "@/lib/store";

export const runtime="nodejs";export const dynamic="force-dynamic";
/** Readiness checks never disclose player rows, secrets, or filesystem locations. */
export async function GET(){
  const headers={"Cache-Control":"no-store"};
  try{
    const db=await store();
    // A write transaction verifies the persistent volume is writable without changing player data.
    await transaction(db,async tx=>tx.execute("SELECT 1 AS ready"));
    const catalog=loadCatalog();
    return Response.json({status:"ok",service:"double-or-drop",catalog:{version:catalog.version,tracks:catalog.tracks.length},storage:"ready"},{headers});
  }catch{return Response.json({status:"unavailable",service:"double-or-drop"},{status:503,headers});}
}
