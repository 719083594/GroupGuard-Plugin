import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {GroupGuard,version} from '../lib/core.mjs'
import {OneBotAdapter} from '../lib/adapter.mjs'
import {buildStatusSnapshot,buildStatusText,buildStatusHtml} from '../lib/status-view.mjs'
import {isStatusImage,renderStatusImage} from '../lib/features/status.mjs'

const BOT='100000001',GROUP='200000001',ADMIN='300000001',MASTER='300000002'
const SECRET='synthetic-status-news-key-do-not-print'
const API_URL='https://synthetic-status-news.example.test/?key=synthetic-url-key'
const PNG=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jq1kAAAAASUVORK5CYII=','base64')
const JPEG=fs.readFileSync(new URL('../resources/help/groupguard-public-1.jpg',import.meta.url))
const ok=data=>({status:'ok',retcode:0,data})
const text=p=>(p.message??[]).filter(s=>s.type==='text').map(s=>s.data.text).join('')

function fixture(t,{statusImage=null,statusTimeoutMs=8000,actorRole='admin',botRole='admin',group={},config={}}={}){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'groupguard-status-'))
  const c=JSON.parse(fs.readFileSync(new URL('../config/default.json',import.meta.url),'utf8'))
  Object.assign(c,{masters:[MASTER],groups:[{botId:BOT,groupId:GROUP,enabled:true,...group}]},config)
  fs.mkdirSync(path.join(root,'config'),{recursive:true});fs.writeFileSync(path.join(root,'config/local.json'),JSON.stringify(c))
  const calls=[],replies=[],errors=[],overrides={};let now=Date.parse('2026-11-01T00:00:00Z'),counter=1000
  const adapter=new OneBotAdapter(async(action,params)=>{
    calls.push({action,params})
    if(overrides[action])return overrides[action](params)
    if(action==='get_group_member_info')return ok({role:String(params.user_id)===BOT?botRole:actorRole})
    if(action==='send_group_msg'||action==='send_private_msg'){replies.push(params);return ok({message_id:++counter})}
    return ok({})
  })
  const engine=new GroupGuard(root,{now:()=>now,statusImage,statusTimeoutMs,onError:e=>errors.push(String(e))})
  t.after(()=>{engine.close();fs.rmSync(root,{recursive:true,force:true})})
  return {root,engine,adapter,calls,replies,errors,overrides,get lastText(){return replies.length?text(replies.at(-1)):''},
    async run(msg='#群管状态',extra={}){now+=1100;return engine.handle({post_type:'message',self_id:BOT,group_id:GROUP,user_id:ADMIN,message_id:++counter,message:[],msg,...extra},adapter)}}
}

test('status snapshot/text include every previous status field and keep only public values',()=>{
  const config={timezone:'Asia/Shanghai',inviteMode:'manual',autoQuitEnabled:true,masters:[MASTER],newsSources:[{key:SECRET,url:API_URL}]}
  const group={enabled:true,statistics:true,recall:false,likes:true,welcomeEnabled:true,leaveEnabled:false,joinMode:'answer',dailyEnabled:true,dailyTime:'09:35',unknownSecret:SECRET}
  const snapshot=buildStatusSnapshot({version,config,group,role:'admin',newsConfigured:true,now:Date.parse('2026-11-01T00:00:00Z'),groupId:GROUP})
  const result=buildStatusText(snapshot)
  for(const expected of ['群管 '+version,'本群：开启','机器人：管理员','统计：开启','撤回：关闭','点赞：开启','欢迎：开启','离群通知：关闭','入群审核：答案审核','日报：开启 09:35','来源：已配置','邀请审核：人工审核','自动退群：开启','Asia/Shanghai','08:00:00'])assert.ok(result.includes(expected),expected)
  for(const output of [JSON.stringify(snapshot),result,buildStatusHtml(snapshot)])for(const value of [SECRET,API_URL,MASTER,'synthetic-url-key'])assert.equal(output.includes(value),false)
  assert.equal(Object.hasOwn(snapshot,'config'),false);assert.equal(Object.hasOwn(snapshot,'group'),false)
})

