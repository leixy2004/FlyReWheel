import { PgBoss, type ConstructorOptions } from 'pg-boss';
import { z } from 'zod';
import { RuleBundleSchema, digestOf } from './core/index.js';
import { AttemptSchema, ReplayDatasetSchema } from './pipeline.js';
import { CodexExecutionConfigSchema } from './model-runtime.js';

export const REPLAY_QUEUE = 'flyrewheel-replay';
const jobBase = {
  bundle: RuleBundleSchema, dataset: ReplayDatasetSchema,
  workload: z.enum(['interactive', 'background']).default('background'),
  attempt: AttemptSchema.default('initial'),
};
export const ReplayJobSchema = z.discriminatedUnion('mode', [
  z.object({ ...jobBase, mode: z.literal('offline_fixture') }).strict(),
  z.object({ ...jobBase, mode: z.literal('model'), modelConfig: CodexExecutionConfigSchema }).strict(),
]);
export type ReplayJob = z.infer<typeof ReplayJobSchema>;
export type ReplayJobInput = z.input<typeof ReplayJobSchema>;
export const QUEUE_POLICY = {
  policy: 'standard' as const,
  retryLimit: 2, retryDelay: 60, retryBackoff: true, retryDelayMax: 600,
  expireInSeconds: 1800, heartbeatSeconds: 60,
  retentionSeconds: 7 * 86400, deleteAfterSeconds: 86400,
};
export function replayJobId(payload: ReplayJobInput): string {
  const d = digestOf(ReplayJobSchema.parse(payload));
  return `${d.slice(0, 8)}-${d.slice(8, 12)}-5${d.slice(13, 16)}-a${d.slice(17, 20)}-${d.slice(20, 32)}`;
}
export async function openQueue(options: ConstructorOptions): Promise<PgBoss> {
  const boss = new PgBoss(options);
  // Error contents may contain connection strings; callers get an operational signal without secrets.
  boss.on('error', () => process.stderr.write('FlyReWheel queue database error; inspect secured database logs\n'));
  await boss.start();
  await boss.createQueue(REPLAY_QUEUE, QUEUE_POLICY);
  const { policy: _policy, ...mutablePolicy } = QUEUE_POLICY;
  await boss.updateQueue(REPLAY_QUEUE, mutablePolicy);
  return boss;
}
export async function enqueueReplay(boss: PgBoss, input: ReplayJobInput) {
  const payload = ReplayJobSchema.parse(input);
  if (Buffer.byteLength(JSON.stringify(payload)) > 512_000) throw new Error('Replay payload exceeds 512KB; split the dataset into explicit batches');
  return boss.send(REPLAY_QUEUE, payload, { id: replayJobId(payload), priority: payload.workload === 'interactive' ? 10 : 0, group: { id: 'codex-personal-serialized' } });
}
/** One queue/group serializes account-auth use; queue concurrency is NOT a token-rate limiter. */
export async function workReplay(boss: PgBoss, handler: (payload: ReplayJob, signal: AbortSignal) => Promise<unknown>) {
  return boss.work<ReplayJob>(REPLAY_QUEUE, { batchSize: 1, localConcurrency: 1, groupConcurrency: 1, heartbeatRefreshSeconds: 20 }, async jobs => {
    const job = jobs[0];
    if (!job) return;
    return handler(ReplayJobSchema.parse(job.data), job.signal);
  });
}
