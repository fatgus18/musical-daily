import type {NextConfig} from "next";
import {resolve} from "node:path";
const config:NextConfig={poweredByHeader:false,transpilePackages:["@musical-daily/accounts"],turbopack:{root:resolve(process.cwd(),"..")},outputFileTracingRoot:resolve(process.cwd(),".."),outputFileTracingExcludes:{"/api/*":["./data/*.sqlite*","./data/cache/**","./data/runtime/**"]},async headers(){return [{source:"/(.*)",headers:[{key:"X-Content-Type-Options",value:"nosniff"},{key:"Referrer-Policy",value:"strict-origin-when-cross-origin"},{key:"X-Frame-Options",value:"DENY"}]}];}};
export default config;
