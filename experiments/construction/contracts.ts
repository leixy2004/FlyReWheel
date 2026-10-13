import { z } from 'zod';
import { DigestSchema } from '../../src/core/model.js';
import { digestOf } from '../../src/core/identity.js';
const Text = z.string().trim().min(1).max(8192);
const Time = z.string().datetime({ offset: true });
const Constructor = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('unconfigured'), missing: z.array(Text).min(1) }).strict(),
  z.object({ kind: z.literal('authored-fixture'), version: Text }).strict(),
  z.object({ kind: z.literal('model'), provider: Text, model: Text, version: Text,
    seed: z.number().int(), temperature: z.number().finite().min(0), instructionsDigest: DigestSchema }).strict(),
]);
export const ConfigSchema = z.object({
  schemaVersion: z.literal(1), kind: z.literal('construction-configuration'),
  origin: z.enum(['authored-fixture', 'development-public-source']),
  repository: Text, protocolDigest: DigestSchema, instructions: Text,
  serialization: z.literal('canonical-json-v1'), candidatePolicy: z.literal('one-attempt-one-retained-no-rewrite-v1'),
  constructor: Constructor,
  limits: z.object({ attemptsPerPR: z.literal(1), retainedPerPR: z.literal(1),
    inputTokens: z.number().int().positive(), outputTokens: z.number().int().positive(),
    responseBytes: z.number().int().positive().max(1048576), seconds: z.number().int().positive() }).strict(),
  roster: z.array(z.object({ pr: z.number().int().positive(), mergedAt: Time,
    packetDigest: DigestSchema.nullable(), priorRejected: z.boolean(), missingEvidence: z.array(Text) }).strict()).min(1),
  exposure: z.object({ declaredAt: Time, firstRemainingSourceAt: Time.nullable(),
    firstW1At: Time.nullable(), auditDigest: DigestSchema.nullable() }).strict(),
}).strict().superRefine((c, ctx) => {
  if (new Set(c.roster.map(r=>r.pr)).size !== c.roster.length) ctx.addIssue({ code:'custom', message:'duplicate PR' });
  const order = [...c.roster].sort((a,b)=>Date.parse(a.mergedAt)-Date.parse(b.mergedAt)||a.pr-b.pr);
  if (order.some((r,i)=>r.pr!==c.roster[i].pr)) ctx.addIssue({ code:'custom', message:'roster must be chronological' });
  if (c.constructor.kind==='authored-fixture' && c.origin!=='authored-fixture') ctx.addIssue({ code:'custom', message:'fixture constructor cannot process public sources' });
  if (c.constructor.kind==='model' && c.constructor.instructionsDigest!==digestOf(c.instructions)) ctx.addIssue({ code:'custom', message:'instructions digest mismatch' });
});
export type Config = z.infer<typeof ConfigSchema>;
export function readiness(input: unknown) {
  const c=ConfigSchema.parse(input); const blockers: string[]=[];
  if(c.constructor.kind==='unconfigured') blockers.push(...c.constructor.missing);
  if(c.origin!=='authored-fixture') blockers.push('real-source exposure audit and execution adapter not implemented; no empirical freeze');
  if(c.constructor.kind==='model') blockers.push('model execution unavailable in offline runner');
  if(c.exposure.firstW1At!==null) blockers.push('W1 already exposed');
  if(c.exposure.auditDigest===null) blockers.push('exposure audit missing');
  for(const r of c.roster) if(!r.priorRejected && (!r.packetDigest || r.missingEvidence.length)) blockers.push(`PR ${r.pr}: incomplete source packet`);
  return { status: blockers.length ? 'blocked' as const : 'authored-ready' as const, blockers, configDigest:digestOf(c), modelCalls:0 };
}
const FreezeSchema=z.object({ kind:z.literal('authored-construction-freeze'), config:ConfigSchema,
  configDigest:DigestSchema, frozenAt:Time, digest:DigestSchema }).strict();
export type Freeze=z.infer<typeof FreezeSchema>;
export function freeze(input:unknown, frozenAt:string):Freeze {
  const c=ConfigSchema.parse(input); Time.parse(frozenAt);
  const report=readiness(c); if(report.blockers.length) throw Error(report.blockers.join('; '));
  if(Date.parse(c.exposure.declaredAt)>Date.parse(frozenAt)) throw Error('audit declaration after freeze');
  if(c.exposure.firstRemainingSourceAt && Date.parse(c.exposure.firstRemainingSourceAt)<=Date.parse(frozenAt)) throw Error('source exposure before configuration freeze');
  const body={kind:'authored-construction-freeze' as const,config:c,configDigest:digestOf(c),frozenAt};
  return {...body,digest:digestOf(body)};
}
export function validateFreeze(input:unknown):Freeze {
  const f=FreezeSchema.parse(input); const expected=freeze(f.config,f.frozenAt);
  if(f.configDigest!==expected.configDigest || f.digest!==expected.digest) throw Error('freeze binding mismatch');
  return f;
}
