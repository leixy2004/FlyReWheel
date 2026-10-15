// Supplementary acceptance only. Every writable artifact is under a fresh temporary root.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, readdir, copyFile, stat, symlink, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { digestOf } from '../dist/core/identity.js';
import { openPGliteDatabase } from '../dist/storage/database.js';
import { migrateDatabase, inspectDatabaseMigrations, MIGRATIONS_DIRECTORY } from '../dist/storage/migrations.js';
const root=fileURLToPath(new URL('..',import.meta.url));
const directory=await mkdtemp(join(tmpdir(),'feedback-boundaries-')),dbPath=join(directory,'current-db'),commands=[],checks=[];
const env={PATH:process.env.PATH,HOME:join(directory,'home'),LANG:'C.UTF-8',TZ:'UTC'};
function cli(args,db=dbPath,expected=0){
 const r=spawnSync(process.execPath,['dist/cli.js',...args,'--db',db],{cwd:root,env,timeout:30000,maxBuffer:6000000,encoding:'utf8'});
 if(r.error)throw r.error;
 commands.push({args,db,exitCode:r.status,stderr:r.stderr,stdoutDigest:digestOf(r.stdout)});
 assert.equal(r.status,expected,r.stderr);return r;
}
async function snapshot(path){
 const db=await openPGliteDatabase(path);
 try {
  const migrations=await inspectDatabaseMigrations(db);
  const tables=(await db.query("SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE' ORDER BY table_name")).rows;
  const domain={};
  for(const {table_name:name} of tables){
   if(name.startsWith('qe_schema_migration'))continue;
   assert.match(name,/^[a-z_]+$/);
   const rows=(await db.query(`SELECT to_jsonb(t) AS value FROM "${name}" t`)).rows.map(r=>r.value);
   domain[name]={rows:rows.length,digest:digestOf(rows.map(digestOf).sort())};
  }
  return {applied:migrations.applied,pending:migrations.pending,domain};
 } finally {await db.close();}
}
const demo=JSON.parse(cli(['reviews','demo']).stdout);
const finding=demo.review.findings[0];
const base=['feedback','prepare','--finding-id',finding.id,'--id','isolated-output-check','--kind','label','--label','FP','--source','fixture',
 '--actor','synthetic-boundary-check','--reason','Synthetic boundary validation only; not a human assessment.','--created-at','2026-10-15T00:00:00Z'];
