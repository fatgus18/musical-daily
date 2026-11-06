import {openStore,pruneStore} from "../src/lib/store.ts";

// Uses the same managed database as the deployed server; local development keeps SQLite.
if(process.argv.length>2)throw new Error("This maintenance command accepts no arguments. Configure the database environment to select the deployment's storage.");
const db=await openStore();
try{
  let result;
  do{
    result=await pruneStore(db,Date.now(),true);
    console.log(JSON.stringify({maintenance:"double-drop-retention",...result}));
  }while(result.expired===10);
}finally{db.close();}
