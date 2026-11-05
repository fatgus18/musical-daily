import {copyFileSync,mkdirSync,readFileSync} from "node:fs";
import {dirname,resolve} from "node:path";
import {fileURLToPath} from "node:url";
const root=resolve(dirname(fileURLToPath(import.meta.url)),"..");
const apps=["musical-daily","blackjack-music","tempo-trap","artist-encore","double-or-drop"];
const files=[["sound-engine.ts","src/components/sound-engine.ts"],["sound-client.tsx","src/components/sound-client.tsx"],["sound-client.css","src/app/sound-client.css"]];
const check=process.argv.includes("--check"),mismatches=[];
for(const app of apps)for(const [sourceName,destinationName] of files){const source=resolve(root,"shared/sound",sourceName),destination=resolve(root,app,destinationName);if(check){try{if(!readFileSync(source).equals(readFileSync(destination)))mismatches.push(`${app}/${destinationName}`);}catch{mismatches.push(`${app}/${destinationName}`);}}else{mkdirSync(dirname(destination),{recursive:true});copyFileSync(source,destination);}}
if(mismatches.length){console.error(`Sound files differ. Run node scripts/sync-sound.mjs:\n${mismatches.join("\n")}`);process.exitCode=1;}else console.log(check?"Sound system matches across the hub and four games.":"Synced sound system to the hub and four games.");
