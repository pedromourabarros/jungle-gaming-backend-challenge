import { randomUUID } from 'node:crypto';
import { arch, availableParallelism, platform } from 'node:os';
import { dirname } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { Money } from '../src/domain';

function setting(name: string, fallback: number, maximum: number): number {
  const value=Number(process.env[name]??fallback);
  if (!Number.isSafeInteger(value)||value<1||value>maximum) throw new Error(`Invalid ${name}`);
  return value;
}
const total=setting('LOAD_REQUESTS',1000,100000);
const concurrency=setting('LOAD_CONCURRENCY',25,200);
const walletCount=setting('LOAD_WALLETS',20,500);
const urls=(process.env.LOAD_URLS??process.env.API_URL??'http://localhost:3000').split(',').map(url=>url.trim().replace(/\/$/,''));
if (urls.some(url=>!/^https?:\/\//.test(url))) throw new Error('LOAD_URLS must contain HTTP(S) base URLs');
const runId=randomUUID();
const reportPath=process.env.LOAD_REPORT_PATH??'test-results/load-report.json';
const wallets:{id:string;playerId:string}[]=[];
for(let i=0;i<walletCount;i++) {
  const playerId=randomUUID();
  const response=await fetch(`${urls[i%urls.length]}/wallets`,{method:'POST',headers:{'content-type':'application/json'},
    body:JSON.stringify({playerId,initialBalance:{amount:'1000000.00',currency:'BRL'}}),signal:AbortSignal.timeout(30000)});
  if(response.status!==201)throw new Error(`Load setup failed with HTTP ${response.status}`);
  wallets.push({id:(await response.json() as {id:string}).id,playerId});
}

type Snapshot={lockConflicts:number;retries:number;outboxLag:number;outboxPending:number};
async function metricSnapshot():Promise<Snapshot> {
  const documents=await Promise.all(urls.map(async url=>{
    const response=await fetch(`${url}/metrics`,{signal:AbortSignal.timeout(5000)});
    if(!response.ok)throw new Error('Metrics endpoint unavailable');
    return response.text();
  }));
  function values(prefix:string):number[]{return documents.map(doc=>doc.split('\n').reduce((sum,line)=>{
    const match=line.match(new RegExp(`^${prefix}(?:\\{[^}]*\\})?\\s+([0-9.eE+-]+)$`));
    return sum+(match?Number(match[1]):0);
  },0));}
  return {lockConflicts:values('lock_conflicts_total').reduce((a,b)=>a+b,0),retries:values('retries_total').reduce((a,b)=>a+b,0),
    outboxLag:Math.max(...values('outbox_lag_seconds')),outboxPending:Math.max(...values('outbox_pending'))};
}
const before=await metricSnapshot();
const latency:number[]=[];
const statuses:Record<string,number>={};
const unique=new Set<string>();
const debits=new Map<string,bigint>();
let replays=0, failures=0, next=0, peakLag=before.outboxLag, sampling=true;
const samplingTask=(async()=>{while(sampling){const sample=await metricSnapshot();peakLag=Math.max(peakLag,sample.outboxLag);await Bun.sleep(250);}})();
const started=performance.now();
await Promise.all(Array.from({length:Math.min(concurrency,total)},async()=>{
  while(next<total){
    const index=next++;
    // Exactly one in five requests repeats the immediately preceding business identity.
    const operation=index%5===4?index-1:index;
    const wallet=wallets[operation%walletCount]!;
    const external=`load-${runId}-${operation}`;
    const startedRequest=performance.now();
    try {
      const response=await fetch(`${urls[index%urls.length]}/wagering/transactions`,{method:'POST',
        headers:{'content-type':'application/json','Idempotency-Key':external},signal:AbortSignal.timeout(30000),
        body:JSON.stringify({providerId:'load-provider',externalTransactionId:external,playerId:wallet.playerId,walletId:wallet.id,
          roundId:`load-round-${runId}`,gameId:'load-game',kind:'BET',money:{amount:'1.00',currency:'BRL'}})});
      const body=await response.json() as {status?:string;idempotentReplay?:boolean;transactionId?:string};
      statuses[String(response.status)]=(statuses[String(response.status)]??0)+1;
      if(response.status!==200||body.status!=='PROCESSED')failures++;
      else {
        if(body.idempotentReplay)replays++;
        if(!unique.has(external)){unique.add(external);debits.set(wallet.id,(debits.get(wallet.id)??0n)+1n);}
      }
    }catch{failures++;statuses.network_error=(statuses.network_error??0)+1;}
    finally{latency.push(performance.now()-startedRequest);}
  }
}));
const durationMs=performance.now()-started;
sampling=false;
await samplingTask;
latency.sort((a,b)=>a-b);
const percentile=(p:number)=>latency[Math.max(0,Math.ceil(p*latency.length)-1)]??0;
const after=await metricSnapshot();
peakLag=Math.max(peakLag,after.outboxLag);
const reconciliation=[];
for(const wallet of wallets){
  const response=await fetch(`${urls[0]}/wallets/${wallet.id}/reconciliation`,{method:'POST',signal:AbortSignal.timeout(10000)});
  const body=await response.json() as {consistent:boolean;storedBalance:{amount:string;currency:string};checkedEntries:number};
  const expected=Money.from({amount:'1000000.00',currency:'BRL'}).subtract(Money.from({amount:`${debits.get(wallet.id)??0n}.00`,currency:'BRL'}));
  reconciliation.push(response.ok&&body.consistent&&expected.equals(Money.from(body.storedBalance)));
}
const report={
  runId,occurredAt:new Date().toISOString(),environment:{bun:Bun.version,platform:platform(),arch:arch(),
    availableParallelism:availableParallelism(),applicationInstances:urls.length,
    note:process.env.LOAD_ENVIRONMENT??'Record host/container resources separately when comparing runs'},
  methodology:{requests:total,concurrency,wallets:walletCount,duplicateRule:'every fifth request replays the preceding identity',
    warmup:'wallet creation and metrics fetch excluded',measurement:'HTTP submission only; reconciliation after the measured interval',
    money:'1.00 BRL per unique BET, 1000000.00 BRL initial balance per wallet'},
  results:{durationMs,requestsPerSecond:total/(durationMs/1000),uniqueProcessed:unique.size,replays,
    failures,errorRate:failures/total,httpStatuses:statuses,latencyMs:{p50:percentile(0.5),p95:percentile(0.95),p99:percentile(0.99)},
    lockConflicts:after.lockConflicts-before.lockConflicts,retries:after.retries-before.retries,
    peakObservedOutboxLagSeconds:peakLag,outboxPendingAtMeasurementEnd:after.outboxPending,
    reconciledWallets:reconciliation.filter(Boolean).length,allWalletsConsistent:reconciliation.every(Boolean)},
  limitations:['Short local measurement; not a production capacity estimate.',
    'Outbox publication is asynchronous; HTTP throughput is not event-consumer throughput.',
    'A single run provides no statistical confidence interval.'],
};
await mkdir(dirname(reportPath),{recursive:true});
await Bun.write(reportPath,JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify(report,null,2));
if(failures||!report.results.allWalletsConsistent)process.exitCode=1;
