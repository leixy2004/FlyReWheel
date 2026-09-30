import { createServer } from 'node:http';
import { QualEvoStore } from './storage/index.js';
import { openQueue, workReplay } from './jobs.js';
import { replayDataset } from './pipeline.js';
import { configuredCodex } from './model-runtime.js';
import { S3ArtifactStore } from './artifacts.js';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('Worker requires an explicitly configured DATABASE_URL');
let ready = false;
let stopping = false;
const shutdownController = new AbortController();
const health = createServer((request, response) => {
  const healthy = request.url === '/healthz' || (request.url === '/readyz' && ready && !stopping);
  response.writeHead(healthy ? 200 : 503, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify({ status: healthy ? 'ok' : 'not_ready' }));
});
health.listen(Number(process.env.PORT ?? 8080), '0.0.0.0');
const store = await QualEvoStore.openPostgres(databaseUrl);
const boss = await openQueue({ connectionString: databaseUrl });
boss.on('error', () => { ready = false; });
const artifacts = process.env.QE_S3_ENABLED === 'true' ? new S3ArtifactStore({
  endpoint: required('QE_S3_ENDPOINT'), bucket: required('QE_S3_BUCKET'),
  accessKeyId: required('QE_S3_ACCESS_KEY_ID'), secretAccessKey: required('QE_S3_SECRET_ACCESS_KEY'),
  region: process.env.QE_S3_REGION ?? 'us-east-1', allowInsecureDevelopment: process.env.QE_S3_ALLOW_INSECURE === 'true',
}) : undefined;
function required(name: string) { const value = process.env[name]; if (!value) throw new Error(`Missing ${name}`); return value; }
await workReplay(boss, async (job, signal) => {
  if (signal.aborted || stopping) throw new Error('Worker is stopping before execution');
  if (job.mode === 'model' && job.dataset.samples.length > 8) throw new Error('Model jobs are bounded to 8 cases; split into explicit batches');
  const adapter = job.mode === 'model' ? configuredCodex(process.env, job.modelConfig) : undefined;
  const inputArtifact = artifacts ? await artifacts.put(Buffer.from(JSON.stringify(job))) : null;
  const result = await replayDataset({
    store, bundle: job.bundle, dataset: job.dataset, mode: job.mode,
    modelConfig: adapter?.executionConfig, attempt: job.attempt,
    signal: AbortSignal.any([signal, shutdownController.signal]),
    adjudicator: adapter?.adjudicate,
  });
  const resultArtifact = artifacts ? await artifacts.put(Buffer.from(JSON.stringify(result))) : null;
  if (inputArtifact) await store.recordArtifactLink({ evaluationId: result.evaluationId, kind: 'input', ref: inputArtifact });
  if (resultArtifact) await store.recordArtifactLink({ evaluationId: result.evaluationId, kind: 'result', ref: resultArtifact });
  const summary = { evaluationId: result.evaluationId, status: result.report.metrics.executionErrors ? 'completed_with_errors' : 'completed', errors: result.report.metrics.executionErrors, observations: result.observations.length, productionEligible: result.report.eligible, inputArtifact, resultArtifact };
  ready = true;
  process.stdout.write(JSON.stringify(summary) + '\n');
  return summary;
});
ready = true;
async function shutdown() {
  if (stopping) return;
  stopping = true; ready = false;
  shutdownController.abort();
  await boss.stop({ graceful: true, timeout: 150_000 });
  await store.close();
  health.close();
}
process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());
