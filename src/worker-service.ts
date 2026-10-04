import { createServer } from 'node:http';
import type { PgBoss } from 'pg-boss';
import type { QualEvoStore } from './storage/index.js';
import { APPLICATION_QUEUE, workApplication, workReplay } from './jobs.js';
import { createApplicationJobDispatcher, type ApplicationDispatcherDependencies } from './application-dispatcher.js';
import { replayDataset } from './pipeline.js';
import { configuredCodex } from './model-runtime.js';
import { S3ArtifactStore } from './artifacts.js';

export interface WorkerServiceOptions {
  store: QualEvoStore; boss: PgBoss; environment?: NodeJS.ProcessEnv; port?: number; host?: string;
  /** Trusted bootstrap injection only; the executable requires explicit reviewed-module opt-in. */
  application?: Omit<ApplicationDispatcherDependencies, 'store'>;
  onResult?: (result: unknown) => void;
}
export function applicationRuntimeStatus(application?: WorkerServiceOptions['application']) {
  return application?.runtime && application.config?.enabled && application.resolveWorkspace ? 'configured' : 'blocked';
}
/** Registers both application and legacy replay work on the existing pg-boss
 * service. Owns graceful stop; never creates a backend from queue/environment JSON. */
export async function startWorkerService(options: WorkerServiceOptions) {
  const { store, boss } = options, environment = options.environment ?? process.env;
  let ready = false, stopping = false, reconciling = false;
  let maintenance: ReturnType<typeof setInterval> | undefined;
  let maintenanceTask: Promise<void> = Promise.resolve();
  const shutdownController = new AbortController();
  const applicationRuntime = applicationRuntimeStatus(options.application);
  const health = createServer((request, response) => {
    const healthy = request.url === '/healthz' || (request.url === '/readyz' && ready && !stopping);
    response.writeHead(healthy ? 200 : 503, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ status: healthy ? 'ok' : 'not_ready', applicationRuntime }));
  });
  const onError = () => { ready = false; };
  boss.on('error', onError);
  const required = (name: string) => { const value = environment[name]; if (!value) throw new Error(`Missing ${name}`); return value; };
  let artifacts: S3ArtifactStore | undefined;
  const maintenancePass = async () => {
    if (stopping || reconciling) return;
    reconciling = true;
    try {
      await store.reconcileExpiredApplicationJobs();
      await boss.getQueue(APPLICATION_QUEUE);
      if (!stopping) ready = true;
    } catch { ready = false; }
    finally { reconciling = false; }
  };
  const closeResources = async () => {
    clearInterval(maintenance);
    try { await boss.stop({ graceful: true, timeout: 150_000 }); }
    finally {
      try { await maintenanceTask; await store.close(); }
      finally { await new Promise<void>(resolve => health.close(() => resolve())); boss.off('error', onError); }
    }
  };
  const report = options.onResult ?? (value => process.stdout.write(JSON.stringify(value) + '\n'));
  try {
    artifacts = environment.QE_S3_ENABLED === 'true' ? new S3ArtifactStore({
      endpoint: required('QE_S3_ENDPOINT'), bucket: required('QE_S3_BUCKET'),
      accessKeyId: required('QE_S3_ACCESS_KEY_ID'), secretAccessKey: required('QE_S3_SECRET_ACCESS_KEY'),
      region: environment.QE_S3_REGION ?? 'us-east-1', allowInsecureDevelopment: environment.QE_S3_ALLOW_INSECURE === 'true',
    }) : undefined;
    await store.reconcileExpiredApplicationJobs();
    await workReplay(boss, async (job, signal) => {
      if (signal.aborted || stopping) throw new Error('Worker is stopping before execution');
      if (job.mode === 'model' && job.dataset.samples.length > 8) throw new Error('Model jobs are bounded to 8 cases; split into explicit batches');
      const adapter = job.mode === 'model' ? configuredCodex(environment, job.modelConfig) : undefined;
      const inputArtifact = artifacts ? await artifacts.put(Buffer.from(JSON.stringify(job))) : null;
      const result = await replayDataset({ store, bundle: job.bundle, dataset: job.dataset, mode: job.mode,
        modelConfig: adapter?.executionConfig, attempt: job.attempt, signal: AbortSignal.any([signal, shutdownController.signal]),
        adjudicator: adapter?.adjudicate });
      const resultArtifact = artifacts ? await artifacts.put(Buffer.from(JSON.stringify(result))) : null;
      if (inputArtifact) await store.recordArtifactLink({ evaluationId: result.evaluationId, kind: 'input', ref: inputArtifact });
      if (resultArtifact) await store.recordArtifactLink({ evaluationId: result.evaluationId, kind: 'result', ref: resultArtifact });
      const summary = { evaluationId: result.evaluationId, status: result.report.metrics.executionErrors ? 'completed_with_errors' : 'completed',
        errors: result.report.metrics.executionErrors, observations: result.observations.length, productionEligible: result.report.eligible,
        inputArtifact, resultArtifact };
      report(summary); return summary;
    });
    const dispatch = createApplicationJobDispatcher({ ...options.application, store });
    await workApplication(boss, async (job, signal) => {
      const result = await dispatch(job, AbortSignal.any([signal, shutdownController.signal]));
      report({ kind: job.kind, ...result }); return result;
    });
    await new Promise<void>((resolve, reject) => {
      health.once('error', reject);
      health.listen(options.port ?? Number(environment.PORT ?? 8080), options.host ?? '0.0.0.0', () => {
        health.off('error', reject); resolve();
      });
    });
    ready = true;
    maintenance = setInterval(() => { if (!reconciling) maintenanceTask = maintenancePass(); }, 30_000);
    maintenance.unref();
  } catch (error) {
    shutdownController.abort(); ready = false; stopping = true;
    try { await closeResources(); } catch { /* Preserve the initiating startup failure. */ }
    throw error;
  }
  let closing: Promise<void> | undefined;
  return { health, applicationRuntime,
    stop(): Promise<void> {
      if (!closing) closing = (async () => {
        stopping = true; ready = false; shutdownController.abort();
        await closeResources();
      })();
      return closing;
    },
  };
}