test('HTML escapes all displayed strings and contains no script, external resource or remote URL',()=>{
  const malicious='\"><img src="https://evil.example" onerror="alert(1)"><script>boom</script>&\''
  const snapshot={version:malicious,groupId:malicious,generatedAt:malicious,timezone:malicious,enabled:false,role:malicious,statistics:false,recall:false,likes:false,welcome:false,leave:false,joinMode:malicious,dailyEnabled:false,dailyTime:malicious,newsConfigured:false,inviteMode:malicious,autoQuit:false}
  const html=buildStatusHtml(snapshot)
  assert.ok(html.includes('id="container"'))
  assert.equal(/<script(?:\s|>)/i.test(html),false);assert.equal(/<img(?:\s|>)/i.test(html),false)
  assert.equal(/\ssrc\s*=\s*["']/i.test(html),false);assert.equal(/\shref\s*=\s*["']/i.test(html),false)
  assert.equal(/@import|url\(/i.test(html),false)
  assert.ok(html.includes('&lt;script&gt;'));assert.ok(html.includes('&quot;'));assert.ok(html.includes('&#39;'));assert.ok(html.includes('&amp;'))
})

test('image validation accepts actual PNG/JPEG and rejects signatures, truncated or oversized buffers',()=>{
  assert.equal(isStatusImage(PNG),true);assert.equal(isStatusImage(JPEG),true)
  for(const value of [null,'image',new Uint8Array(PNG),Buffer.from([255,216,255,217]),PNG.subarray(0,24),PNG.subarray(0,-1),Buffer.from('not an image'),Buffer.alloc(2*1024*1024+1),Buffer.from([255,216,...Array(12).fill(255),255,217])])assert.equal(isStatusImage(value),false)
})

test('permission failure never renders or queries the bot role, while explicit master rules remain unchanged',async t=>{
  let renders=0
  const f=fixture(t,{actorRole:'member',statusImage:async()=>{renders++;return PNG}})
  await f.run();assert.equal(renders,0);assert.match(f.lastText,/权限/)
  assert.equal(f.calls.filter(c=>c.action==='get_group_member_info'&&String(c.params.user_id)===BOT).length,0)
  await f.run('#群管状态',{user_id:MASTER});assert.equal(renders,1)
})

test('default status renders one PNG only, including when the group total switch is off',async t=>{
  const rendered=[]
  const f=fixture(t,{group:{enabled:false},statusImage:async html=>{rendered.push(html);return PNG}})
  await f.run()
  assert.equal(rendered.length,1);assert.ok(rendered[0].includes('群管已关闭'));assert.ok(rendered[0].includes('v'+version))
  assert.equal(f.replies.length,1);assert.deepEqual(f.replies[0].message,[{type:'image',data:{file:'base64://'+PNG.toString('base64')}}])
  assert.equal(f.calls.filter(c=>c.action==='get_group_member_info'&&String(c.params.user_id)===BOT).length,1)
})

test('JPEG renderer output is also accepted and unknown bot role is not presented as an administrator',async t=>{
  const seen=[]
  const f=fixture(t,{botRole:'constructor',statusImage:async html=>{seen.push(html);return JPEG}})
  await f.run();assert.equal(f.replies[0].message[0].type,'image')
  assert.ok(seen[0].includes('身份未确认'));assert.equal(seen[0].includes('function Object'),false)
})

test('explicit Chinese text argument and absent renderer use complete text without rendering',async t=>{
  let renders=0
  const f=fixture(t,{statusImage:async()=>{renders++;return PNG}})
  await f.run('#群管状态 文字');await f.run('/群管状态 文字')
  assert.equal(renders,0);assert.equal(f.replies.length,2)
  assert.ok(f.replies.every(p=>p.message[0].type==='text'));assert.match(f.lastText,/本群.*机器人/)
  f.engine.statusImage=null;await f.run();assert.equal(f.replies.at(-1).message[0].type,'text')
})

test('renderer throw or invalid output falls back once without leaking its error content',async t=>{
  for(const outcome of ['throw','invalid','oversized']){
    let renders=0
    const f=fixture(t,{statusImage:async()=>{renders++;if(outcome==='throw')throw new Error(SECRET+' '+API_URL);return outcome==='invalid'?Buffer.from('not-image'):Buffer.alloc(2*1024*1024+1)}})
    await f.run();assert.equal(renders,1);assert.equal(f.replies.length,1);assert.equal(f.replies[0].message[0].type,'text')
    assert.match(f.lastText,/本群/);assert.equal(f.errors.join('').includes(SECRET),false);assert.equal(f.errors.join('').includes(API_URL),false)
  }
})

test('render timeout releases status processing and consumes a later rejection',async t=>{
  let rejectRender,renders=0
  const unhandled=[],onUnhandled=error=>unhandled.push(error)
  process.on('unhandledRejection',onUnhandled);t.after(()=>process.off('unhandledRejection',onUnhandled))
  const f=fixture(t,{statusTimeoutMs:15,statusImage:()=>{renders++;return new Promise((_,reject)=>{rejectRender=reject})}})
  await f.run();assert.equal(renders,1);assert.equal(f.replies.length,1);assert.equal(f.replies[0].message[0].type,'text')
  assert.ok(f.errors.some(s=>s.includes('STATUS_IMAGE_TIMEOUT')))
  rejectRender(new Error('synthetic late reject'))
  await new Promise(resolve=>setImmediate(resolve));await new Promise(resolve=>setImmediate(resolve))
  assert.deepEqual(unhandled,[])
  await f.run('#群管状态 文字');assert.equal(f.replies.length,2)
})

test('render helper completes immediately when renderer resolves and bounds a hanging renderer',async()=>{
  assert.equal(await renderStatusImage(async()=>PNG,'synthetic',{timeoutMs:15}),PNG)
  await assert.rejects(renderStatusImage(()=>new Promise(()=>{}),'synthetic',{timeoutMs:10}),error=>error.code==='STATUS_IMAGE_TIMEOUT')
})

test('image send failure falls back to text and never retries the image even when the result is unknown',async t=>{
  let renders=0,imageAttempts=0
  const f=fixture(t,{statusImage:async()=>{renders++;return PNG}})
  f.overrides.send_group_msg=params=>{
    if(params.message[0].type==='image'){imageAttempts++;throw new Error(SECRET+' '+API_URL)}
    f.replies.push(params);return ok({message_id:7000})
  }
  await f.run();assert.equal(renders,1);assert.equal(imageAttempts,1)
  assert.equal(f.replies.length,1);assert.equal(f.replies[0].message[0].type,'text');assert.match(f.lastText,/本群/)
  assert.ok(f.errors.some(s=>s.includes('STATUS_IMAGE_SEND_FAILED')))
  assert.equal(f.errors.join('').includes(SECRET),false);assert.equal(f.errors.join('').includes(API_URL),false)
})

test('full image/text status never includes configured secrets, URLs, master IDs or unrelated templates',async t=>{
  const seen=[]
  const f=fixture(t,{config:{inviteMode:'manual',autoQuitEnabled:true},group:{welcomeMessage:'secret template '+SECRET},statusImage:async html=>{seen.push(html);return PNG}})
  f.engine.config.setNews(BOT,GROUP,{url:API_URL,authType:'bearer',keyAction:'replace',key:SECRET})
  await f.run();await f.run('#群管状态 文字')
  for(const output of [...seen,f.lastText,JSON.stringify(f.errors)])for(const value of [SECRET,API_URL,MASTER,'synthetic-url-key','secret template'])assert.equal(output.includes(value),false)
  assert.ok(seen[0].includes('已配置'));assert.match(f.lastText,/来源：已配置/)
})
