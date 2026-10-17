const test=require('node:test')
const assert=require('node:assert/strict')
const fs=require('fs')
const path=require('path')
const {PGlite}=require('@electric-sql/pglite')
test('Worlds report policy permits 09/14 upserts while preserving ordinary brief rules and denying other rows',async()=>{
 const db=new PGlite()
 try{
  await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated;
   CREATE TABLE public.daily_brief(id text PRIMARY KEY,date text,kind text,mode text,payload jsonb,pub_at timestamptz,generated_at timestamptz);
   ALTER TABLE public.daily_brief ENABLE ROW LEVEL SECURITY;
   GRANT USAGE ON SCHEMA public TO anon,authenticated;
   GRANT SELECT,INSERT,UPDATE ON public.daily_brief TO anon,authenticated;
   CREATE POLICY ordinary_read ON public.daily_brief FOR SELECT USING(id LIKE 'morning-%');
   INSERT INTO public.daily_brief(id,date,kind) VALUES ('morning-2026-10-24','2026-10-24','morning');`)
  const migration=fs.readFileSync(path.join(__dirname,'../migrations/20261017_worlds_brief.sql'),'utf8')
  await db.exec(migration);await db.exec(migration)
  const put=async({day='2026-10-24',id=`worlds-morning-${day}`,hour=9,payloadId=id}={})=>{
   const payload={id:payloadId,date:day,version:1,editionHour:hour}
   return db.query(`INSERT INTO public.daily_brief(id,date,kind,mode,payload) VALUES($1,$2,'morning','report',$3)
    ON CONFLICT(id) DO UPDATE SET payload=excluded.payload RETURNING id`,[id,day,JSON.stringify(payload)])
  }
  for(const role of ['anon','authenticated']){
   await db.exec(`SET ROLE ${role}`)
   await put();await put({hour:14})
   const row=await db.query("SELECT payload->>'editionHour' AS hour FROM public.daily_brief WHERE id='worlds-morning-2026-10-24'")
   assert.equal(row.rows[0].hour,'14')
   await assert.rejects(put({hour:13}),/row-level security/)
   await assert.rejects(put({day:'2026-12-01'}),/row-level security/)
   await assert.rejects(put({payloadId:'different-report'}),/row-level security/)
   await assert.rejects(put({id:'morning-2026-10-24'}),/row-level security/)
   await db.exec('RESET ROLE')
  }
  assert.equal((await db.query("SELECT COUNT(*) AS n FROM pg_policies WHERE policyname='ordinary_read'")).rows[0].n,1)
 }finally{await db.close()}
})
