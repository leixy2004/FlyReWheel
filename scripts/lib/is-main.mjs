import { realpath } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

/** Compare executable identity only; this does not authorize any filesystem path. */
export async function isMainModule(moduleUrl, argvPath = process.argv[1]) {
  if (!argvPath) return false;
  const launchPath = await realpath(argvPath).catch(() => undefined);
  return launchPath !== undefined && launchPath === await realpath(fileURLToPath(moduleUrl));
}
