import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import {AdminApi,AdminError,GROUP_SECTIONS,GLOBAL_SECTIONS,validId,parseList,fieldValue,newsPayload,createAdminApp} from '../resources/admin/app.js'
import {groupDefaults,GLOBAL_CHAT_FIELDS} from '../lib/config.mjs'

const html=fs.readFileSync(new URL('../resources/admin/index.html',import.meta.url),'utf8')
const source=fs.readFileSync(new URL('../resources/admin/app.js',import.meta.url),'utf8')
const defaults=JSON.parse(fs.readFileSync(new URL('../config/default.json',import.meta.url),'utf8'))
const response=(data,status=200)=>({ok:status>=200&&status<300,status,async json(){return structuredClone(data)}})
const config=(revision='r1')=>({
  revision,global:Object.fromEntries([...GLOBAL_CHAT_FIELDS].map(key=>[key,structuredClone(defaults[key])])),
  groups:[{...structuredClone(groupDefaults),botId:'100000001',groupId:'200000001',enabled:true}],
  newsSources:[{botId:'100000001',groupId:'200000001',url:'https://example.invalid/news',authType:'bearer',authName:'',hasKey:true}],
  readonly:{mastersConfigured:true},availableBots:['100000001'],
  schema:{groupDefaults,groupFields:Object.keys(groupDefaults).filter(key=>!['botId','groupId'].includes(key)),globalFields:[...GLOBAL_CHAT_FIELDS]}
})

test('表单覆盖真实可写配置，主人和内部迁移字段没有浏览器编辑入口',()=>{
  const groupKeys=GROUP_SECTIONS.flatMap(section=>section.fields.map(field=>field.key))
  const globalKeys=GLOBAL_SECTIONS.flatMap(section=>section.fields.map(field=>field.key))
  assert.deepEqual([...groupKeys].sort(),Object.keys(groupDefaults).filter(key=>!['botId','groupId'].includes(key)).sort())
  assert.deepEqual([...globalKeys].sort(),[...GLOBAL_CHAT_FIELDS].sort())
  assert.equal(globalKeys.includes('masters'),false)
  assert.equal(globalKeys.includes('newsSources'),false)
  assert.equal(globalKeys.includes('legacy'),false)
  assert.equal(new Set(groupKeys).size,groupKeys.length)
})

test('简明表单输入验证名单、答案、数字、时间与时区，拒绝危险或无效对象标识',()=>{
  assert.deepEqual(parseList('123456789，234567890\n123456789'),['123456789','234567890'])
  assert.deepEqual(parseList('答案一\n\n答案二',{answers:true}),['答案一','答案二'])
  assert.throws(()=>parseList('123456789<script>'),/QQ/)
  assert.throws(()=>parseList('a'.repeat(201),{answers:true}),/200/)
  assert.equal(validId('*',{wildcard:true}),'*')
  for(const value of ['*','123','1e8','9007199254740993'])assert.throws(()=>validId(value))
  assert.equal(fieldValue({key:'limit',label:'人数',type:'integer',min:1,max:50},'12'),12)
  assert.throws(()=>fieldValue({label:'人数',type:'integer',min:1,max:50},''))
  assert.throws(()=>fieldValue({label:'时间',type:'time'},'24:01'))
  assert.throws(()=>fieldValue({key:'timezone',label:'时区',type:'text'},'Not/A_Timezone'))
})

test('新闻保存只在明确替换时发送Key，保留/清空不泄露输入，鉴权名称及精确账号有校验',()=>{
  const base={botId:'100000001',groupId:'200000001',url:'https://example.invalid/news',authType:'bearer',key:'synthetic-secret'}
  const keep=newsPayload({...base,keyAction:'keep'})
  assert.equal(Object.hasOwn(keep.patch,'key'),false)
  assert.equal(keep.patch.keyAction,'keep')
  const clear=newsPayload({...base,keyAction:'clear'})
  assert.equal(Object.hasOwn(clear.patch,'key'),false)
  const replace=newsPayload({...base,keyAction:'replace'})
  assert.equal(replace.patch.key,'synthetic-secret')
  assert.throws(()=>newsPayload({...base,botId:'*'}),/QQ/)
  assert.throws(()=>newsPayload({...base,url:'javascript:alert(1)'}),/HTTP/)
  assert.throws(()=>newsPayload({...base,url:'https://user:password@example.invalid'}),/用户名/)
  assert.throws(()=>newsPayload({...base,keyAction:'replace',key:'bad\nkey'}),/Key/)
  assert.throws(()=>newsPayload({...base,authType:'header',authName:'Invalid Header'}),/请求头/)
  assert.throws(()=>newsPayload({...base,authType:'query',authName:'bad&name'}),/参数/)
  assert.equal(newsPayload({...base,authName:'should-not-send'}).patch.authName,'')
})