const baseline=await snapshot(dbPath);
const out=join(directory,'draft.json');
assert.equal(cli([...base,'--out',out]).stdout,'');
const prepared=JSON.parse(await readFile(out,'utf8'));
assert.equal(prepared.reviewId,finding.reviewId);assert.equal(prepared.ruleDigest,finding.ruleDigest);assert.equal(prepared.ruleVersion,finding.ruleVersion);
assert.equal((await stat(out)).mode&0o777,0o600);
checks.push({scenario:'new --out file',result:'created exact bound JSON with mode 0600; stdout empty'});
await writeFile(out,'existing isolated draft\n');
cli([...base,'--out',out]);assert.deepEqual(JSON.parse(await readFile(out,'utf8')),prepared);
checks.push({scenario:'existing --out file',result:'existing isolated draft replaced by prepared JSON'});
const target=join(directory,'symlink-target.json'),link=join(directory,'draft-link.json');await writeFile(target,'isolated symlink sentinel');await symlink(target,link);
cli([...base,'--out',link]);assert.ok((await lstat(link)).isSymbolicLink());assert.deepEqual(JSON.parse(await readFile(target,'utf8')),prepared);
checks.push({scenario:'--out symlink',result:'symlink retained; isolated target overwritten'});
const replace=(flag,value)=>{const args=[...base];args[args.indexOf(flag)+1]=value;return args;};
for(const [scenario,args] of [['invalid kind/label combination',replace('--kind','note')],['missing finding',replace('--finding-id',`review_finding_${'f'.repeat(64)}`)]]){
 await writeFile(out,'must remain unchanged\n');cli([...args,'--out',out],dbPath,1);assert.equal(await readFile(out,'utf8'),'must remain unchanged\n');checks.push({scenario,result:'exit 1; existing output unchanged'});
}
const outputDir=join(directory,'output-is-directory');await mkdir(outputDir);
assert.match(cli([...base,'--out',outputDir],dbPath,1).stderr,/EISDIR/);
assert.match(cli([...base,'--out',join(directory,'absent-parent','output.json')],dbPath,1).stderr,/ENOENT/);
checks.push({scenario:'output path is directory / parent missing',result:'both exit 1 (EISDIR / ENOENT); no domain records changed'});
const after=await snapshot(dbPath);assert.deepEqual(after,baseline);
checks.push({scenario:'current database domain state across all output cases',result:'all domain tables row counts and content digests unchanged; migration metadata unchanged'});
const databaseCases=[];
for(const mode of ['new-invalid-label','new-missing-finding','pending-migration-invalid-label']){
 const path=join(directory,mode),file=join(directory,mode+'.json');let before=null;
 if(mode.startsWith('pending')){
  const prefix=join(directory,'migrations-through-017');await mkdir(prefix);
  for(const name of (await readdir(MIGRATIONS_DIRECTORY)).filter(n=>/^\d+_.*\.sql$/.test(n)&&Number(n.split('_')[0])<=17))await copyFile(join(MIGRATIONS_DIRECTORY,name),join(prefix,name));
  const db=await openPGliteDatabase(path);
  try{await migrateDatabase(db,{directory:prefix});await db.query("INSERT INTO qe_case_lineages(id,split) VALUES ('synthetic-boundary-sentinel','training')");}finally{await db.close();}
  before=await snapshot(path);assert.equal(before.applied.length,17);assert.equal(before.pending.length,1);
 }else await assert.rejects(stat(path),e=>e.code==='ENOENT');
 const args=mode.includes('invalid-label')?replace('--label','invalid'):replace('--finding-id',`review_finding_${'f'.repeat(64)}`);
 const failure=cli([...args,'--out',file],path,1);await assert.rejects(stat(file),e=>e.code==='ENOENT');
 const result=await snapshot(path);assert.equal(result.applied.length,18);assert.equal(result.pending.length,0);
 if(before){
  for(const [table,value] of Object.entries(before.domain))assert.deepEqual(result.domain[table],value);
  assert.equal(result.domain.qe_application_job_attempt_history.rows,0);
 }else assert.ok(Object.values(result.domain).every(v=>v.rows===0));
 databaseCases.push({scenario:mode,commandExitCode:1,error:failure.stderr,outputCreated:false,before,after:result,
  result:before?'migration 018 applied despite invalid input; existing domain content unchanged; new attempt ledger empty':'new database initialized through 018 despite failure; all domain tables empty'});
}
const report={status:'passed',testedCodeHead:'8db3f87da89e1de561a956ae9c96ece2cc1d6441',checks,databaseCases,commands,
 counts:{successfulCliCalls:commands.filter(c=>c.exitCode===0).length,expectedRejectedCliCalls:commands.filter(c=>c.exitCode===1).length},
 evidenceNature:'actual compiled CLI in fresh isolated synthetic databases and files; no real human feedback',
 staticOnly:['writeFile is non-atomic; a mid-write filesystem failure could leave truncated content. No mid-write failure or disk exhaustion was induced.','PostgreSQL initialization uses the same migration entrypoint, but only PGlite was exercised.'],
 limitations:['pending-migration fixture had one synthetic lineage sentinel and no application-job results; migration backfill of populated job history was not exercised'],
 outcome:'No wrong association or unexpected domain data loss observed. Initialization/migration is an actual side effect even on invalid input; --out overwrites files and follows symlinks as the existing shared writer specifies.',
 noProductChanges:true,modelCalls:0};
await writeFile(join(directory,'verification.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({directory,...report},null,2));
