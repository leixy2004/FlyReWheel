// Preserve the standalone Node check while registering with the default Vitest suite.
const test = process.env.VITEST === 'true' ? (await import('vitest')).test : (await import('node:test')).default;
import assert from 'node:assert/strict';
import { generate, localInputs, paths } from '../scripts/freeze-w0-inspection-plan.mjs';

test('frozen roster retains every W0 identity and prior insufficient-evidence decision', () => {
  const inputs = localInputs();
  const plan = generate(inputs);
  const frame = JSON.parse(inputs.frame);
  assert.deepEqual(plan.rows.map(({number}) => number).sort((a,b)=>a-b),
    frame.pullRequests.filter(p=>p.window==='W0').map(p=>p.number).sort((a,b)=>a-b));
  for (const row of plan.rows) {
    const original = frame.pullRequests.find(p=>p.number===row.number);
    for (const key of ['mergedAt','mergeCommit','parents','tree']) assert.deepEqual(row[key],original[key]);
    assert.equal(row.independentHumanLabels,0);
    assert.equal(row.newSourceRequests,0);
    assert.equal(row.constructionAttempt,null);
  }
  assert.deepEqual(plan.rows.slice(0,3).map(p=>p.priorAdmission),JSON.parse(inputs.admission).rows);
  assert.equal(plan.rows.filter(p=>p.screening.status==='pending').length,35);
  assert.equal(plan.acquisitionAuthorized,false);
});
test('input alteration cannot silently replace or reorder the frozen cohort', () => {
  const inputs = localInputs();
  const frame = JSON.parse(inputs.frame);
  frame.pullRequests.reverse();
  assert.throws(()=>generate({...inputs,frame:JSON.stringify(frame)}),/Pinned frame/);
  assert.throws(()=>generate({...inputs,admission:inputs.admission+' '}),/Pinned admission/);
});
test('protocol changes are visible and repeated generation is byte deterministic', () => {
  const inputs = localInputs();
  assert.deepEqual(generate(inputs),generate(inputs));
  assert.notEqual(generate(inputs).inputDigests[paths.protocol],
    generate({...inputs,protocol:inputs.protocol+' changed'}).inputDigests[paths.protocol]);
});
