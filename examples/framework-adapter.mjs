/** Generic host template; not an implemented adapter for a named framework. */
import {createGroupGuard} from '../api.mjs'

export function attachGroupGuard({root,name,call,subscribe,botIds=[],statusImage=null,onError=console.error}={}){
  if(typeof subscribe!=='function')throw new TypeError('宿主需提供 subscribe(handler)，并返回取消订阅函数')
  const guard=createGroupGuard({root,framework:name,call,statusImage,onError})
  let unsubscribe
  try{
    for(const botId of botIds)guard.registerBot(botId)
    unsubscribe=subscribe(event=>{
      try{Promise.resolve(guard.handle(event)).catch(onError)}catch(error){onError(error)}
    })
    if(typeof unsubscribe!=='function')throw new TypeError('subscribe 必须返回取消订阅函数')
    guard.start()
  }catch(error){guard.close().catch(()=>{});throw error}
  return {guard,async detach(){unsubscribe();await guard.close()}}
}
