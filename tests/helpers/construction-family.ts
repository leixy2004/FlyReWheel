import { fixture } from '../../experiments/construction/fixture.js';
import { freeze } from '../../experiments/construction/contracts.js';
import { register } from '../../experiments/construction/registry.js';
import { constructedFamilies } from '../../experiments/construction/family-provenance.js';
export function seedConstruction(repository:string){
 const config=fixture();config.repository=repository;
 const frozen=freeze(config,'2026-10-13T00:00:00Z');
 const candidate={path:'fixture.py',side:'after',start:1,end:1,scope:'authored',applicability:'operation',invariant:'guard protects operation',exception:'none',requiredContext:[]};
 const inputs=config.roster.map((r,i)=>({pr:r.pr,packetDigest:r.packetDigest,outcome:'completed',candidates:i===0?[candidate]:[]}));
 register(frozen,inputs);const {construction,families}=constructedFamilies(repository);
 return {construction,families,frozen,inputs};
}
