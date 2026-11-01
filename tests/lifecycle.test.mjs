import test from 'node:test'
import assert from 'node:assert/strict'
import {EventEmitter} from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {spawn,spawnSync} from 'node:child_process'
import {attachShutdown} from '../lib/lifecycle.mjs'

const stateUrl=new URL('../lib/state.mjs',import.meta.url).href
const lifecycleUrl=new URL('../lib/lifecycle.mjs',import.meta.url).href
function rootFor(t){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'groupguard-lifecycle-'))
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}))
  return root
}

test('signal cleanup precedes existing framework handlers and preserves their exit control',()=>{
  const events=new EventEmitter(),order=[],forwarded=[]
  events.exitCode=17
  const framework=()=>order.push('framework'),frameworkExit=code=>order.push('exit:'+code)
  events.on('SIGTERM',framework);events.on('exit',frameworkExit)
  attachShutdown({close(){order.push('cleanup')}},{events,terminate:sig=>forwarded.push(sig)})
  events.emit('SIGTERM')
  assert.deepEqual(order,['cleanup','framework']);assert.deepEqual(forwarded,[])
  assert.deepEqual(events.listeners('SIGTERM'),[framework]);assert.deepEqual(events.listeners('exit'),[frameworkExit])
  events.emit('exit',9);assert.deepEqual(order,['cleanup','framework','exit:9']);assert.equal(events.exitCode,17)
})

for(const sig of ['SIGINT','SIGTERM'])test(`${sig} without framework handler is forwarded once after cleanup and own listener removal`,()=>{
  const events=new EventEmitter(),order=[],foreign=()=>{}
  const other=sig==='SIGINT'?'SIGTERM':'SIGINT'
  events.on(other,foreign)
  attachShutdown({close(){order.push('cleanup')}},{events,terminate:value=>{
    assert.equal(events.listenerCount(sig),0);assert.equal(events.listenerCount('exit'),0)
    order.push(value)
  }})
  events.emit(sig);events.emit(sig);events.emit('exit',1)
  assert.deepEqual(order,['cleanup',sig]);assert.deepEqual(events.listeners(other),[foreign])
})

test('exit cleanup is synchronous, only once, and does not forward a signal or remove foreign handlers',()=>{
  const events=new EventEmitter(),order=[]
  const foreign=()=>order.push('foreign-exit')
  events.on('exit',foreign)
  attachShutdown({close(){order.push('cleanup')}},{events,terminate:()=>assert.fail('exit must not forward')})
  events.emit('exit',23)
  assert.deepEqual(order,['cleanup','foreign-exit'])
  events.emit('SIGTERM');assert.deepEqual(order,['cleanup','foreign-exit'])
  assert.deepEqual(events.listeners('exit'),[foreign])
})

test('duplicate attachment and unregister are idempotent and never affect other listeners',()=>{
  const events=new EventEmitter(),engine={close(){assert.fail('unregistered cleanup must not run')}}
  const foreign=()=>{},options={events,terminate:()=>assert.fail('must not terminate')}
  events.on('SIGINT',foreign);events.on('SIGTERM',foreign);events.on('exit',foreign)
  const unregister=attachShutdown(engine,options)
  assert.equal(attachShutdown(engine,options),unregister)
  for(const name of ['exit','SIGINT','SIGTERM'])assert.equal(events.listenerCount(name),2)
  unregister();unregister()
  for(const name of ['exit','SIGINT','SIGTERM'])assert.deepEqual(events.listeners(name),[foreign])
  events.emit('exit');events.emit('SIGINT');events.emit('SIGTERM')
})

test('manual close wrapper can detach lifecycle before closing, with repeated close remaining harmless',()=>{
  const events=new EventEmitter();let closes=0,closed=false,unregister=()=>{}
  const engine={close(){unregister();if(closed)return;closed=true;closes++}}
  unregister=attachShutdown(engine,{events,terminate:()=>assert.fail('manual close must not terminate')})
  engine.close();engine.close();events.emit('exit');events.emit('SIGTERM')
  assert.equal(closes,1)
  for(const name of ['exit','SIGINT','SIGTERM'])assert.equal(events.listenerCount(name),0)
})

test('cleanup failure cannot interrupt a framework handler or disclose the thrown content',()=>{
  const events=new EventEmitter(),order=[],warnings=[]
  events.emitWarning=(message,options)=>warnings.push({message,options})
  events.on('SIGINT',()=>order.push('framework'))
  attachShutdown({close(){order.push('cleanup');throw new Error('synthetic-private-config-value')}},{events,terminate:()=>assert.fail('framework owns exit')})
  assert.doesNotThrow(()=>events.emit('SIGINT'))
  assert.deepEqual(order,['cleanup','framework']);assert.equal(warnings.length,1)
  assert.equal(warnings[0].options.code,'GROUPGUARD_CLEANUP_FAILED')
  assert.equal(JSON.stringify(warnings).includes('synthetic-private-config-value'),false)
})

test('invalid lifecycle contracts are rejected without registering listeners',()=>{
  const events=new EventEmitter()
  assert.throws(()=>attachShutdown({}, {events}),TypeError)
  assert.throws(()=>attachShutdown({close(){}},{events:{}}),TypeError)
  assert.equal(events.eventNames().length,0)
})

test('actual child process.exit preserves its code and releases its StateStore lock',t=>{
  const root=rootFor(t)
  const script=`import {StateStore} from ${JSON.stringify(stateUrl)};import {attachShutdown} from ${JSON.stringify(lifecycleUrl)};const store=new StateStore(${JSON.stringify(root)});attachShutdown({close(){store.close()}});process.exit(23)`
  const child=spawnSync(process.execPath,['--input-type=module','-e',script],{cwd:root,encoding:'utf8',timeout:5000,maxBuffer:64*1024})
  assert.equal(child.error,undefined);assert.equal(child.status,23,child.stderr)
  assert.equal(fs.existsSync(path.join(root,'data/state.json')),true)
  assert.equal(fs.existsSync(path.join(root,'data/.groupguard.lock')),false)
})

test('actual POSIX child SIGTERM releases its lock and retains default signal termination',{
  skip:process.platform==='win32'?'Windows does not provide POSIX default SIGTERM forwarding semantics':false,
  timeout:10000
},async t=>{
  const root=rootFor(t)
  const script=`import {StateStore} from ${JSON.stringify(stateUrl)};import {attachShutdown} from ${JSON.stringify(lifecycleUrl)};const store=new StateStore(${JSON.stringify(root)});attachShutdown({close(){store.close()}});setInterval(()=>{},1000);console.log('ready')`
  const child=spawn(process.execPath,['--input-type=module','-e',script],{cwd:root,stdio:['ignore','pipe','pipe']})
  const exited=new Promise((resolve,reject)=>{child.on('error',reject);child.on('exit',(code,signal)=>resolve({code,signal}))})
  t.after(()=>{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL')})
  await new Promise((resolve,reject)=>{
    child.stdout.once('data',chunk=>chunk.toString().includes('ready')?resolve():reject(new Error('child did not announce readiness')))
    child.once('error',reject);child.once('exit',()=>reject(new Error('child exited before readiness')))
  })
  child.kill('SIGTERM')
  const result=await exited
  assert.equal(result.code,null);assert.equal(result.signal,'SIGTERM')
  assert.equal(fs.existsSync(path.join(root,'data/.groupguard.lock')),false)
})
