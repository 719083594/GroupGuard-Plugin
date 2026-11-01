import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {fileURLToPath,pathToFileURL} from 'node:url'
import {createStatusImageRenderer,normalizeStatusImage,STATUS_IMAGE_MAX_BYTES,STATUS_RENDER_NAME} from '../lib/status-image.mjs'
import {renderStatusImage} from '../lib/features/status.mjs'

const PNG=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jq1kAAAAASUVORK5CYII=','base64')
const source=fileURLToPath(new URL('..',import.meta.url))
const create=render=>createStatusImageRenderer({render,tplFile:'/synthetic/plugin/resources/status.html'})
const gate=()=>{let release;const promise=new Promise(resolve=>{release=resolve});return {promise,release}}

test('normalization copies PNG Buffer/Uint8Array and strict inline base64, never accepts file paths',()=>{
  for(const value of [PNG,new Uint8Array(PNG),PNG.toString('base64'),'base64://'+PNG.toString('base64'),'data:image/png;base64,'+PNG.toString('base64')]){
    const output=normalizeStatusImage(value)
    assert.equal(Buffer.isBuffer(output),true)
    assert.deepEqual(output,PNG)
    if(Buffer.isBuffer(value))assert.notEqual(output,value)
  }
  for(const value of [null,false,{},[PNG],'/app/temp/status.png','file:///app/temp/status.png','https://example.invalid/status.png','base64://not-base64!','data:image/jpeg;base64,'+PNG.toString('base64'),PNG.subarray(0,24),PNG.subarray(0,-1),Buffer.alloc(STATUS_IMAGE_MAX_BYTES+1)]){
    assert.equal(normalizeStatusImage(value),null)
  }
  const malformed=Buffer.from(PNG);malformed.writeUInt32BE(0,16)
  assert.equal(normalizeStatusImage(malformed),null)
})

test('adapter uses evidenced TRSS PNG parameters and returns independent bytes before unlocking',async()=>{
  const calls=[],shared=Buffer.from(PNG)
  const renderer=create(async(name,data)=>{calls.push({name,data});return shared})
  const html='<html><body id="container">synthetic status A</body></html>'
  const output=await renderer(html)
  assert.equal(calls.length,1)
  assert.equal(calls[0].name,STATUS_RENDER_NAME)
  assert.deepEqual(calls[0].data,{
    tplFile:'/synthetic/plugin/resources/status.html',saveId:'status',imgType:'png',multiPage:false,omitBackground:false,
    pageGotoParams:{waitUntil:'load',timeout:6500},html
  })
  assert.equal(Object.hasOwn(calls[0].data,'path'),false)
  assert.equal(Object.hasOwn(calls[0].data,'quality'),false)
  shared.fill(0)
  assert.deepEqual(output,PNG)
})

test('fixed template busy slot is shared across renderer factories and never queues competing snapshots',async()=>{
  const waiting=gate(),calls=[]
  const first=create(async(name,data)=>{calls.push(data.html);await waiting.promise;return PNG})
  const second=create(async(name,data)=>{calls.push(data.html);return PNG})
  const work=first('<html>snapshot A</html>')
  try{
    assert.equal(await second('<html>snapshot B</html>'),null)
    assert.deepEqual(calls,['<html>snapshot A</html>'])
  }finally{waiting.release();await work}
  assert.deepEqual(await second('<html>snapshot C</html>'),PNG)
  assert.deepEqual(calls,['<html>snapshot A</html>','<html>snapshot C</html>'])
})

test('caller timeout keeps the real render busy until it settles; later requests fall back immediately',async()=>{
  const waiting=gate();let calls=0,completed
  const renderer=create(async()=>{
    calls++
    if(calls===1)await waiting.promise
    return PNG
  })
  const rendering=renderer('<html>late A</html>')
  completed=rendering
  await assert.rejects(renderStatusImage(()=>rendering,'synthetic',{timeoutMs:15}),error=>error.code==='STATUS_IMAGE_TIMEOUT')
  let timer
  try{
    const busy=await Promise.race([
      renderer('<html>must not queue B</html>'),
      new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('busy request queued')),100)})
    ])
    assert.equal(busy,null)
    assert.equal(calls,1)
  }finally{clearTimeout(timer);waiting.release();await completed}
  assert.deepEqual(await renderer('<html>fresh C</html>'),PNG)
  assert.equal(calls,2)
})

