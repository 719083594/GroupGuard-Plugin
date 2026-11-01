import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import {ConfigStore} from '../lib/config.mjs'
import {createAdminServer} from '../lib/admin.mjs'

const BOT='100000001',BOT2='100000002',GROUP='200000001'
const PASSWORD='Synthetic-local-test-password-2026!'
const KEY='synthetic-news-key-do-not-print'
function rootFor(t){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'groupguard-admin-'))
  fs.mkdirSync(path.join(root,'resources/admin'),{recursive:true})
  for(const [file,value]of [['index.html','<!doctype html><script src="/app.js"></script>'],['app.js','document.title="synthetic"'],['style.css','body{color:black}']])fs.writeFileSync(path.join(root,'resources/admin',file),value)
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}))
  return root
}
async function fixture(t,{authenticate=true,host='127.0.0.1'}={}){
  const root=rootFor(t),store=new ConfigStore(root),errors=[]
  const options={root,store,host,port:0,engine:{adapters:new Map([[BOT,{}]])},onError:e=>errors.push(e)}
  let admin=await createAdminServer(options)
  t.after(async()=>{await admin.close()})
  let cookie='',csrf=''
  const request=(route,{method='GET',data,raw,headers={},auth=true,origin,hostHeader,chunked=false}={})=>new Promise((resolve,reject)=>{
    const authority=hostHeader??'127.0.0.1:'+admin.address.port
    const h={Host:authority,...headers}
    if(auth&&cookie)h.Cookie=cookie
    if(method==='POST'){
      h.Origin=origin===undefined?'http://'+authority:origin
      if(origin===null)delete h.Origin
      if(csrf&&auth)h['X-CSRF-Token']=csrf
      if(!Object.hasOwn(h,'Content-Type'))h['Content-Type']='application/json'
    }
    const payload=raw!==undefined?raw:data!==undefined?JSON.stringify(data):undefined
    if(payload!==undefined&&!chunked)h['Content-Length']=Buffer.byteLength(payload)
    if(chunked)h['Transfer-Encoding']='chunked'
    const req=http.request({hostname:'127.0.0.1',port:admin.address.port,path:route,method,headers:h},res=>{
      const chunks=[];res.on('data',x=>chunks.push(x));res.on('end',()=>{
        const text=Buffer.concat(chunks).toString('utf8');let json
        try{json=JSON.parse(text)}catch{}
        resolve({status:res.statusCode,headers:res.headers,text,json})
      })
    });req.on('error',reject);if(payload!==undefined)req.write(payload);req.end()
  })
  const login=async(password=PASSWORD,extra={})=>{
    const r=await request('/api/login',{method:'POST',data:{password},auth:false,...extra})
    if(r.status===200){cookie=r.headers['set-cookie'][0].split(';')[0];csrf=r.json.csrf}
    return r
  }
  const f={root,store,errors,request,login,get admin(){return admin},get cookie(){return cookie},get csrf(){return csrf},setSession(c,s){cookie=c;csrf=s},
    async config(){const r=await request('/api/config');assert.equal(r.status,200,r.text);return r.json},
    async restart(){await admin.close();admin=await createAdminServer(options)}}
  if(authenticate){
    const initial=fs.readFileSync(path.join(root,'data/admin-initial-password.txt'),'utf8').trim()
    assert.equal((await login(initial)).status,200)
    const changed=await request('/api/password',{method:'POST',data:{currentPassword:initial,newPassword:PASSWORD}})
    assert.equal(changed.status,200,changed.text);assert.equal((await login()).status,200)
  }
  return f
}

