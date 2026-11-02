/** Framework integration entry. Importing this module starts no engine or server. */
import {fileURLToPath} from 'node:url'
import {GroupGuard,version} from './lib/core.mjs'
import {OneBotAdapter,OneBotError,normalize,unwrap} from './lib/adapter.mjs'
import {id} from './lib/config.mjs'
import {createHelpImages} from './lib/help-images.mjs'
import {createAdminServer} from './lib/admin.mjs'

export {GroupGuard,version,OneBotAdapter,OneBotError,normalize,unwrap}
export {createStatusImageRenderer} from './lib/status-image.mjs'

const packageRoot=fileURLToPath(new URL('.',import.meta.url))

/**
 * call(botId, action, params) is supplied by the HOST FRAMEWORK, not a network URL.
 * It translates the OneBot-v11-shaped operations into the host's actual API.
 * Events and isMaster must be normalized/trusted by that host's adapter.
 */
export function createGroupGuard({root=packageRoot,framework='自定义框架',call,
  now=()=>Date.now(),fetcher=fetch,onError=console.error,helpImages,
  statusImage=null,statusTimeoutMs=8000,updater=null,loginLink=null}={}){
  if(typeof call!=='function')throw new TypeError('需要宿主框架提供 call(botId, action, params)')
  if(typeof root!=='string'||!root)throw new TypeError('插件根目录无效')
  if(typeof framework!=='string'||!framework.trim()||framework.length>80||/[\r\n\0]/.test(framework))throw new TypeError('框架名称无效')
  if(typeof onError!=='function')throw new TypeError('onError 必须是函数')
  const report=message=>{try{onError(message)}catch{}}
  const engine=new GroupGuard(root,{now,fetcher,onError:report,helpImages:helpImages===undefined?createHelpImages({root}):helpImages,
    statusImage,statusTimeoutMs,updater,loginLink,runtime:framework})
  const adapters=new Map()
  const pending=new Set()
  let adminPromise,closing
  const assertOpen=()=>{if(closing||engine.closed)throw new Error('群管实例已关闭或正在停止')}
  function registerBot(botId){
    assertOpen();const key=id(botId)
    if(!adapters.has(key))adapters.set(key,new OneBotAdapter(async(action,params)=>{
      try{return await call(key,action,params)}
      catch(error){if(error instanceof OneBotError)throw error;throw new OneBotError('宿主框架接口调用失败，执行结果无法确认')}
    }))
    const adapter=adapters.get(key);engine.register(key,adapter);return adapter
  }
  function removeBot(botId){const key=id(botId);adapters.delete(key);engine.adapters.delete(key)}
  function handle(event){
    assertOpen()
    if(!event||typeof event!=='object'||Array.isArray(event))throw new TypeError('事件必须是对象')
    const work=engine.handle(event,registerBot(event.self_id))
    pending.add(work);work.then(()=>pending.delete(work),()=>pending.delete(work))
    return work
  }
  function openAdmin({host='127.0.0.1',port=15083,publicUrl=''}={}){
    assertOpen()
    if(!adminPromise){
      adminPromise=createAdminServer({root,store:engine.config,engine,host,port,publicUrl,onError:report})
      adminPromise.catch(()=>{if(!engine.closed)adminPromise=undefined})
    }
    return adminPromise
  }
  function close(){
    if(!closing){
      clearInterval(engine.timer);engine.timer=null
      closing=(async()=>{
        try{
          await Promise.allSettled([...pending])
          if(adminPromise)await adminPromise.then(admin=>admin.close(),()=>{})
        }finally{engine.close();adapters.clear()}
      })()
    }
    return closing
  }
  return Object.freeze({version,root,engine,registerBot,removeBot,handle,
    start(){assertOpen();engine.start()},openAdmin,close})
}
