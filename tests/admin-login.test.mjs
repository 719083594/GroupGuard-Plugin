import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import {ConfigStore} from '../lib/config.mjs'
import {createAdminServer} from '../lib/admin.mjs'
import {LoginTickets,adminPublicOrigin} from '../lib/admin-login.mjs'

const PUBLIC='https://panel.example.test',BOT='100000001',MASTER='300000002'
const PASSWORD='Synthetic-new-password-2026!'
async function fixture(t,{publicUrl=PUBLIC}={}){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'groupguard-login-'))
  fs.mkdirSync(path.join(root,'resources/admin'),{recursive:true})
  for(const name of ['index.html','app.js','style.css'])fs.writeFileSync(path.join(root,'resources/admin',name),name==='index.html'?'<!doctype html>GroupGuard':'synthetic')
  const store=new ConfigStore(root);store.update(c=>{c.masters=[MASTER]})
  let admin=await createAdminServer({root,store,publicUrl,port:0})
  t.after(async()=>{await admin.close();fs.rmSync(root,{recursive:true,force:true})})
  const request=(route,{method='GET',data,origin=PUBLIC,authority='panel.example.test',cookie='',csrf=''}={})=>new Promise((resolve,reject)=>{
    const headers={Host:authority,...cookie?{Cookie:cookie}:{}}
    let body
    if(method==='POST'){body=JSON.stringify(data||{});Object.assign(headers,{'Content-Type':'application/json','Content-Length':Buffer.byteLength(body),Origin:origin,...csrf?{'X-CSRF-Token':csrf}:{}})}
    const req=http.request({hostname:'127.0.0.1',port:admin.address.port,path:route,method,headers},res=>{
      const chunks=[];res.on('data',c=>chunks.push(c));res.on('end',()=>{const raw=Buffer.concat(chunks).toString();let json;try{json=JSON.parse(raw)}catch{}resolve({status:res.statusCode,json,headers:res.headers,raw})})
    });req.on('error',reject);req.end(body)
  })
  const authorize=()=>store.read().masters.includes(MASTER)
  const link=()=>admin.createLoginLink({principal:BOT+':'+MASTER,authorize})
  const consume=async url=>{
    const ticket=new URL(url).hash.slice(7)
    const r=await request('/api/login-ticket',{method:'POST',data:{ticket}})
    return {...r,ticket,cookie:r.headers['set-cookie']?.[0]?.split(';')[0]||'',csrf:r.json?.csrf||''}
  }
  return {root,store,request,link,consume,get admin(){return admin},async restart(){await admin.close();admin=await createAdminServer({root,store,publicUrl,port:0})}}
}

test('链接存储仅保留哈希，3分钟过期、一次有效、新链接替换同主人旧链接',()=>{
  let now=0;const tickets=new LoginTickets({now:()=>now}),options={principal:'synthetic-owner',authorize:()=>true,authStamp:{}}
  const first=tickets.issue(options);assert(!tickets.values.has(first));assert(!JSON.stringify([...tickets.values]).includes(first))
  const second=tickets.issue(options);assert.equal(tickets.take(first),null);assert.equal(tickets.take(second).principal,options.principal);assert.equal(tickets.take(second),null)
  const expired=tickets.issue(options);now=180000;assert.equal(tickets.take(expired),null)
  assert.equal(tickets.take('invalid'),null);tickets.clear();assert.equal(tickets.values.size,0)
})

test('公网地址限完整HTTPS源，回环HTTP仅供本机，拒绝路径、密码和未配置入口',async t=>{
  assert.equal(adminPublicOrigin(PUBLIC),PUBLIC)
  assert.equal(adminPublicOrigin('http://127.0.0.1:36083/'),'http://127.0.0.1:36083')
  for(const v of ['http://panel.example.test','https://user:secret@panel.example.test','https://panel.example.test/admin','https://panel.example.test/?ticket=secret'])assert.throws(()=>adminPublicOrigin(v))
  const f=await fixture(t,{publicUrl:''});await assert.rejects(f.link(),/PUBLIC_URL/)
})

