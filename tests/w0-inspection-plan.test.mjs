// Preserve the standalone Node check while registering with the default Vitest suite.
const test = process.env.VITEST === 'true' ? (await import('vitest')).test : (await import('node:test')).default;
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { generate as generatePinned, buildInspectionPlan as generate, verifyPinnedInputs, paths } from '../scripts/freeze-w0-inspection-plan.mjs';

// Authored inputs only: never load the retained research frame or admission report.
function localInputs() {
  const numbers = [3035, 3031, 3036, ...Array.from({length:35}, (_,i)=>20000+i)];
  const frame = {selection:{windows:[{id:'W0'}]},pullRequests:numbers.map((number,i)=>({
    number,window:'W0',mergedAt:new Date(Date.UTC(2024,0,1+i)).toISOString(),
    mergeCommit:'a'.repeat(40),parents:['b'.repeat(40)],tree:'c'.repeat(40),
  }))};
  const admission={rows:numbers.slice(0,3).map(number=>({number,missing:['authored missing context']})),
    conclusions:['authored blocked','authored blocked','authored blocked']};
  return {frame:JSON.stringify(frame),admission:JSON.stringify(admission),protocol:'authored protocol'};
}
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
  const pins = Object.fromEntries(['frame','admission'].map(k=>[k,createHash('sha256').update(inputs[k]).digest('hex')]));
  verifyPinnedInputs(inputs,pins);
  const frame = JSON.parse(inputs.frame);
  frame.pullRequests.reverse();
  assert.throws(()=>verifyPinnedInputs({...inputs,frame:JSON.stringify(frame)},pins),/Pinned frame/);
  assert.throws(()=>verifyPinnedInputs({...inputs,admission:inputs.admission+' '},pins),/Pinned admission/);
  assert.throws(()=>generatePinned(inputs),/Pinned frame/);
  assert.deepEqual(generate({...inputs,frame:JSON.stringify(frame)}).rows,generate(inputs).rows);
});
test('protocol changes are visible and repeated generation is byte deterministic', () => {
  const inputs = localInputs();
  assert.deepEqual(generate(inputs),generate(inputs));
  assert.notEqual(generate(inputs).inputDigests[paths.protocol],
    generate({...inputs,protocol:inputs.protocol+' changed'}).inputDigests[paths.protocol]);
});
