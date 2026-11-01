import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import {randomBytes,scrypt,timingSafeEqual,createHash,createHmac} from 'node:crypto'
import {promisify} from 'node:util'
import {atomic,id,groupDefaults,GLOBAL_CHAT_FIELDS,GROUP_CHAT_FIELDS} from './config.mjs'

const derive=promisify(scrypt)
const SESSION_MS=30*60*1000,BODY_LIMIT=1024*1024,COOKIE='groupguard_admin'
const GROUP_FIELDS=new Set(['enabled',...GROUP_CHAT_FIELDS])
const ASSETS=new Map([['/','index.html'],['/index.html','index.html'],['/app.js','app.js'],['/style.css','style.css']])
const MIME={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8'}
const object=x=>x!==null&&typeof x==='object'&&!Array.isArray(x)
class HttpError extends Error{constructor(status,code,message){super(message);this.status=status;this.code=code}}
const fail=(status,code,message)=>{throw new HttpError(status,code,message)}
const random=()=>randomBytes(32).toString('base64url')
const hash=x=>createHash('sha256').update(x).digest('hex')
const same=(a,b)=>typeof a==='string'&&typeof b==='string'&&Buffer.byteLength(a)===Buffer.byteLength(b)&&timingSafeEqual(Buffer.from(a),Buffer.from(b))
const fields=(value,allowed)=>{
  if(!object(value))fail(400,'INVALID_BODY','保存内容必须是对象')
  for(const key of Object.keys(value))if(!allowed.has(key))fail(400,'PROTECTED_FIELD','包含未知或受保护字段')
}
async function passwordHash(password,salt){return Buffer.from(await derive(password,salt,64,{N:16384,r:8,p:1,maxmem:64*1024*1024})).toString('hex')}
function validPassword(value){return typeof value==='string'&&value.length>=12&&Buffer.byteLength(value)<=1024}
async function loadAuth(root){
  const directory=path.join(root,'data'),file=path.join(directory,'admin-auth.json'),initial=path.join(directory,'admin-initial-password.txt')
  fs.mkdirSync(directory,{recursive:true})
  if(fs.existsSync(file)){
    const value=JSON.parse(fs.readFileSync(file,'utf8'))
    if(!object(value)||value.version!==1||typeof value.salt!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(value.salt)||typeof value.hash!=='string'||!/^[a-f0-9]{128}$/.test(value.hash)||typeof value.mustChangePassword!=='boolean')throw new Error('管理认证文件无效，已停止启动，原文件保留')
    fs.chmodSync(file,0o600)
    if(fs.existsSync(initial)){
      if(value.mustChangePassword)fs.chmodSync(initial,0o600)
      else fs.unlinkSync(initial)
    }
    return {file,initial,value}
  }
  let password
  if(fs.existsSync(initial)){
    password=fs.readFileSync(initial,'utf8').trim()
    if(!/^[A-Za-z0-9_-]{43}$/.test(password))throw new Error('初始管理密码文件无效，已停止启动，原文件保留')
    fs.chmodSync(initial,0o600)
  }else{
    password=random();fs.writeFileSync(initial,password+'\n',{flag:'wx',mode:0o600})
  }
  const salt=random(),value={version:1,salt,hash:await passwordHash(password,salt),mustChangePassword:true}
  atomic(file,value)
  return {file,initial,value}
}
function originFor(req){
  const authority=req.headers.host
  if(typeof authority!=='string'||req.rawHeaders.filter((_,i)=>i%2===0&&req.rawHeaders[i].toLowerCase()==='host').length!==1)fail(403,'INVALID_HOST','管理界面仅接受本机访问地址')
  let u
  try{u=new URL('http://'+authority)}catch{fail(403,'INVALID_HOST','管理界面仅接受本机访问地址')}
  // Accept a local tunnel's external port, never forwarded-host or arbitrary DNS names.
  if(!['127.0.0.1','localhost','[::1]'].includes(u.hostname)||u.username||u.password||u.pathname!=='/'||u.search||u.hash||!/^((127\.0\.0\.1|localhost)(:\d{1,5})?|\[::1\](:\d{1,5})?)$/i.test(authority))fail(403,'INVALID_HOST','管理界面仅接受本机访问地址')
  return u.origin
}
async function body(req){
  if(!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type']??''))fail(415,'JSON_REQUIRED','请使用 JSON 请求')
  if(req.headers['content-encoding']&&req.headers['content-encoding']!=='identity')fail(415,'ENCODING_UNSUPPORTED','不支持压缩请求')
  if(req.headers['content-length']&&Number(req.headers['content-length'])>BODY_LIMIT)fail(413,'BODY_TOO_LARGE','请求内容超过 1 MiB')
  const chunks=[];let length=0,tooLarge=false
  for await(const chunk of req){
    length+=chunk.length
    if(length>BODY_LIMIT){tooLarge=true;chunks.length=0}
    else if(!tooLarge)chunks.push(chunk)
  }
  if(tooLarge)fail(413,'BODY_TOO_LARGE','请求内容超过 1 MiB')
  let value
  try{value=JSON.parse(Buffer.concat(chunks).toString('utf8'))}catch{fail(400,'INVALID_JSON','JSON 格式不正确')}
  if(!object(value))fail(400,'INVALID_BODY','请求内容必须是对象')
  return value
}

export async function createAdminServer({root,store,engine,host='127.0.0.1',port=15083,onError=()=>{}}){
  if(!['127.0.0.1','localhost','::1','0.0.0.0'].includes(host))throw new Error('管理监听地址仅允许回环地址或容器内部 0.0.0.0')
  if(!Number.isInteger(port)||port<0||port>65535)throw new Error('管理监听端口无效')
  if(!store||typeof store.read!=='function'||typeof store.update!=='function'||typeof store.setNews!=='function')throw new Error('缺少有效配置存储')
  const auth=await loadAuth(root),sessions=new Map(),attempts=new Map(),revisionSecret=randomBytes(32)
  const report=code=>{try{onError('[GroupGuard Admin] '+code)}catch{}}
  const revision=c=>createHmac('sha256',revisionSecret).update(JSON.stringify(c)).digest('hex')
  const view=()=>{
    const c=store.read()
    return {
      revision:revision(c),global:Object.fromEntries([...GLOBAL_CHAT_FIELDS].map(k=>[k,c[k]])),
      groups:c.groups.map(g=>Object.fromEntries(Object.keys(groupDefaults).map(k=>[k,g[k]??structuredClone(groupDefaults[k])]))),
      newsSources:c.newsSources.map(s=>({botId:String(s.botId),groupId:String(s.groupId),...store.getNewsForEditor(s.botId,s.groupId,c)})),
      readonly:{mastersConfigured:c.masters.length>0},
      availableBots:engine?.adapters instanceof Map?[...engine.adapters.keys()].map(String).filter(s=>/^[1-9]\d{3,15}$/.test(s)):[],
      schema:{groupDefaults,globalFields:[...GLOBAL_CHAT_FIELDS],groupFields:[...GROUP_FIELDS]}
    }
  }
  const cookie=(res,token,clear=false)=>res.setHeader('Set-Cookie',`${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${clear?0:SESSION_MS/1000}`)
  const sessionFor=req=>{
    const values=(req.headers.cookie??'').split(';').map(s=>s.trim()).filter(s=>s.startsWith(COOKIE+'='))
    if(values.length!==1)return null
    const token=values[0].slice(COOKIE.length+1)
    if(!/^[A-Za-z0-9_-]{43}$/.test(token))return null
    const key=hash(token),value=sessions.get(key)
    if(!value||value.expires<=Date.now()){sessions.delete(key);return null}
    return {...value,key}
  }
  const send=(res,status,value)=>{res.statusCode=status;res.setHeader('Content-Type','application/json; charset=utf-8');res.end(JSON.stringify(value))}
  const server=http.createServer({maxHeaderSize:16*1024},(req,res)=>{
    res.setHeader('Cache-Control','no-store')
    res.setHeader('Content-Security-Policy',"default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'")
    res.setHeader('X-Frame-Options','DENY');res.setHeader('X-Content-Type-Options','nosniff')
    res.setHeader('Referrer-Policy','no-referrer');res.setHeader('X-DNS-Prefetch-Control','off')
    res.setHeader('Cross-Origin-Resource-Policy','same-origin')
    ;(async()=>{
      const origin=originFor(req),route=(req.url??'').split('?')[0]
      if(!route.startsWith('/')||route.startsWith('//'))fail(400,'INVALID_PATH','请求路径无效')
      if(req.method==='GET'&&ASSETS.has(route)){
        const file=path.join(root,'resources/admin',ASSETS.get(route)),directory=path.resolve(root,'resources/admin')
        let real
        try{real=fs.realpathSync(file)}catch{fail(404,'NOT_FOUND','页面资源尚未安装')}
        if(path.dirname(real)!==fs.realpathSync(directory))fail(404,'NOT_FOUND','资源不存在')
        res.setHeader('Content-Type',MIME[path.extname(file)]);res.end(fs.readFileSync(real));return
      }
      if(req.headers.origin!==undefined&&req.headers.origin!==origin)fail(403,'INVALID_ORIGIN','请求必须来自同一管理页面')
      if(req.headers['sec-fetch-site']==='cross-site')fail(403,'INVALID_ORIGIN','请求必须来自同一管理页面')
      if(!route.startsWith('/api/'))fail(404,'NOT_FOUND','接口不存在')
      const now=Date.now()
      for(const [key,value]of sessions)if(value.expires<=now)sessions.delete(key)
      for(const [key,value]of attempts)if(value.until<=now)attempts.delete(key)
      const session=sessionFor(req)
      if(req.method==='GET'&&route==='/api/session'){
        send(res,200,session?{authenticated:true,csrf:session.csrf,mustChangePassword:auth.value.mustChangePassword}:{authenticated:false});return
      }
      if(req.method==='GET'&&route==='/api/config'){
        if(!session)fail(401,'UNAUTHORIZED','请先登录')
        if(auth.value.mustChangePassword)fail(403,'PASSWORD_CHANGE_REQUIRED','请先修改初始密码')
        send(res,200,view());return
      }
      if(req.method!=='POST')fail(405,'METHOD_NOT_ALLOWED','不支持该请求方法')
      if(req.headers.origin!==origin)fail(403,'INVALID_ORIGIN','请求必须来自同一管理页面')
      if(route!=='/api/login'){
        if(!session)fail(401,'UNAUTHORIZED','请先登录')
        if(!same(req.headers['x-csrf-token'],session.csrf))fail(403,'INVALID_CSRF','页面校验已失效，请重新登录')
        if(auth.value.mustChangePassword&&!['/api/password','/api/logout'].includes(route))fail(403,'PASSWORD_CHANGE_REQUIRED','请先修改初始密码')
      }
      const data=await body(req)
      const assertLive=()=>{
        const current=session&&sessions.get(session.key)
        if(!current||current.expires<=Date.now())fail(401,'UNAUTHORIZED','会话已失效，请重新登录')
      }
      if(route!=='/api/login')assertLive()
      if(route==='/api/login'){
        fields(data,new Set(['password']))
        const ip=req.socket.remoteAddress??'unknown',previous=attempts.get(ip)
        if(previous?.count>=5){res.setHeader('Retry-After',String(Math.ceil((previous.until-now)/1000)));fail(429,'LOGIN_RATE_LIMIT','登录尝试过多，请稍后再试')}
        if(attempts.size>256)fail(429,'LOGIN_RATE_LIMIT','登录尝试过多，请稍后再试')
        attempts.set(ip,{count:(previous?.count??0)+1,until:previous?.until??now+5*60*1000})
        const before=auth.value
        if(!validPassword(data.password)||!same(await passwordHash(data.password,before.salt),before.hash)||before!==auth.value)fail(401,'INVALID_CREDENTIALS','密码错误')
        attempts.delete(ip)
        const token=random(),csrf=random()
        while(sessions.size>=128)sessions.delete(sessions.keys().next().value)
        sessions.set(hash(token),{csrf,expires:Date.now()+SESSION_MS})
        cookie(res,token);send(res,200,{authenticated:true,csrf,mustChangePassword:auth.value.mustChangePassword});return
      }
      if(route==='/api/logout'){
        fields(data,new Set());sessions.delete(session.key);cookie(res,'',true);send(res,200,{ok:true});return
      }
      if(route==='/api/password'){
        fields(data,new Set(['currentPassword','newPassword']))
        if(!validPassword(data.newPassword)||data.newPassword===data.currentPassword)fail(400,'INVALID_PASSWORD','新密码至少 12 个字符、最多 1024 字节，且不能与旧密码相同')
        const before=auth.value
        if(!validPassword(data.currentPassword)||!same(await passwordHash(data.currentPassword,before.salt),before.hash))fail(401,'INVALID_CREDENTIALS','当前密码错误')
        const salt=random(),next={version:1,salt,hash:await passwordHash(data.newPassword,salt),mustChangePassword:false}
        assertLive()
        if(before!==auth.value)fail(409,'AUTH_CHANGED','密码已变化，请重新登录')
        atomic(auth.file,next);auth.value=next;sessions.clear();cookie(res,'',true)
        if(fs.existsSync(auth.initial))fs.unlinkSync(auth.initial)
        send(res,200,{ok:true,loginRequired:true});return
      }
      const routes=new Set(['/api/config/global','/api/config/group','/api/config/group/remove','/api/config/news','/api/config/news/remove'])
      if(!routes.has(route))fail(404,'NOT_FOUND','接口不存在')
      fields(data,new Set(route==='/api/config/global'?['revision','patch']:['revision','botId','groupId',...(route.endsWith('/remove')?[]:['patch'])]))
      if(typeof data.revision!=='string'||data.revision!==revision(store.read()))fail(409,'REVISION_CONFLICT','配置已变化，请重新加载后再保存')
      try{
        if(route==='/api/config/global'){
          fields(data.patch,GLOBAL_CHAT_FIELDS)
          store.update(c=>Object.assign(c,data.patch))
        }else{
          const botId=data.botId==='*'&&route.startsWith('/api/config/group')?'*':id(data.botId),groupId=id(data.groupId)
          const matches=g=>String(g.botId)===botId&&String(g.groupId)===groupId
          if(route==='/api/config/group'){
            fields(data.patch,GROUP_FIELDS)
            store.update(c=>{
              let g=c.groups.find(matches)
              if(!g){g={...store.group(botId,groupId,c),botId,groupId};c.groups.push(g)}
              Object.assign(g,data.patch)
            })
          }else if(route==='/api/config/group/remove'){
            store.update(c=>{c.groups=c.groups.filter(g=>!matches(g));c.newsSources=c.newsSources.filter(g=>!matches(g))})
          }else if(route==='/api/config/news')store.setNews(botId,groupId,data.patch)
          else store.update(c=>{c.newsSources=c.newsSources.filter(g=>!matches(g))})
        }
      }catch(error){
        if(error instanceof HttpError)throw error
        fail(400,'INVALID_CONFIG','配置校验或保存失败，请检查字段类型、取值范围与存储状态')
      }
      send(res,200,view())
    })().catch(error=>{
      if(res.writableEnded||res.destroyed)return
      if(error instanceof HttpError){if(error.status===413)res.setHeader('Connection','close');send(res,error.status,{error:error.message,code:error.code})}
      else{report('REQUEST_FAILED');send(res,500,{error:'本地管理操作未完成，请检查日志并重新读取实际状态',code:'INTERNAL_ERROR'})}
    })
  })
  server.requestTimeout=15000;server.headersTimeout=15000;server.keepAliveTimeout=5000;server.maxHeadersCount=32;server.maxRequestsPerSocket=100
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,host,()=>{server.off('error',reject);resolve()})})
  server.on('error',()=>report('SERVER_ERROR'))
  let closing
  return {server,address:server.address(),close(){
    if(!closing){sessions.clear();closing=new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve()));server.closeIdleConnections?.()}
    return closing
  }}
}