test('random bootstrap password is private, hashed, never returned, and must be changed',async t=>{
  const f=await fixture(t,{authenticate:false})
  const initialFile=path.join(f.root,'data/admin-initial-password.txt'),authFile=path.join(f.root,'data/admin-auth.json')
  const initial=fs.readFileSync(initialFile,'utf8').trim(),auth=fs.readFileSync(authFile,'utf8')
  assert.match(initial,/^[A-Za-z0-9_-]{43}$/);assert.equal(auth.includes(initial),false)
  assert.equal((await f.request('/api/config')).status,401)
  assert.deepEqual((await f.request('/api/session')).json,{authenticated:false})
  const login=await f.login(initial)
  assert.equal(login.json.mustChangePassword,true);assert.equal(login.text.includes(initial),false)
  assert.match(login.headers['set-cookie'][0],/HttpOnly/);assert.match(login.headers['set-cookie'][0],/SameSite=Strict/)
  assert.equal((await f.request('/api/config')).json.code,'PASSWORD_CHANGE_REQUIRED')
  if(process.platform!=='win32'){
    assert.equal(fs.statSync(initialFile).mode&0o777,0o600);assert.equal(fs.statSync(authFile).mode&0o777,0o600)
  }
  assert.equal(f.errors.join('').includes(initial),false)
})

test('password change removes bootstrap plaintext, invalidates every session and survives restart',async t=>{
  const f=await fixture(t),firstCookie=f.cookie,firstCsrf=f.csrf
  await f.login();const secondCookie=f.cookie,secondCsrf=f.csrf
  f.setSession(firstCookie,firstCsrf)
  const next='Second-synthetic-test-password-2026!'
  const change=await f.request('/api/password',{method:'POST',data:{currentPassword:PASSWORD,newPassword:next}})
  assert.equal(change.status,200);assert.equal(change.json.loginRequired,true)
  assert.equal(fs.existsSync(path.join(f.root,'data/admin-initial-password.txt')),false)
  assert.equal((await f.request('/api/config')).status,401)
  f.setSession(secondCookie,secondCsrf);assert.equal((await f.request('/api/config')).status,401)
  assert.equal((await f.login(PASSWORD)).status,401)
  assert.equal((await f.login(next)).json.mustChangePassword,false)
  await f.restart();assert.equal((await f.request('/api/session')).json.authenticated,false)
  assert.equal((await f.login(next)).status,200)
})

test('logout and absolute session timeout invalidate CSRF credentials',async t=>{
  const f=await fixture(t)
  assert.equal((await f.request('/api/logout',{method:'POST',data:{}})).status,200)
  assert.equal((await f.request('/api/config')).status,401)
  await f.login();const realNow=Date.now
  try{
    Date.now=()=>realNow()+31*60*1000
    assert.equal((await f.request('/api/session')).json.authenticated,false)
    assert.equal((await f.request('/api/logout',{method:'POST',data:{}})).status,401)
  }finally{Date.now=realNow}
})

test('logout invalidates a mutation that was waiting for its request body',async t=>{
  const f=await fixture(t),c=await f.config(),authority='127.0.0.1:'+f.admin.address.port
  let arrived,request
  const ready=new Promise(resolve=>{arrived=resolve})
  const observe=req=>{if(req.url==='/api/config/global')arrived()}
  f.admin.server.on('request',observe)
  const finished=new Promise((resolve,reject)=>{
    request=http.request({hostname:'127.0.0.1',port:f.admin.address.port,path:'/api/config/global',method:'POST',headers:{Host:authority,Origin:'http://'+authority,Cookie:f.cookie,'X-CSRF-Token':f.csrf,'Content-Type':'application/json','Transfer-Encoding':'chunked'}},res=>{
      res.resume();res.on('end',()=>resolve(res.statusCode))
    });request.on('error',reject);request.write('{"revision":"'+c.revision+'","patch":')
  })
  await ready
  assert.equal((await f.request('/api/logout',{method:'POST',data:{}})).status,200)
  request.end('{"inviteMode":"accept"}}')
  assert.equal(await finished,401);assert.equal(f.store.read().inviteMode,'off')
  f.admin.server.off('request',observe)
})

