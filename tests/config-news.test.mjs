import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {ConfigStore,GROUP_CHAT_FIELDS,GLOBAL_CHAT_FIELDS,groupDefaults,validate} from '../lib/config.mjs'
import {fetchNews,redact} from '../lib/features/news.mjs'

const BOT='100000001',BOT2='100000002',GROUP='200000001',GROUP2='200000002'
const SECRET='synthetic/key+value=not-real'
const defaults=JSON.parse(fs.readFileSync(new URL('../config/default.json',import.meta.url),'utf8'))
function fixture(t,raw){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'groupguard-config-news-'))
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}))
  const file=path.join(root,'config/local.json')
  if(raw!==undefined){fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,JSON.stringify(raw,null,2)+'\n')}
  return {root,file,store:new ConfigStore(root)}
}
const configured=(store,botId=BOT,groupId=GROUP,patch={})=>store.setNews(botId,groupId,{url:'https://news.example.test/daily',authType:'bearer',keyAction:'replace',key:SECRET,...patch})
const run=(store,fetcher,botId=BOT,groupId=GROUP)=>fetchNews({store,botId,groupId,fetcher})
const response=data=>({ok:true,json:async()=>data})

test('schema 2 defaults remove old policy/service fields and chat fields are explicit',t=>{
  const {store}=fixture(t)
  assert.equal(store.wasLegacy,false)
  assert.equal(store.read().schemaVersion,2);assert.deepEqual(store.read().masters,[])
  for(const k of ['dailyApi','newsSources','legacy','schemaVersion','groups','masters','__proto__','standalone'])assert.equal(GLOBAL_CHAT_FIELDS.has(k),false,k)
  for(const k of ['enabled','botId','groupId','dailyApi','apiKey','newsSources','scheduledMute','autoBlacklistOnLeave','muteTime','unmuteTime'])assert.equal(GROUP_CHAT_FIELDS.has(k),false,k)
  assert.equal(GROUP_CHAT_FIELDS.has('dailyTime'),true);assert.equal(GLOBAL_CHAT_FIELDS.has('timezone'),true)
  assert.equal('scheduledMute'in groupDefaults,false);assert.equal('dailyApi'in defaults,false)
})

test('legacy read is non-writing; explicit migration backs up exact values and is idempotent',t=>{
  const raw={dailyApi:'https://old.example.test/news?key=old-test-key',masters:['300000001'],unrecognized:{keep:['value']},groups:[
    {botId:BOT,groupId:GROUP,enabled:true,scheduledMute:true,muteTime:'00:00',unmuteTime:'08:00',autoBlacklistOnLeave:true,blackUsers:['400000001']},
    {botId:'*',groupId:GROUP2,enabled:true}
  ]}
  const {store,file,root}=fixture(t,raw),before=fs.readFileSync(file,'utf8')
  assert.equal(store.wasLegacy,true)
  const read=store.read()
  assert.equal(fs.readFileSync(file,'utf8'),before);assert.equal(fs.existsSync(path.join(root,'data')),false)
  assert.equal(read.schemaVersion,2);assert.equal(store.getNews(BOT,GROUP,read).url,raw.dailyApi)
  assert.equal(store.getNews(BOT,GROUP2,read),null);assert.equal(store.getNews(BOT2,GROUP,read),null)
  assert.equal(read.legacy.dailyApi,raw.dailyApi);assert.equal('dailyApi'in read,false)
  assert.equal('scheduledMute'in read.groups[0],false);assert.equal(read.legacy.removedGroupPolicies[0].fields.scheduledMute,true)
  assert.deepEqual(read.groups[0].blackUsers,['400000001']);assert.deepEqual(read.unrecognized,raw.unrecognized)
  store.migrate()
  const backupDir=path.join(root,'data/config-backups'),files=fs.readdirSync(backupDir)
  assert.equal(files.length,1);assert.deepEqual(JSON.parse(fs.readFileSync(path.join(backupDir,files[0]),'utf8')),raw)
  const migrated=fs.readFileSync(file,'utf8');store.migrate();assert.equal(fs.readFileSync(file,'utf8'),migrated)
  assert.equal(store.wasLegacy,true)
  assert.equal(fs.readdirSync(backupDir).length,1);assert.equal(store.read().newsSources.length,1)
})

test('explicit source is retained during migration and new groups never inherit the old global API',t=>{
  const raw={dailyApi:'https://old.example.test/news',newsSources:[{botId:BOT,groupId:GROUP,url:'https://own.example.test/news',key:SECRET,authType:'bearer',authName:''}],groups:[{botId:BOT,groupId:GROUP}]}
  const {store}=fixture(t,raw);store.migrate()
  assert.equal(store.getNews(BOT,GROUP).url,'https://own.example.test/news')
  store.setGroup(BOT,GROUP2,g=>{g.enabled=true})
  assert.equal(store.getNews(BOT,GROUP2),null);assert.equal(store.getNews(BOT,GROUP).key,SECRET)
})