test('busy slot remains process-shared even if the adapter module is imported under a different URL',async()=>{
  const other=await import(new URL('../lib/status-image.mjs?independent-test-copy',import.meta.url))
  const waiting=gate();let secondary=0
  const work=create(async()=>{await waiting.promise;return PNG})('<html>A</html>')
  try{
    const second=other.createStatusImageRenderer({render:async()=>{secondary++;return PNG},tplFile:'/synthetic/other/status.html'})
    assert.equal(await second('<html>B</html>'),null)
    assert.equal(secondary,0)
  }finally{waiting.release();await work}
})

test('render rejection and invalid results release the slot; invalid HTML does not invoke the renderer',async()=>{
  let calls=0
  const renderer=create(async()=>{
    calls++
    if(calls===1)throw new Error('synthetic renderer unavailable')
    if(calls===2)return '/app/temp/not-accepted.png'
    return PNG
  })
  assert.equal(await renderer(''),null)
  assert.equal(await renderer(null),null)
  assert.equal(await renderer('x'.repeat(1024*1024+1)),null)
  assert.equal(calls,0)
  await assert.rejects(renderer('<html>one</html>'),/synthetic renderer unavailable/)
  assert.equal(await renderer('<html>two</html>'),null)
  assert.deepEqual(await renderer('<html>three</html>'),PNG)
  assert.equal(calls,3)
})

test('TRSS entry loads without a renderer installation and actual status command safely falls back to text',async t=>{
  const tempParent=path.resolve(os.tmpdir()),temporary=fs.mkdtempSync(path.join(tempParent,'gg-status-entry-'))
  const pluginRoot=path.join(temporary,'plugins','GroupGuard-Plugin')
  fs.mkdirSync(path.join(pluginRoot,'config'),{recursive:true})
  for(const name of ['lib','resources'])fs.cpSync(path.join(source,name),path.join(pluginRoot,name),{recursive:true})
  for(const name of ['index.js','package.json','CHANGELOG.md'])fs.copyFileSync(path.join(source,name),path.join(pluginRoot,name))
  fs.copyFileSync(path.join(source,'config/default.json'),path.join(pluginRoot,'config/default.json'))
  const previous=globalThis.plugin
  const signalCounts=new Map(['exit','SIGINT','SIGTERM'].map(event=>[event,process.listenerCount(event)]))
  globalThis.plugin=class {constructor(options){Object.assign(this,options)}}
  let entry
  t.after(()=>{
    entry?.engine.close()
    if(previous===undefined)delete globalThis.plugin;else globalThis.plugin=previous
    if(path.dirname(path.resolve(temporary))!==tempParent||!path.basename(temporary).startsWith('gg-status-entry-'))throw new Error('unexpected fixture cleanup path')
    fs.rmSync(temporary,{recursive:true,force:true})
  })
  entry=await import(pathToFileURL(path.join(pluginRoot,'index.js')).href)
  for(const [event,count]of signalCounts)assert.equal(process.listenerCount(event),count+1,event+' cleanup listener registered')
  assert.equal(fs.existsSync(path.join(temporary,'lib','renderer','loader.js')),false)
  const sent=[]
  const bot={uin:100000001,async sendApi(action,params){
    if(action==='get_group_member_info')return {status:'ok',retcode:0,data:{role:'admin'}}
    if(action==='send_group_msg'){sent.push(params.message);return {status:'ok',retcode:0,data:{message_id:900}}}
    throw new Error('unexpected synthetic action '+action)
  }}
  const commands=new entry.GroupGuardCommands()
  assert.equal(await commands.accept({bot,self_id:100000001,user_id:300000001,group_id:200000001,message_id:501,msg:'#群管状态',message:[]}),true)
  assert.equal(sent.length,1)
  assert.equal(sent[0].every(segment=>segment.type==='text'),true)
  const text=sent[0].map(segment=>segment.data.text).join('')
  assert.match(text,/本群：/)
  assert.match(text,/机器人：/)
  assert.equal(text.includes('ERR_MODULE_NOT_FOUND'),false)
  entry.engine.close()
  for(const [event,count]of signalCounts)assert.equal(process.listenerCount(event),count,event+' cleanup listener removed by manual close')
})

test('template only forwards the trusted full HTML, and generic adapter has no framework or filesystem imports',()=>{
  assert.equal(fs.readFileSync(new URL('../resources/status.html',import.meta.url),'utf8').trim(),'{{@ html}}')
  const adapter=fs.readFileSync(new URL('../lib/status-image.mjs',import.meta.url),'utf8')
  assert.doesNotMatch(adapter,/from\s+['"].*(?:renderer|plugins\/plugin|node:fs)|import\s*\(/)
  const entry=fs.readFileSync(new URL('../index.js',import.meta.url),'utf8')
  assert.match(entry,/await import\(['"]\.\.\/\.\.\/lib\/renderer\/loader\.js['"]\)/)
})
