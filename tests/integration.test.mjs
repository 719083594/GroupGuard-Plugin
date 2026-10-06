import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import {spawn} from 'node:child_process'
import {createHmac} from 'node:crypto'
import {fileURLToPath} from 'node:url'
const source=fileURLToPath(new URL('..',import.meta.url))
const wait=async fn=>{for(let n=0;n<50;n++){if(await fn())return;await new Promise(r=>setTimeout(r,40))}throw new Error('timed out')}

test('独立服务实测：HMAC、白名单账号、伪造主人拒绝、HTTP API 与帮助路由',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'groupguard-http-')),calls=[]
  for(const name of ['standalone.mjs','lib','config','CHANGELOG.md','package.json'])fs.cpSync(path.join(source,name),path.join(root,name),{recursive:true})
  const api=http.createServer(async(req,res)=>{let raw='';for await(const c of req)raw+=c;calls.push({action:req.url.slice(1),params:JSON.parse(raw)});res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({status:'ok',retcode:0,data:{message_id:23}}))})
  await new Promise(r=>api.listen(0,'127.0.0.1',r))
  const reservation=http.createServer();await new Promise(r=>reservation.listen(0,'127.0.0.1',r));const port=reservation.address().port;await new Promise(r=>reservation.close(r))
  fs.writeFileSync(path.join(root,'config/standalone.json'),JSON.stringify({host:'127.0.0.1',port,bots:[{botId:'100000001',apiUrl:`http://127.0.0.1:${api.address().port}`}]}))
  const child=spawn(process.execPath,[path.join(root,'standalone.mjs')],{env:{...process.env,GROUPGUARD_EVENT_SECRET:'test-secret',GROUPGUARD_API_TOKEN:''},stdio:['ignore','pipe','pipe']})
  let output='';child.stdout.on('data',x=>output+=x);child.stderr.on('data',x=>output+=x)
  t.after(async()=>{const ended=new Promise(r=>child.once('exit',r));child.kill();await ended;await new Promise(r=>api.close(r));fs.rmSync(root,{recursive:true,force:true})})
  const url=`http://127.0.0.1:${port}`
  await wait(async()=>{try{return (await fetch(url+'/healthz')).ok}catch{return false}})
  assert.equal((await (await fetch(url+'/healthz')).json()).ok,true)
  const event={self_id:100000001,user_id:123456789,group_id:200000001,post_type:'message',message:[{type:'text',data:{text:'#群管帮助'}}]}
  const post=async(e,valid=true)=>{const body=JSON.stringify(e);return fetch(url+'/onebot',{method:'POST',headers:{'X-Signature':valid?'sha1='+createHmac('sha1','test-secret').update(body).digest('hex'):'invalid'},body})}
  assert.equal((await post(event,false)).status,401);assert.equal((await post({...event,self_id:99999999})).status,403);assert.equal(calls.length,0)
  assert.equal((await post(event)).status,200);await wait(()=>calls.length>0);assert.equal(calls[0].action,'send_group_msg');assert.match(calls[0].params.message[0].data.text,/群卫/)
  await new Promise(r=>setTimeout(r,1100))
  assert.equal((await post({...event,group_id:undefined,isMaster:true,message:[{type:'text',data:{text:'#群管全局 inviteMode accept'}}]})).status,200)
  await wait(()=>calls.length>1);assert.match(calls.at(-1).params.message[0].data.text,/主人权限/);assert.equal(JSON.parse(fs.readFileSync(path.join(root,'config/local.json'))).inviteMode,'off')
  assert.equal(output.includes('已启动'),true)
})

test('分发规则覆盖帮助、群操作、兼容审核，OrangeJuice 文档没有暴露主人指令',async t=>{
  const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'groupguard-yunzai-'))
  fs.mkdirSync(path.join(temporary,'GroupGuard-Plugin'))
  for(const name of ['lib','config','index.js','package.json','orangejuice.plugin.json'])fs.cpSync(path.join(source,name),path.join(temporary,'GroupGuard-Plugin',name),{recursive:true})
  globalThis.plugin=class {constructor(options){Object.assign(this,options)}}
  const entry=await import(new URL('file:///'+path.join(temporary,'GroupGuard-Plugin/index.js').replaceAll('\\','/')))
  t.after(()=>{entry.engine.close();delete globalThis.plugin;fs.rmSync(temporary,{recursive:true,force:true})})
  const p=new entry.GroupGuardCommands()
  for(const cmd of ['#群管帮助','#群管设置 likes 开','#群管禁言 123456789 10分钟','#群管全局 inviteMode manual','#确认加群'])assert.equal(p.rule.some(r=>r.reg.test(cmd)),true,cmd)
  if(!fs.existsSync(path.join(source,'../OrangeJuice-Plugin/integrations/yunzai/command-table.mjs'))){t.diagnostic('独立仓库未附带 OrangeJuice，跳过外部指令表集成断言');return}
  const {buildCommandTable}=await import('../../OrangeJuice-Plugin/integrations/yunzai/command-table.mjs')
  const loader={priority:[{key:'GroupGuard-Plugin/index.js',plugin:p}]}
  const table=buildCommandTable(loader,{isGroup:true,group_id:'200000001'},{pluginsRoot:temporary})
  assert.equal(table.rows.filter(x=>x.directory==='GroupGuard-Plugin').length,9)
  assert.equal(table.rows.some(x=>x.permission==='master'),false)
  assert.equal(table.unparsed,0)
  const full=buildCommandTable(loader,{isMaster:true},{pluginsRoot:temporary})
  assert.equal(full.rows.filter(x=>x.directory==='GroupGuard-Plugin').length,10)
})