test('同源登录与写入带CSRF和revision，密码不进入URL，客户端不持久凭据',async()=>{
  const calls=[]
  const api=new AdminApi(async(url,options)=>{calls.push({url,options});if(url==='/api/login')return response({authenticated:true,csrf:'csrf-token',mustChangePassword:false});return response(config(url==='/api/config'?'r1':'r2'))})
  await api.login('synthetic-password')
  await api.config()
  await api.update('/api/config/group',{botId:'100000001',groupId:'200000001',patch:{enabled:true}})
  assert.equal(calls[0].url,'/api/login')
  assert.equal(JSON.parse(calls[0].options.body).password,'synthetic-password')
  assert.equal(calls[0].options.headers['X-CSRF-Token'],undefined)
  assert.equal(calls[2].options.headers['X-CSRF-Token'],'csrf-token')
  assert.equal(calls[2].options.credentials,'same-origin')
  assert.equal(calls[2].options.cache,'no-store')
  assert.equal(JSON.parse(calls[2].options.body).revision,'r1')
  assert.equal(api.revision,'r2')
  assert.equal(calls.some(call=>call.url.includes('synthetic-password')),false)
  assert.doesNotMatch(source,/localStorage|sessionStorage|console\.(?:log|debug)|innerHTML|insertAdjacentHTML|document\.write/)
})

test('重复保存只发一次，409冲突停止写入直到明确重载，不自动覆盖新配置',async()=>{
  let release,calls=0
  const api=new AdminApi(async(url)=>{calls++;if(url==='/api/config')return response(config('new-revision'));return new Promise(resolve=>{release=()=>resolve(response({error:'配置已变化',code:'REVISION_CONFLICT'},409))})})
  api.revision='old-revision'
  const first=api.update('/api/config/global',{patch:{inviteMode:'manual'}})
  await assert.rejects(api.update('/api/config/global',{patch:{inviteMode:'accept'}}),error=>error.code==='SAVE_IN_PROGRESS')
  assert.equal(calls,1)
  release()
  await assert.rejects(first,error=>error.status===409)
  await assert.rejects(api.update('/api/config/global',{patch:{inviteMode:'accept'}}),error=>error.code==='RELOAD_REQUIRED')
  assert.equal(calls,1)
  await api.config()
  assert.equal(api.blocked,false)
  assert.equal(api.revision,'new-revision')
})

test('断网或无法识别的写入结果保持未决，登录过期清会话，改密成功清所有前端授权状态',async()=>{
  let mode='network'
  const api=new AdminApi(async()=>{
    if(mode==='network')throw new Error('synthetic-secret network failure')
    if(mode==='expired')return response({error:'需要登录',code:'UNAUTHORIZED'},401)
    return response({ok:true,loginRequired:true})
  })
  api.csrf='test-csrf';api.authenticated=true
  await assert.rejects(api.update('/api/config/news',{patch:{}}),error=>error.uncertain&&!error.message.includes('synthetic-secret'))
  assert.equal(api.blocked,true)
  mode='expired'
  await assert.rejects(api.config(),error=>error.status===401)
  assert.equal(api.csrf,'');assert.equal(api.authenticated,false)
  mode='password';api.csrf='new-token';api.authenticated=true
  await api.password('old-synthetic','new-synthetic-password')
  assert.equal(api.csrf,'');assert.equal(api.authenticated,false)
})

