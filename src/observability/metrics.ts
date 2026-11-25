type Labels = Record<string, string | number>;
const buckets = [0.005,0.01,0.025,0.05,0.1,0.25,0.5,1,2.5,5,10];
function key(name: string, labels: Labels = {}): string {
  const pairs = Object.keys(labels).sort().map(k => `${k}="${String(labels[k]).replace(/["\\\n]/g, '_')}"`);
  return `${name}${pairs.length ? `{${pairs.join(',')}}` : ''}`;
}
class Metrics {
  private readonly values = new Map<string, number>();
  inc(name: string, labels: Labels = {}, value = 1): void {
    const k = key(name, labels); this.values.set(k, (this.values.get(k) ?? 0) + value);
  }
  set(name: string, value: number, labels: Labels = {}): void { this.values.set(key(name, labels), value); }
  observe(name: string, value: number, labels: Labels = {}): void {
    this.inc(`${name}_count`, labels); this.inc(`${name}_sum`, labels, value);
    for (const bound of buckets) this.inc(`${name}_bucket`, { ...labels, le: bound }, value <= bound ? 1 : 0);
    this.inc(`${name}_bucket`, { ...labels, le: '+Inf' });
  }
  render(): string { return [...this.values.entries()].sort().map(([k,v]) => `${k} ${v}`).join('\n') + '\n'; }
}
export const metrics = new Metrics();
for (const name of ['transactions_total','duplicates_total','retries_total','dlq_messages_total','lock_conflicts_total',
  'reconciliation_mismatches_total','outbox_lag_seconds']) metrics.set(name, 0);
