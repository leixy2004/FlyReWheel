import { digestOf } from '../../src/core/identity.js';
import type { Config } from './contracts.js';
export function fixture():Config {
  return {schemaVersion:1,kind:'construction-configuration',origin:'authored-fixture',repository:'authored/example',
    protocolDigest:digestOf('authored construction fixture v1'),instructions:'Return one source-bound invariant or no candidate.',
    serialization:'canonical-json-v1',candidatePolicy:'one-attempt-one-retained-no-rewrite-v1',
    constructor:{kind:'authored-fixture',version:'v1'},
    limits:{attemptsPerPR:1,retainedPerPR:1,inputTokens:1000,outputTokens:1000,responseBytes:16384,seconds:10},
    roster:[1,2].map(pr=>({pr,mergedAt:`2024-01-0${pr}T00:00:00Z`,packetDigest:digestOf(`authored-packet-${pr}`),priorRejected:false,missingEvidence:[]})),
    exposure:{declaredAt:'2026-10-13T00:00:00Z',firstRemainingSourceAt:null,firstW1At:null,auditDigest:digestOf('synthetic audit; not empirical')},
  };
}
