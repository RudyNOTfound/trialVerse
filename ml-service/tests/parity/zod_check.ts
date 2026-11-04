// Validates JSON from stdin with the backend's OWN zod schemas (src/ml/contracts.ts, imported read-only).
// stdin: { "risk": [response, ...], "integrity": [response, ...] }   stdout: { risk: [ok|errors], integrity: [...] }
import { riskPredictionResponseSchema, integrityScanResponseSchema, CONTRACT_VERSION } from '../../../src/ml/contracts';

let raw = '';
process.stdin.on('data', (c) => (raw += c));
process.stdin.on('end', () => {
  const input = JSON.parse(raw);
  const run = (schema: { safeParse: (v: unknown) => { success: boolean; error?: { issues: unknown[] } } }, items: unknown[]) =>
    items.map((v) => {
      const r = schema.safeParse(v);
      return r.success ? 'ok' : r.error!.issues;
    });
  const major = (v: string) => v.split('.')[0];
  const out = {
    backendContractVersion: CONTRACT_VERSION,
    risk: run(riskPredictionResponseSchema, input.risk ?? []),
    integrity: run(integrityScanResponseSchema, input.integrity ?? []),
    majorsMatch: [...(input.risk ?? []), ...(input.integrity ?? [])].map((r: { contractVersion: string }) => major(r.contractVersion) === major(CONTRACT_VERSION)),
  };
  process.stdout.write(JSON.stringify(out));
});