test('unknown legacy global source remains recoverable without becoming a wildcard fallback',t=>{
  const {store}=fixture(t,{dailyApi:'https://old.example.test/news',groups:[{groupId:GROUP,enabled:true}]})
  store.migrate();assert.equal(store.read().legacy.dailyApi,'https://old.example.test/news')
  assert.equal(store.getNews(BOT,GROUP),null);assert.equal(store.getNews(BOT2,GROUP),null)
})

test('invalid old values or unsupported versions leave original bytes untouched',t=>{
  for(const raw of [{dailyApi:'file:///secret',groups:[]},{timezone:'not-a-zone',groups:[]},{schemaVersion:99,groups:[]},{schemaVersion:null,groups:[]}]){
    const {store,file,root}=fixture(t,raw),before=fs.readFileSync(file,'utf8')
    assert.throws(()=>store.read());assert.throws(()=>store.migrate())
    assert.equal(fs.readFileSync(file,'utf8'),before);assert.equal(fs.existsSync(path.join(root,'data')),false)
  }
})

test('backup failure and failed validation cannot overwrite old config',t=>{
  const {store,file,root}=fixture(t,{dailyApi:'https://old.example.test/news',groups:[]}),before=fs.readFileSync(file,'utf8')
  assert.throws(()=>store.update(c=>{c.requestExpireMinutes=0}))
  assert.equal(fs.existsSync(path.join(root,'data')),false);assert.equal(fs.readFileSync(file,'utf8'),before)
  fs.writeFileSync(path.join(root,'data'),'synthetic obstruction')
  assert.throws(()=>store.migrate());assert.equal(fs.readFileSync(file,'utf8'),before)
})

test('atomic commit failure preserves original file and cleans task temporary file',t=>{
  const {store,file}=fixture(t),before=fs.readFileSync(file,'utf8'),rename=fs.renameSync
  try{
    fs.renameSync=(from,to)=>{if(to===file)throw new Error('synthetic rename failure');return rename(from,to)}
    assert.throws(()=>store.update(c=>{c.timezone='UTC'}),/synthetic/)
  }finally{fs.renameSync=rename}
  assert.equal(fs.readFileSync(file,'utf8'),before)
  assert.equal(fs.readdirSync(path.dirname(file)).some(x=>x.endsWith('.tmp')),false)
})

test('wildcard group editing copies only known non-sensitive settings and keeps exact precedence',t=>{
  const {store}=fixture(t)
  store.update(c=>{c.groups=[{...groupDefaults,groupId:GROUP,enabled:true,rankLimit:7,unknownKey:SECRET,news:{key:SECRET}}]})
  store.setGroup(BOT,GROUP,g=>{g.likes=true})
  const c=store.read(),exact=c.groups.find(g=>g.botId===BOT)
  assert.equal(exact.rankLimit,7);assert.equal('unknownKey'in exact,false);assert.equal('news'in exact,false)
  assert.equal(c.groups[0].unknownKey,SECRET);assert.equal(store.group(BOT2,GROUP).likes,false)
  assert.equal(store.group(BOT,GROUP).likes,true);assert.equal(store.getNews(BOT,GROUP),null)
})

test('editor contract preserves/replaces/clears Key without returning it',t=>{
  const {store,file}=fixture(t)
  const view=configured(store);assert.deepEqual(view,{url:'https://news.example.test/daily',authType:'bearer',authName:'',hasKey:true})
  store.setNews(BOT,GROUP,{url:'https://news.example.test/updated'})
  assert.equal(store.getNews(BOT,GROUP).key,SECRET)
  store.setNews(BOT,GROUP,{keyAction:'replace',key:'replacement-synthetic'})
  assert.equal(store.getNews(BOT,GROUP).key,'replacement-synthetic')
  const before=fs.readFileSync(file,'utf8')
  for(const patch of [{key:'****'},{keyAction:'replace',key:'****'},{keyAction:'replace',key:''},{botId:BOT2}])assert.throws(()=>store.setNews(BOT,GROUP,patch))
  assert.equal(fs.readFileSync(file,'utf8'),before)
  store.setNews(BOT,GROUP,{keyAction:'clear'})
  assert.equal(store.getNews(BOT,GROUP).key,'');assert.equal(store.getNewsForEditor(BOT,GROUP).hasKey,false)
  assert.equal(store.getNewsForEditor(BOT,GROUP).authType,'bearer')
})

test('source validation rejects protocols, userinfo, wildcard, duplicates and CRLF without exposing supplied secrets',t=>{
  const {store,file}=fixture(t);configured(store);const before=fs.readFileSync(file,'utf8')
  for(const patch of [{url:'file:///etc/passwd'},{url:'https://user:password@news.example.test/'},{url:'https://news.example.test/\r\nX: bad'},{authType:null},{authType:'header',authName:'X-Key\r\nInjected'},{authType:'query',authName:'a&b'},{keyAction:'replace',key:'do-not-echo\r\nsecret'}]){
    assert.throws(()=>store.setNews(BOT,GROUP,patch),error=>!error.message.includes('do-not-echo'))
    assert.equal(fs.readFileSync(file,'utf8'),before)
  }
  assert.throws(()=>store.update(c=>{c.newsSources[0].botId='*'}))
  assert.throws(()=>store.update(c=>c.newsSources.push({...c.newsSources[0]})))
  assert.throws(()=>store.update(c=>{c.groups=[{botId:BOT,groupId:GROUP,scheduledMute:true}]}))
  assert.throws(()=>validate({...store.read(),dailyApi:'https://old.example.test'}))
})

