import {openStore,pruneStore} from "../src/lib/store.ts";
const db=openStore();
try{console.log(JSON.stringify(pruneStore(db,Date.now(),true),null,2));db.exec("PRAGMA wal_checkpoint(TRUNCATE)");if(process.argv.includes("--vacuum")){db.exec("VACUUM");console.log("Reclaimed unused game database pages.");}}finally{db.close();}
