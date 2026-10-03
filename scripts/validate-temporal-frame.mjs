import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const execute = promisify(execFile);
const verifierURL = new URL('./verify-temporal-frame.mjs', import.meta.url);

/** Reuse the canonical verifier without overwriting the saved readiness report. */
export async function validateTemporalFrame(frame, collectorBytes) {
  const directory = await mkdtemp(join(tmpdir(), 'flyrewheel-frame-validation-'));
  try {
    const scripts = join(directory, 'scripts');
    const data = join(directory, 'experiments', 'temporal-pilot');
    await mkdir(scripts, { recursive: true });
    await mkdir(data, { recursive: true });
    const verifier = await readFile(verifierURL);
    await writeFile(join(scripts, 'verify-temporal-frame.mjs'), verifier);
    // Collector bytes are hashed by the verifier; they are never executed.
    await writeFile(join(scripts, 'capture-temporal-frame.mjs'), collectorBytes);
    await writeFile(join(data, 'httpx-2024-frame.json'), JSON.stringify(frame));
    let executionError;
    try {
      await execute(process.execPath, [join(scripts, 'verify-temporal-frame.mjs')], {
        cwd: directory, timeout: 10000, maxBuffer: 1024 * 1024,
        // Do not inherit NODE_OPTIONS, credentials, or preload configuration.
        env: {},
      });
    } catch (error) {
      executionError = error;
    }
    let report;
    try {
      report = JSON.parse(await readFile(join(data, 'annotation-readiness.json'), 'utf8'));
    } catch {
      throw new Error('VERIFIER_REPORT_UNAVAILABLE');
    }
    if (executionError || report.verification?.passed !== true) {
      throw new Error(report.verification?.failure ?? 'VERIFIER_EXECUTION_FAILED');
    }
    return {
      status: 'metadata_integrity_pass', repository: report.repository,
      capturedCount: report.frame.capturedCount, windowCounts: report.frame.counts,
      independentLabels: report.annotation.independentLabels, evaluationReady: false,
      verifierSha256: createHash('sha256').update(verifier).digest('hex'),
      limitations: report.limitations,
    };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length > 3) throw new Error('USAGE: node scripts/validate-temporal-frame.mjs [frame.json]');
    const path = process.argv[2] ?? fileURLToPath(new URL('../experiments/temporal-pilot/httpx-2024-frame.json', import.meta.url));
    const bytes = await readFile(path);
    const collector = await readFile(new URL('./capture-temporal-frame.mjs', import.meta.url));
    console.log(JSON.stringify({ ...await validateTemporalFrame(JSON.parse(bytes), collector),
      frameSha256: createHash('sha256').update(bytes).digest('hex') }, null, 2));
  } catch (error) {
    console.error(`Temporal frame validation failed: ${error.message}`);
    process.exitCode = 1;
  }
}
