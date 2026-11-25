import { randomUUID } from 'node:crypto';

const base = (process.env.API_URL ?? 'http://localhost:3000').replace(/\/$/,'');
async function request(path: string, body?: unknown, key?: string) {
  const response = await fetch(base + path, { method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type':'application/json', ...(key ? {'Idempotency-Key':key} : {}) },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(30000) });
  const data = await response.json() as Record<string, unknown>;
  return { status: response.status, data };
}
const playerId = randomUUID();
const created = await request('/wallets',{playerId,initialBalance:{amount:'100.00',currency:'BRL'}});
if (created.status !== 201) throw new Error(`Wallet creation failed: ${JSON.stringify(created)}`);
const walletId = created.data.id as string;
const operations = [1,2].map(() => ({providerId:'demo-provider',externalTransactionId:randomUUID(),
  playerId,walletId,roundId:randomUUID(),gameId:'fortune-chimp',kind:'BET',money:{amount:'80.00',currency:'BRL'}}));
const results = await Promise.all(operations.map(body => request('/wagering/transactions',body,`demo:${body.externalTransactionId}`)));
if (results.filter(result => result.data.status === 'PROCESSED').length !== 1
  || results.filter(result => result.data.status === 'REJECTED').length !== 1) throw new Error('Concurrency invariant failed');
const replays = await Promise.all(operations.map(body => request('/wagering/transactions',body,`demo:${body.externalTransactionId}`)));
if (replays.some(result => result.data.idempotentReplay !== true)) throw new Error('Replay invariant failed');
const report = await request(`/wallets/${walletId}/reconciliation`,{});
if (report.data.consistent !== true || (report.data.storedBalance as {amount:string}).amount !== '20.00') throw new Error('Reconciliation invariant failed');
console.log(JSON.stringify({walletId,simultaneousBets:results,replays,reconciliation:report.data},null,2));