test('login is rate limited by socket identity, not spoofed forwarded headers',async t=>{
  const f=await fixture(t,{authenticate:false})
  for(let i=0;i<5;i++)assert.equal((await f.login('Wrong-synthetic-password-'+i,{headers:{'X-Forwarded-For':String(i)}})).status,401)
  const limited=await f.login('Wrong-synthetic-password-again')
  assert.equal(limited.status,429);assert.equal(limited.json.code,'LOGIN_RATE_LIMIT');assert.ok(limited.headers['retry-after'])
})

test('Host DNS rebinding and cross-origin mutations are rejected, including missing Origin',async t=>{
  const f=await fixture(t),c=await f.config(),data={revision:c.revision,patch:{inviteMode:'manual'}}
  for(const hostHeader of ['attacker.example:15083','127.0.0.1.evil:15083','localhost.evil:15083','0.0.0.0:15083','127.1:15083','127.0.0.1:99999'])assert.equal((await f.request('/api/session',{hostHeader})).status,403)
  for(const origin of ['http://attacker.example','null',null])assert.equal((await f.request('/api/config/global',{method:'POST',data,origin})).status,403)
  const wrong=f.csrf;f.setSession(f.cookie,'invalid-token')
  assert.equal((await f.request('/api/config/global',{method:'POST',data})).json.code,'INVALID_CSRF')
  f.setSession(f.cookie,wrong)
  assert.equal(f.store.read().inviteMode,'off')
})

test('loopback tunnel Host/Origin ports may differ from the internal listening port',async t=>{
  const f=await fixture(t,{authenticate:false,host:'0.0.0.0'})
  const initial=fs.readFileSync(path.join(f.root,'data/admin-initial-password.txt'),'utf8').trim()
  const hostHeader='127.0.0.1:36083'
  assert.equal((await f.login(initial,{hostHeader,origin:'http://127.0.0.1:36083'})).status,200)
  assert.equal((await f.request('/api/logout',{method:'POST',data:{},hostHeader,origin:'http://127.0.0.1:36083'})).status,200)
  assert.equal((await f.login(initial,{hostHeader,origin:'http://127.0.0.1:'+f.admin.address.port})).status,403)
})

test('all responses have no-store/CSP/frame protections and static files use an exact allowlist',async t=>{
  const f=await fixture(t,{authenticate:false})
  for(const route of ['/','/index.html','/app.js','/style.css']){
    const r=await f.request(route);assert.equal(r.status,200)
    assert.equal(r.headers['cache-control'],'no-store');assert.equal(r.headers['x-frame-options'],'DENY')
    assert.equal(r.headers['x-content-type-options'],'nosniff');assert.ok(r.headers['content-security-policy'].includes("script-src 'self'"))
    assert.equal(r.headers['content-security-policy'].includes('unsafe-inline'),false)
  }
  for(const route of ['/data/admin-initial-password.txt','/config/local.json','/../data/admin-auth.json','/%2e%2e/data/admin-auth.json','/app.js/../config/local.json'])assert.equal((await f.request(route)).status,404)
})

test('cross-site top-level browser navigation may load public static assets while APIs remain same-origin',async t=>{
  const f=await fixture(t,{authenticate:false})
  const headers={'Sec-Fetch-Site':'cross-site','Sec-Fetch-Mode':'navigate','Sec-Fetch-Dest':'document'}
  assert.equal((await f.request('/',{headers})).status,200)
  assert.equal((await f.request('/index.html',{headers:{...headers,Origin:'https://external-navigation.example'}})).status,200)
  for(const route of ['/app.js','/style.css'])assert.equal((await f.request(route,{headers:{'Sec-Fetch-Site':'cross-site'}})).status,200)
  assert.equal((await f.request('/api/session',{headers})).status,403)
  assert.equal((await f.request('/api/config',{headers})).status,403)
  assert.equal((await f.request('/api/login',{method:'POST',data:{password:'Synthetic-password'},headers})).status,403)
})

