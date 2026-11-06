import {defineConfig} from "@playwright/test";
import {previewAuth} from "../scripts/preview-auth";

const value=process.env.MUSICAL_DAILY_LIVE_URL;
if(!value)throw new Error("Set MUSICAL_DAILY_LIVE_URL to the deployed Musical Daily HTTPS origin.");
const deployment=new URL(value);
if(deployment.protocol!=="https:"||deployment.username||deployment.password||/^(localhost|127\.|\[?::1\]?$)/i.test(deployment.hostname)){
  throw new Error("The cloud smoke test requires a public HTTPS deployment URL without credentials.");
}

// No app login or provider mocks. Optional CLI authentication opens a protected
// staged deployment; omit it to check the public path a friend opens.
export default defineConfig({
  testDir:"./tests/browser",
  testMatch:"cloud-preview.spec.ts",
  outputDir:"./test-results-cloud",
  timeout:240000,
  expect:{timeout:15000},
  fullyParallel:false,
  workers:1,
  retries:0,
  reporter:"list",
  use:{
    baseURL:deployment.origin,
    headless:true,
    channel:process.platform==="win32"?"chrome":undefined,
    viewport:{width:1440,height:1080},
    actionTimeout:15000,
    navigationTimeout:45000,
    trace:"off",
    video:"off",
    screenshot:"off",
    storageState:previewAuth(deployment.origin)||{cookies:[],origins:[]},
  },
});
