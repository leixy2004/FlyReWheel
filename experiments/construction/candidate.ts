import { z } from 'zod';
const Text=z.string().min(1).max(8192);
export const Candidate=z.object({path:Text.refine(p=>!p.startsWith('/') && !p.includes('\\') && p.split('/').every(s=>s && s!=='.' && s!=='..')),
  side:z.enum(['before','after']),start:z.number().int().safe().positive(),end:z.number().int().safe().positive(),
  scope:Text,applicability:Text,invariant:Text,exception:Text,requiredContext:z.array(Text),
}).strict().refine(c=>c.end>=c.start,'invalid span');
