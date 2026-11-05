import { openStore, stats } from "./store.ts";
import { importDatasets, importStreams } from "./importers.ts";
import { enrich, checkMedia } from "./enrich.ts";
import { publish } from "./publish.ts";
import { ingest } from "./ingest.ts";

const [command="stats",...args]=process.argv.slice(2);
function numberOption(name:string,fallback:number){ const i=args.indexOf(name);const value=i<0?fallback:Number(args[i+1]);if(!Number.isInteger(value)||value<1)throw new Error(`Invalid ${name}`);return value; }
const db=openStore();
try{
  if(command==="import")await importDatasets(db,args.includes("--refresh"));
  else if(command==="streams")await importStreams(db);
  else if(command==="enrich")await enrich(db,numberOption("--artists",100),args.includes("--refresh"));
  else if(command==="check")await checkMedia(db,numberOption("--limit",10000));
  else if(command==="ingest")await ingest(db,args[0],args[args.indexOf("--source")+1]);
  else if(command==="review-language"){
    const id=args[args.indexOf("--id")+1],language=args[args.indexOf("--language")+1],evidence=args[args.indexOf("--source")+1];
    if(!args.includes("--id")||!args.includes("--language")||!args.includes("--source")||!/^[A-Za-z0-9]{22}$/.test(id)||!/^[a-z]{2,3}$/.test(language)||!/^https?:\/\//.test(evidence))throw new Error("Usage: review-language --id SPOTIFY_ID --language en --source EVIDENCE_URL");
    if(!db.prepare("SELECT id FROM tracks WHERE id=?").get(id))throw new Error("Unknown recording");
    db.prepare("UPDATE tracks SET language=?,language_source='manual-reviewed',language_review_required=0 WHERE id=?").run(language,id);
    db.prepare("INSERT INTO jobs VALUES('language-review',?,'done',?,?) ON CONFLICT(kind,job_key) DO UPDATE SET details=excluded.details,updated_at=excluded.updated_at").run(id,new Date().toISOString(),JSON.stringify({language,evidence}));
  }
  else if(command==="publish")await publish(db,args.includes("--date")?args[args.indexOf("--date")+1]:undefined);
  else if(command==="maintain"){
    await importDatasets(db,args.includes("--refresh"));
    await importStreams(db);
    await enrich(db,numberOption("--artists",100),args.includes("--refresh"));
    await checkMedia(db,numberOption("--limit",10000));
    await publish(db,args.includes("--date")?args[args.indexOf("--date")+1]:undefined);
  }
  else if(command==="search"){
    const term=args.join(" ");if(!term)throw new Error("Usage: npm run catalog -- search <artist or song>");
    console.log(JSON.stringify(db.prepare("SELECT id,title,artist,language,bpm,popularity FROM tracks WHERE title LIKE ? OR artist LIKE ? ORDER BY popularity DESC LIMIT 30").all(`%${term}%`,`%${term}%`),null,2));
  } else if(command!=="stats")throw new Error(`Unknown command ${command}`);
  console.log(JSON.stringify(stats(db),null,2));
}finally{db.close();}
