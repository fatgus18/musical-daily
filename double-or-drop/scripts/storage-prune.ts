import {openStore,pruneStore} from "../src/lib/store.ts";

// Run from the app directory, with the same DOUBLE_DROP_DB_PATH as the deployed server.
// Pending account results are retained even when completed run history is pruned.
if(process.argv.length>2)throw new Error("This maintenance command accepts no arguments. Set DOUBLE_DROP_DB_PATH to select the deployment's database.");
const db=openStore();
try{
  const result=pruneStore(db,Date.now(),true);
  // A passive checkpoint lets SQLite reclaim WAL pages without blocking active readers.
  db.exec("PRAGMA wal_checkpoint(PASSIVE)");
  console.log(JSON.stringify({maintenance:"double-drop-retention",...result}));
}finally{db.close();}