// A small DOM surface for controller behavior; native browser rendering is separately verified.
class Element {
  constructor(doc,tag='div'){this.doc=doc;this.tagName=tag;this.attrs={};this.dataset={};this.children=[];this.listeners={};this.className='';this.value='';this.checked=false;this.hidden=false;this.disabled=false;this.connected=false;this.textContent='';this.open=false;this.classList={toggle:(name,on)=>{const set=new Set(this.className.split(/\s+/).filter(Boolean));if(on)set.add(name);else set.delete(name);this.className=[...set].join(' ')}};doc.pool.push(this)}
  set id(value){this._id=value;if(this.connected)this.doc.ids.set(value,this)}get id(){return this._id}
  setAttribute(name,value){this.attrs[name]=value;if(name==='id')this.id=value;if(name==='class')this.className=value;if(name.startsWith('data-'))this.dataset[name.slice(5).replace(/-([a-z])/g,(_,c)=>c.toUpperCase())]=value}
  connect(on){this.connected=on;if(this.id){if(on)this.doc.ids.set(this.id,this);else if(this.doc.ids.get(this.id)===this)this.doc.ids.delete(this.id)}for(const child of this.children)child.connect(on)}
  append(...elements){for(const element of elements){this.children.push(element);element.connect(this.connected)}}
  replaceChildren(...elements){for(const child of this.children)child.connect(false);this.children=[];this.append(...elements)}
  addEventListener(type,listener){(this.listeners[type]??=[]).push(listener)}
  fire(type){for(const listener of this.listeners[type]||[])listener({target:this,preventDefault(){}})}
  focus(){this.doc.focused=this}
  showModal(){this.open=true}close(){this.open=false}
}
function dom(){
  const doc={ids:new Map(),pool:[],createElement(tag){return new Element(this,tag)},getElementById(id){return this.ids.get(id)||null},querySelectorAll(selector){return this.pool.filter(element=>element.connected&&(selector.startsWith('.')?element.className.split(/\s+/).includes(selector.slice(1)):selector.startsWith('[')?Object.hasOwn(element.attrs,selector.slice(1,-1)):false))}}
  for(const match of html.matchAll(/<([a-z][a-z0-9]*)\b([^>]*)>/gi)){
    const element=new Element(doc,match[1]);element.connected=true
    for(const attribute of match[2].matchAll(/([^\s=]+)(?:="([^"]*)")?/g))element.setAttribute(attribute[1],attribute[2]??'')
    if(Object.hasOwn(element.attrs,'hidden'))element.hidden=true
  }
  return doc
}
const flush=()=>new Promise(resolve=>setImmediate(resolve))

test('初始密码会话只显示强制改密，不读取配置；改密后回登录并清空输入',async()=>{
  const calls=[],doc=dom()
  const api=new AdminApi(async(url,options)=>{calls.push({url,options});if(url==='/api/session')return response({authenticated:true,csrf:'csrf',mustChangePassword:true});if(url==='/api/password')return response({ok:true,loginRequired:true});throw new Error('forced password change must not fetch config')})
  const app=createAdminApp(doc,api);await app.start()
  assert.deepEqual(calls.map(call=>call.url),['/api/session'])
  assert.equal(doc.getElementById('passwordView').hidden,false)
  assert.equal(doc.getElementById('groupsView').hidden,true)
  assert.equal(doc.querySelectorAll('[data-view]').find(button=>button.dataset.view==='groups').disabled,true)
  doc.getElementById('currentPassword').value='synthetic-initial'
  doc.getElementById('newPassword').value=doc.getElementById('confirmPassword').value='Synthetic-new-password-2026!'
  doc.getElementById('passwordForm').fire('submit');await flush()
  assert.equal(calls.at(-1).url,'/api/password')
  assert.equal(doc.getElementById('loginView').hidden,false)
  assert.equal(doc.getElementById('currentPassword').value,'')
  assert.equal(doc.getElementById('newPassword').value,'')
})

test('DOM表单实际提交typed配置，保留Key时不发送密钥；退出清掉已读配置与模态框',async()=>{
  const doc=dom(),calls=[]
  const api=new AdminApi(async(url,options)=>{
    calls.push({url,body:options.body?JSON.parse(options.body):null})
    if(url==='/api/session')return response({authenticated:true,csrf:'csrf',mustChangePassword:false})
    if(url==='/api/logout')return response({ok:true})
    return response(config())
  })
  await createAdminApp(doc,api).start()
  assert.match(doc.getElementById('mastersStatus').textContent,/已配置/)
  assert.equal(doc.getElementById('newsKey').value,'')
  doc.getElementById('group-recallLimit').value='12'
  doc.getElementById('groupForm').fire('submit');await flush()
  const saved=calls.find(call=>call.url==='/api/config/group')
  assert.equal(saved.body.patch.recallLimit,12)
  assert.equal(saved.body.patch.enabled,true)
  assert.equal(Object.hasOwn(saved.body.patch,'masters'),false)
  doc.getElementById('newsUrl').value='https://example.invalid/updated'
  doc.getElementById('keyAction').value='keep'
  doc.getElementById('newsKey').value='must-not-be-submitted'
  doc.getElementById('newsForm').fire('submit');await flush()
  const news=calls.find(call=>call.url==='/api/config/news')
  assert.equal(news.body.patch.keyAction,'keep')
  assert.equal(Object.hasOwn(news.body.patch,'key'),false)
  assert.equal(doc.getElementById('newsKey').value,'')
  doc.getElementById('addGroupDialog').showModal()
  doc.getElementById('logoutButton').fire('click');await flush()
  assert.equal(doc.getElementById('addGroupDialog').open,false)
  assert.equal(doc.getElementById('loginView').hidden,false)
  assert.equal(doc.getElementById('newsUrl').value,'')
  assert.equal(doc.getElementById('group-recallLimit'),null)
})

test('新闻scope切换加载目标的完整来源，新对象清空；保存重核binding拒绝跨对象套用',async()=>{
  const doc=dom(),calls=[],data=config()
  data.newsSources.push({botId:'100000002',groupId:'200000001',url:'https://source-b.invalid/news',authType:'header',authName:'X-Source-B',hasKey:true})
  const api=new AdminApi(async(url,options)=>{calls.push({url,body:options.body?JSON.parse(options.body):null});return response(url==='/api/session'?{authenticated:true,csrf:'csrf',mustChangePassword:false}:data)})
  await createAdminApp(doc,api).start()
  assert.equal(doc.getElementById('newsUrl').value,'https://example.invalid/news')
  doc.getElementById('newsKey').value='source-a-replacement'
  doc.getElementById('newsBot').value='100000002'
  doc.getElementById('newsBot').fire('input')
  assert.equal(doc.getElementById('newsUrl').value,'https://source-b.invalid/news')
  assert.equal(doc.getElementById('newsAuthType').value,'header')
  assert.equal(doc.getElementById('newsAuthName').value,'X-Source-B')
  assert.equal(doc.getElementById('newsKey').value,'')
  assert.equal(doc.getElementById('keyAction').value,'keep')
  doc.getElementById('newsGroup').value='200000002'
  doc.getElementById('newsGroup').fire('change')
  assert.equal(doc.getElementById('newsUrl').value,'')
  assert.equal(doc.getElementById('newsAuthType').value,'none')
  assert.equal(doc.getElementById('newsAuthName').value,'')
  assert.match(doc.getElementById('newsScopeHint').textContent,/已清空/)
  // Programmatic changes without input/change events must also fail closed.
  doc.getElementById('newsBot').value='100000001'
  doc.getElementById('newsGroup').value='200000001'
  doc.getElementById('newsUrl').value='https://wrong-scope.invalid/'
  doc.getElementById('newsForm').fire('submit');await flush()
  assert.equal(calls.some(call=>call.url==='/api/config/news'),false)
  assert.equal(doc.getElementById('newsUrl').value,'https://example.invalid/news')
  assert.match(doc.getElementById('notice').textContent,/核对/)
})

test('HTML只加载同源静态资源，无内联脚本或事件，无外部字体/CDN',()=>{
  assert.match(html,/<script\s+type="module"\s+src="\/app\.js"><\/script>/)
  assert.match(html,/<link\s+rel="stylesheet"\s+href="\/style\.css">/)
  assert.doesNotMatch(html,/<script(?![^>]*\bsrc=)[^>]*>|\son[a-z]+\s*=|<iframe|<link[^>]+https?:|<script[^>]+https?:/i)
  assert.doesNotMatch(fs.readFileSync(new URL('../resources/admin/style.css',import.meta.url),'utf8'),/@import|url\(https?:/i)
})
