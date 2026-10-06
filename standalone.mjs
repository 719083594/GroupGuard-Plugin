import http from 'node:http'
import fs from 'node:fs'
import {fileURLToPath} from 'node:url'
import {createHmac,timingSafeEqual} from 'node:crypto'
import {GroupGuard} from './lib/core.mjs'
import {OneBotAdapter} from './lib/adapter.mjs'
// Secrets are environment variables, never written into the distributed source.
const root=fileURLToPath(new URL('.',import.meta.url))
const configPath=new URL('./config/standalone.json',import.meta.url)
if(!fs.existsSync(configPath))throw new Error('请复制 config/standalone.example.json 为 config/standalone.json')
const config=JSON.parse(fs.readFileSync(configPath,'utf8'))
if(!process.env.GROUPGUARD_EVENT_SECRET)throw new Error('必须设置 GROUPGUARD_EVENT_SECRET，与 OneBot HTTP 上报 secret 一致')
const token=process.env.GROUPGUARD_API_TOKEN||''
const engine=new GroupGuard(root),adapters=new Map()
for(const bot of config.bots){
  const url=new URL(bot.apiUrl);if(!['http:','https:'].includes(url.protocol))throw new Error('API URL 必须是 HTTP(S)')
  const adapter=new OneBotAdapter(async(action,params)=>{
    const r=await fetch(new URL(action,bot.apiUrl.replace(/\/?$/,'/')),{method:'POST',headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},body:JSON.stringify(params),signal:AbortSignal.timeout(15000)})
    if(!r.ok)throw new Error('OneBot HTTP '+r.status);return r.json()
  });adapters.set(String(bot.botId),adapter);engine.register(String(bot.botId),adapter)
}
engine.start()
const server=http.createServer(async(req,res)=>{
  if(req.method==='GET'&&req.url==='/healthz'){res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({ok:true,version:'1.0.0'}));return}
  if(req.method!=='POST'||req.url!=='/onebot'){res.writeHead(404);res.end();return}
  try{
    let size=0;const chunks=[]
    for await(const c of req){size+=c.length;if(size>1048576)throw new Error('payload too large');chunks.push(c)}
    const body=Buffer.concat(chunks),signature=String(req.headers['x-signature']||'')
    const expected='sha1='+createHmac('sha1',process.env.GROUPGUARD_EVENT_SECRET).update(body).digest('hex')
    if(signature.length!==expected.length||!timingSafeEqual(Buffer.from(signature),Buffer.from(expected))){res.writeHead(401);res.end();return}
    const event=JSON.parse(body),a=adapters.get(String(event.self_id))
    if(!a){res.writeHead(403);res.end();return}
    // HTTP payloads cannot claim bot-master status. Core uses the local master list.
    delete event.isMaster;delete event.bot
    res.writeHead(200);res.end('{}')
    await engine.handle(event,a)
  }catch(error){console.error(error.message);if(!res.headersSent){res.writeHead(400);res.end('{}')}}
})
server.listen(config.port||15083,config.host||'127.0.0.1',()=>console.log('群管独立 HTTP 服务已启动'))
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>{engine.close();server.close(()=>process.exit(0))})