test('JSON media type, invalid JSON and both declared/chunked bodies over 1 MiB are rejected without leaking input',async t=>{
  const f=await fixture(t)
  assert.equal((await f.request('/api/logout',{method:'POST',raw:'{}',headers:{'Content-Type':'text/plain'}})).status,415)
  const invalid=await f.request('/api/logout',{method:'POST',raw:'{"secret":"'+KEY})
  assert.equal(invalid.status,400);assert.equal(invalid.text.includes(KEY),false)
  for(const chunked of [false,true]){
    const large=await f.request('/api/logout',{method:'POST',raw:JSON.stringify({secret:'x'.repeat(1024*1024)}),chunked})
    assert.equal(large.status,413,large.text);assert.match(large.json.error,/1 MiB/)
  }
})

test('config view hides masters, legacy and all raw Keys but includes safe schemas and available robots',async t=>{
  const f=await fixture(t)
  f.store.update(c=>{c.masters=['300000001'];c.legacy={dailyApi:'https://secret.example/?key='+KEY};c.privateUnknown=KEY;c.groups=[{botId:BOT,groupId:GROUP,unknownSecret:KEY}]})
  f.store.setNews(BOT,GROUP,{url:'https://news.example/?token=editable-synthetic-url-token',authType:'bearer',keyAction:'replace',key:KEY})
  const c=await f.config()
  assert.deepEqual(c.availableBots,[BOT]);assert.equal(c.readonly.mastersConfigured,true)
  assert.equal(JSON.stringify(c).includes(KEY),false);assert.equal(JSON.stringify(c).includes('300000001'),false)
  assert.equal(c.newsSources[0].hasKey,true);assert.equal(Object.hasOwn(c.newsSources[0],'key'),false)
  assert.ok(c.newsSources[0].url.includes('editable-synthetic-url-token'))
  assert.ok(c.schema.groupFields.includes('enabled'));assert.equal(c.schema.globalFields.includes('masters'),false)
})

test('global and group CRUD use optimistic revision and preserve unrelated settings',async t=>{
  const f=await fixture(t);let c=await f.config(),old=c.revision
  let r=await f.request('/api/config/global',{method:'POST',data:{revision:c.revision,patch:{inviteMode:'manual',timezone:'UTC'}}})
  assert.equal(r.status,200);c=r.json;assert.notEqual(c.revision,old)
  r=await f.request('/api/config/group',{method:'POST',data:{revision:old,botId:BOT,groupId:GROUP,patch:{enabled:true}}})
  assert.equal(r.status,409);assert.equal(f.store.read().groups.length,0)
  r=await f.request('/api/config/group',{method:'POST',data:{revision:c.revision,botId:BOT,groupId:GROUP,patch:{enabled:true,joinMode:'manual',rankLimit:12}}})
  assert.equal(r.status,200);c=r.json;assert.equal(c.groups[0].rankLimit,12);assert.equal(c.global.inviteMode,'manual')
  r=await f.request('/api/config/group',{method:'POST',data:{revision:c.revision,botId:BOT,groupId:GROUP,patch:{enabled:false}}})
  assert.equal(r.status,200);c=r.json;assert.equal(c.groups[0].enabled,false);assert.equal(c.groups[0].rankLimit,12)
  r=await f.request('/api/config/group/remove',{method:'POST',data:{revision:c.revision,botId:BOT,groupId:GROUP}})
  assert.equal(r.status,200);assert.equal(r.json.groups.length,0)
})