test('two robots and groups fetch only their own source and authentication',async t=>{
  const {store}=fixture(t)
  configured(store);configured(store,BOT,GROUP2,{url:'https://group2.example.test/news',key:'group2-only'})
  configured(store,BOT2,GROUP,{url:'https://bot2.example.test/news',key:'bot2-only'})
  const calls=[]
  const fetcher=async(url,options)=>{calls.push({url,options});return response({data:{news:['消息一','消息二']}})}
  for(const [bot,group]of [[BOT,GROUP],[BOT,GROUP2],[BOT2,GROUP]])assert.equal((await run(store,fetcher,bot,group))[0].data.text,'消息一\n消息二')
  assert.deepEqual(calls.map(c=>[new URL(c.url).hostname,c.options.headers.Authorization]),[
    ['news.example.test',`Bearer ${SECRET}`],['group2.example.test','Bearer group2-only'],['bot2.example.test','Bearer bot2-only']
  ])
  for(const c of calls){assert.equal(c.options.redirect,'error');assert.ok(c.options.signal instanceof AbortSignal)}
  await assert.rejects(run(store,fetcher,BOT2,GROUP2),/未配置.*尚待对接/);assert.equal(calls.length,3)
})

test('header/query/none authentication compose correctly and a cleared Key stops before requesting',async t=>{
  const {store}=fixture(t)
  configured(store,BOT,GROUP,{authType:'header',authName:'X-Api-Key'})
  await run(store,async(url,o)=>{assert.equal(o.headers['X-Api-Key'],SECRET);return response({text:'header'})})
  store.setNews(BOT,GROUP,{url:'https://news.example.test/daily?topic=test',authType:'query',authName:'api_key'})
  await run(store,async(url,o)=>{assert.equal(new URL(url).searchParams.get('api_key'),SECRET);assert.equal(new URL(url).searchParams.get('topic'),'test');assert.equal('Authorization'in o.headers,false);return response({text:'query'})})
  store.setNews(BOT,GROUP,{keyAction:'clear'});let calls=0
  await assert.rejects(run(store,async()=>{calls++;return response({text:'bad'})}),/Key 未配置/);assert.equal(calls,0)
  store.setNews(BOT,GROUP,{authType:'none',authName:''})
  await run(store,async(url,o)=>{assert.deepEqual(o.headers,{Accept:'application/json'});return response({text:'none'})})
  store.setNews(BOT,GROUP,{authType:'header',authName:'__proto__',keyAction:'replace',key:SECRET})
  await run(store,async(url,o)=>{assert.equal(Object.hasOwn(o.headers,'__proto__'),true);assert.equal(o.headers.__proto__,SECRET);return response({text:'header name'})})
})

test('news output validates image/JSON structures and limits text, including credential echoes',async t=>{
  const {store}=fixture(t);configured(store)
  const image=await run(store,async()=>response({data:{imageUrl:'https://cdn.example.test/image.jpg'}}))
  assert.deepEqual(image,[{type:'image',data:{file:'https://cdn.example.test/image.jpg'}}])
  const text=await run(store,async()=>response({data:{text:SECRET+' '+('字'.repeat(5000))}}))
  assert.equal(text[0].data.text.length,4000);assert.equal(text[0].data.text.includes(SECRET),false)
  for(const data of [null,[],{data:{news:[{}]}},{imageUrl:'javascript:alert(1)'},{imageUrl:`https://cdn.example.test/image?secret=${encodeURIComponent(SECRET)}`}])await assert.rejects(run(store,async()=>response(data)))
})

test('HTTP, JSON, network and timeout failures cannot disclose Keys or authenticated URLs',async t=>{
  const {store}=fixture(t);configured(store,BOT,GROUP,{authType:'query',authName:'api_key'})
  await assert.rejects(run(store,async()=>({ok:false,status:503})),/HTTP 503/)
  for(const fetcher of [
    async()=>{throw new Error(`request https://news.example.test/daily?api_key=${encodeURIComponent(SECRET)}; raw ${SECRET}`)},
    async()=>({ok:true,json:async()=>{throw new Error(`bad JSON ${SECRET}`)}})
  ])await assert.rejects(run(store,fetcher),e=>!e.message.includes(SECRET)&&!e.message.includes(encodeURIComponent(SECRET))&&!e.message.includes('https://'))
  await assert.rejects(run(store,async()=>{const e=new Error('synthetic');e.name='TimeoutError';throw e}),/超时/)
  const clean=redact(`API ${SECRET} https://news.example.test/?api_key=${encodeURIComponent(SECRET)}`,store.read())
  assert.equal(clean.includes(SECRET),false);assert.equal(clean.includes('https://'),false)
})