test('QQ链接不含密码，预览GET不消费凭据，交换后使用Secure会话并保留密码登录',async t=>{
  const f=await fixture(t),initial=fs.readFileSync(path.join(f.root,'data/admin-initial-password.txt'),'utf8').trim()
  const url=await f.link();assert(url.startsWith(PUBLIC+'/#login='));assert(!url.includes(initial));assert.equal(new URL(url).search,'')
  assert.equal((await f.request('/')).status,200)
  assert.equal((await f.request('/api/session')).json.authenticated,false)
  const login=await f.consume(url);assert.equal(login.status,200);assert.match(login.headers['set-cookie'][0],/HttpOnly; SameSite=Strict.*Secure/)
  assert.equal(login.json.mustChangePassword,true);assert.equal(login.json.canSetInitialPassword,true)
  assert.equal((await f.request('/api/config',{cookie:login.cookie})).status,403)
  const changed=await f.request('/api/password',{method:'POST',cookie:login.cookie,csrf:login.csrf,data:{currentPassword:'',newPassword:PASSWORD}})
  assert.equal(changed.status,200);assert(!fs.existsSync(path.join(f.root,'data/admin-initial-password.txt')))
  assert.equal((await f.consume(url)).status,401)
  const password=await f.request('/api/login',{method:'POST',data:{password:PASSWORD}});assert.equal(password.status,200)
  const next=await f.consume(await f.link());assert.equal(next.status,200);assert.equal(next.json.mustChangePassword,false)
  assert.equal((await f.request('/api/config',{cookie:next.cookie})).status,200)
  assert.equal((await f.request('/api/password',{method:'POST',cookie:next.cookie,csrf:next.csrf,data:{currentPassword:'wrong',newPassword:'Synthetic-other-password-2026!'}})).status,401)
})

test('同一链接并发交换只有一个成功，重新获取、改密和服务重启使未用链接失效',async t=>{
  const f=await fixture(t),old=await f.link(),latest=await f.link()
  assert.equal((await f.consume(old)).status,401)
  const pair=await Promise.all([f.consume(latest),f.consume(latest)]);assert.deepEqual(pair.map(r=>r.status).sort(),[200,401])
  const login=pair.find(r=>r.status===200),pending=await f.link()
  assert.equal((await f.request('/api/password',{method:'POST',cookie:login.cookie,csrf:login.csrf,data:{newPassword:PASSWORD}})).status,200)
  assert.equal((await f.consume(pending)).status,401)
  const beforeRestart=await f.link();await f.restart();assert.equal((await f.consume(beforeRestart)).status,401)
})

test('主人权限变化会拒绝发链接、拒绝兑换并清除已登录QQ会话',async t=>{
  const f=await fixture(t),first=await f.link()
  f.store.update(c=>{c.masters=[]});assert.equal((await f.consume(first)).status,401);await assert.rejects(f.link(),/主人/)
  f.store.update(c=>{c.masters=[MASTER]});const login=await f.consume(await f.link());assert.equal(login.status,200)
  f.store.update(c=>{c.masters=[]});assert.equal((await f.request('/api/session',{cookie:login.cookie})).json.authenticated,false)
})

test('兑换要求同源，恶意Host和跨源请求不能消费链接或伪造会话',async t=>{
  const f=await fixture(t),url=await f.link(),ticket=new URL(url).hash.slice(7)
  assert.equal((await f.request('/api/login-ticket',{method:'POST',origin:'https://evil.example',data:{ticket}})).status,403)
  assert.equal((await f.request('/api/login-ticket',{method:'POST',origin:'https://evil.example',authority:'evil.example',data:{ticket}})).status,403)
  assert.equal((await f.request('/api/login-ticket',{method:'POST',data:{ticket,password:'injected'}})).status,400)
  assert.equal((await f.consume(url)).status,200)
  assert.equal((await f.request('/api/login-ticket',{method:'GET'})).status,405)
})

test('请求等待正文期间撤销主人权限，不能继续提交配置写入',async t=>{
  const f=await fixture(t),first=await f.consume(await f.link())
  await f.request('/api/password',{method:'POST',cookie:first.cookie,csrf:first.csrf,data:{newPassword:PASSWORD}})
  const login=await f.consume(await f.link()),config=await f.request('/api/config',{cookie:login.cookie})
  const payload=JSON.stringify({revision:config.json.revision,patch:{inviteMode:'accept'}})
  const read=f.store.read.bind(f.store);let observed
  const checked=new Promise(r=>{observed=r})
  f.store.read=()=>{const value=read();if(observed){observed();observed=null}return value}
  let req
  const result=new Promise((resolve,reject)=>{
    req=http.request({hostname:'127.0.0.1',port:f.admin.address.port,path:'/api/config/global',method:'POST',headers:{Host:'panel.example.test',Origin:PUBLIC,Cookie:login.cookie,'X-CSRF-Token':login.csrf,'Content-Type':'application/json','Content-Length':Buffer.byteLength(payload)}},res=>{res.resume();res.on('end',()=>resolve(res.statusCode))});req.on('error',reject)
  })
  req.write(payload.slice(0,1));await checked
  f.store.update(c=>{c.masters=[]});req.end(payload.slice(1))
  assert.equal(await result,401);assert.equal(read().inviteMode,'off')
})