test('legal full-size global/group lists save over HTTP while the 5000-ID field limit remains enforced',async t=>{
  const f=await fixture(t),ids=Array.from({length:5000},(_,i)=>String(1000000000000000+i))
  let c=await f.config()
  const patch={...c.global,managementGroups:ids,notifyUsers:ids,blackGroups:ids,whiteGroups:ids}
  assert.ok(Buffer.byteLength(JSON.stringify(patch))>64*1024)
  let r=await f.request('/api/config/global',{method:'POST',data:{revision:c.revision,patch}})
  assert.equal(r.status,200,r.text);c=r.json
  for(const field of ['managementGroups','notifyUsers','blackGroups','whiteGroups'])assert.equal(c.global[field].length,5000)
  const answers=Array.from({length:100},(_,i)=>String(i).padStart(3,'0')+'答'.repeat(197))
  const group={enabled:true,blackUsers:ids,whiteUsers:ids,joinMode:'answer',answers}
  assert.ok(Buffer.byteLength(JSON.stringify(group))>64*1024)
  r=await f.request('/api/config/group',{method:'POST',data:{revision:c.revision,botId:BOT,groupId:GROUP,patch:group}})
  assert.equal(r.status,200,r.text);c=r.json
  assert.equal(c.groups[0].blackUsers.length,5000);assert.equal(c.groups[0].whiteUsers.length,5000)
  assert.deepEqual(c.groups[0].answers,answers)
  for(const route of ['/api/config/global','/api/config/group']){
    const data=route.endsWith('/global')?{revision:c.revision,patch:{notifyUsers:[...ids,'1000000000005000']}}:{revision:c.revision,botId:BOT,groupId:GROUP,patch:{blackUsers:[...ids,'1000000000005000']}}
    r=await f.request(route,{method:'POST',data});assert.equal(r.status,400);assert.equal(r.json.code,'INVALID_CONFIG')
  }
  assert.equal(f.store.read().notifyUsers.length,5000);assert.equal(f.store.group(BOT,GROUP).blackUsers.length,5000)
})

test('news CRUD keeps/replaces/clears Key without echoing it and group removal is scoped',async t=>{
  const f=await fixture(t);let c=await f.config()
  const save=async(route,payload)=>{const r=await f.request(route,{method:'POST',data:{revision:c.revision,...payload}});assert.equal(r.status,200,r.text);c=r.json;assert.equal(r.text.includes(KEY),false);return r}
  await save('/api/config/group',{botId:BOT,groupId:GROUP,patch:{enabled:true}})
  await save('/api/config/news',{botId:BOT,groupId:GROUP,patch:{url:'https://news.example/',authType:'bearer',keyAction:'replace',key:KEY}})
  assert.equal(c.newsSources[0].hasKey,true)
  await save('/api/config/news',{botId:BOT,groupId:GROUP,patch:{url:'https://news.example/changed'}})
  assert.equal(f.store.getNews(BOT,GROUP).key,KEY)
  await save('/api/config/news',{botId:BOT,groupId:GROUP,patch:{keyAction:'replace',key:'replacement-synthetic-key'}})
  assert.equal(f.store.getNews(BOT,GROUP).key,'replacement-synthetic-key')
  await save('/api/config/news',{botId:BOT,groupId:GROUP,patch:{keyAction:'clear'}})
  assert.equal(c.newsSources[0].hasKey,false)
  await save('/api/config/news',{botId:BOT2,groupId:GROUP,patch:{url:'https://other.example/'}})
  await save('/api/config/group/remove',{botId:BOT,groupId:GROUP})
  assert.equal(f.store.getNews(BOT,GROUP),null);assert.ok(f.store.getNews(BOT2,GROUP))
  await save('/api/config/news/remove',{botId:BOT2,groupId:GROUP})
  assert.equal(c.newsSources.length,0)
})

