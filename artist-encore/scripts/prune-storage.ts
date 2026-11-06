import {openStore,pruneStore} from "../src/lib/store.ts";
const db=await openStore();
try{let result;do{result=await pruneStore(db,Date.now(),true);console.log(JSON.stringify(result,null,2));}while(result.hasMore);if(process.argv.includes("--vacuum")){await db.execute("VACUUM");console.log("Reclaimed unused game database pages.");}}finally{db.close();}
