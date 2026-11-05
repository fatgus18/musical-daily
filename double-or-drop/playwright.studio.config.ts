import {defineConfig} from "@playwright/test";

// The creation studio belongs to the hub; its audio checks do not need game servers.
export default defineConfig({
  testDir:"./tests/stats",testMatch:["rhythm-studio.spec.ts","hub-home.spec.ts"],
  outputDir:"./test-results-studio",timeout:90000,fullyParallel:false,workers:1,
  use:{headless:true,channel:process.platform==="win32"?"chrome":undefined,viewport:{width:1440,height:1000},trace:"retain-on-failure"},
  webServer:{command:"npm --prefix ../musical-daily run dev",url:"http://localhost:3001",reuseExistingServer:true,timeout:120000},
});