test('creating a concrete account group inherits wildcard settings without changing its arrays or unrelated new-group defaults',async t=>{
  const f=await fixture(t);let c=await f.config()
  const save=async(botId,groupId,patch)=>{
    const r=await f.request('/api/config/group',{method:'POST',data:{revision:c.revision,botId,groupId,patch}})
    assert.equal(r.status,200,r.text);c=r.json
  }
  await save('*',GROUP,{enabled:true,recall:false,rankLimit:23,joinMode:'answer',answers:['wildcard answer'],blackUsers:['400000001'],whiteUsers:['400000002']})
  await save(BOT,GROUP,{welcomeMessage:'account-specific welcome'})
  let config=f.store.read(),wildcard=config.groups.find(g=>g.botId==='*'),exact=config.groups.find(g=>g.botId===BOT)
  for(const key of ['enabled','recall','rankLimit','joinMode','answers','blackUsers','whiteUsers'])assert.deepEqual(exact[key],wildcard[key],key)
  assert.equal(exact.welcomeMessage,'account-specific welcome')
  assert.notEqual(exact.answers,wildcard.answers);assert.notEqual(exact.blackUsers,wildcard.blackUsers);assert.notEqual(exact.whiteUsers,wildcard.whiteUsers)
  await save(BOT,GROUP,{answers:['specific answer'],blackUsers:['400000003'],whiteUsers:[]})
  config=f.store.read();wildcard=config.groups.find(g=>g.botId==='*')
  assert.deepEqual(wildcard.answers,['wildcard answer']);assert.deepEqual(wildcard.blackUsers,['400000001']);assert.deepEqual(wildcard.whiteUsers,['400000002'])
  await save(BOT,'200000002',{welcomeMessage:'independent group'})
  const independent=f.store.group(BOT,'200000002')
  assert.equal(independent.enabled,false);assert.equal(independent.recall,true);assert.equal(independent.rankLimit,10)
  assert.equal(independent.joinMode,'off');assert.deepEqual(independent.answers,[]);assert.deepEqual(independent.blackUsers,[])
})

test('protected and unknown raw fields cannot bypass global/group/news write contracts',async t=>{
  const f=await fixture(t),c=await f.config(),file=path.join(f.root,'config/local.json'),before=fs.readFileSync(file,'utf8')
  for(const field of ['masters','schemaVersion','legacy','groups','newsSources','dailyApi','__proto__']){
    const patch=JSON.parse('{"'+field+'":"'+KEY+'"}')
    const r=await f.request('/api/config/global',{method:'POST',data:{revision:c.revision,patch}})
    assert.equal(r.status,400);assert.equal(r.text.includes(KEY),false)
  }
  for(const field of ['masters','botId','groupId','newsSources','dailyApi','scheduledMute','unknownRawSecret']){
    const r=await f.request('/api/config/group',{method:'POST',data:{revision:c.revision,botId:BOT,groupId:GROUP,patch:{[field]:KEY}}})
    assert.equal(r.status,400);assert.equal(r.text.includes(KEY),false)
  }
  const invalid=await f.request('/api/config/news',{method:'POST',data:{revision:c.revision,botId:'*',groupId:GROUP,patch:{url:'https://news.example/',keyAction:'replace',key:KEY}}})
  assert.equal(invalid.status,400);assert.equal(invalid.text.includes(KEY),false)
  assert.equal(fs.readFileSync(file,'utf8'),before);assert.equal(f.errors.join('').includes(KEY),false)
})

test('external/manual config changes cause conflict rather than overwriting a newer file',async t=>{
  const f=await fixture(t),c=await f.config()
  f.store.update(x=>{x.masters=['300000001'];x.autoQuitMessage='manually changed'})
  const r=await f.request('/api/config/global',{method:'POST',data:{revision:c.revision,patch:{inviteMode:'accept'}}})
  assert.equal(r.status,409);assert.equal(r.json.code,'REVISION_CONFLICT')
  assert.equal(f.store.read().inviteMode,'off');assert.equal(f.store.read().autoQuitMessage,'manually changed')
})

test('invalid auth persistence fails closed and leaves original credentials untouched',async t=>{
  const root=rootFor(t),store=new ConfigStore(root),directory=path.join(root,'data')
  fs.mkdirSync(directory,{recursive:true});const file=path.join(directory,'admin-auth.json'),original='{"version":99,"retain":"synthetic"}\n'
  fs.writeFileSync(file,original)
  await assert.rejects(createAdminServer({root,store,port:0}),/认证文件无效/)
  assert.equal(fs.readFileSync(file,'utf8'),original);assert.equal(fs.existsSync(path.join(directory,'admin-initial-password.txt')),false)
})
