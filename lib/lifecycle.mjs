const registrations=new WeakMap()

// Run only synchronous cleanup. Preserve framework signal handlers and exit codes.
export function attachShutdown(engine,{events=process,terminate=sig=>process.kill(process.pid,sig)}={}){
  if(!engine||typeof engine.close!=='function')throw new TypeError('退出清理需要可关闭的实例')
  if(!events||typeof events.prependOnceListener!=='function'||typeof events.removeListener!=='function'||typeof events.listenerCount!=='function'||typeof terminate!=='function')throw new TypeError('退出事件接口无效')
  const existing=registrations.get(engine)
  if(existing)return existing
  let active=true,cleaned=false
  const warn=code=>{try{events.emitWarning?.('GroupGuard 同步退出清理未完整完成，请检查原实例状态',{code})}catch{}}
  const cleanup=()=>{
    if(cleaned)return
    cleaned=true
    try{engine.close()}catch{warn('GROUPGUARD_CLEANUP_FAILED')}
  }
  function unregister(){
    if(!active)return
    active=false
    events.removeListener('exit',onExit)
    events.removeListener('SIGINT',onInterrupt)
    events.removeListener('SIGTERM',onTerminate)
    if(registrations.get(engine)===unregister)registrations.delete(engine)
  }
  function onExit(){cleanup();unregister()}
  function signal(sig){
    // prependOnceListener has removed this listener before invocation. Count the
    // remaining handlers before close(), which may unregister its own hooks.
    const frameworkHandlesSignal=events.listenerCount(sig)>0
    cleanup();unregister()
    if(!frameworkHandlesSignal){
      try{terminate(sig)}catch{warn('GROUPGUARD_SIGNAL_FORWARD_FAILED')}
    }
  }
  function onInterrupt(){signal('SIGINT')}
  function onTerminate(){signal('SIGTERM')}
  events.prependOnceListener('exit',onExit)
  events.prependOnceListener('SIGINT',onInterrupt)
  events.prependOnceListener('SIGTERM',onTerminate)
  registrations.set(engine,unregister)
  return unregister
}
