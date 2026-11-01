import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import {createHelpImages,jpegDimensions,sha256,sourceHash} from '../lib/help-images.mjs'
import {helpTopics,publicHelpText,masterHelpText} from '../lib/help-content.mjs'

// Minimal SOF metadata fixture; production assets are rendered and visually checked.
const jpeg=(width=10,height=20)=>Buffer.from([255,216,255,192,0,11,8,height>>8,height&255,width>>8,width&255,1,1,0x11,0,255,217])
function fixture(t){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'groupguard-help-'))
  fs.mkdirSync(path.join(root,'lib'));fs.mkdirSync(path.join(root,'resources/help'),{recursive:true})
  fs.writeFileSync(path.join(root,'lib/help-content.mjs'),'// fixture\n')
  fs.writeFileSync(path.join(root,'resources/help-template.html'),'<html>fixture</html>\n')
  const manifest={version:1,hashAlgorithm:'sha256-lf-v1',cards:{},sources:['lib/help-content.mjs','resources/help-template.html'].map(file=>({file,sha256:sourceHash(fs.readFileSync(path.join(root,file)))}))}
  for(const topic of ['groupguard-public','groupguard-master']){
    const bytes=jpeg(),file=`resources/help/${topic}-1.jpg`;fs.writeFileSync(path.join(root,file),bytes)
    manifest.cards[topic]=[{file,sha256:sha256(bytes),width:10,height:20}]
  }
  const save=()=>fs.writeFileSync(path.join(root,'resources/help/manifest.json'),JSON.stringify(manifest))
  save();t.after(()=>fs.rmSync(root,{recursive:true,force:true}))
  return {root,manifest,save,read:createHelpImages({root})}
}

test('最终公开/主人文字和固定卡片一致，旧入口不再被展示',()=>{
  const publicText=publicHelpText('2.0.0'),masterText=masterHelpText('2.0.0')
  for(const command of ['#群管今日榜','#群管昨日榜','#群管月榜','引用后发送 撤回','赞我','100 赞'])assert(publicText.includes(command),command)
  for(const command of ['#群管全局','#群管群黑名单','#群管群白名单','#群管更新','#群管日志']){assert(!publicText.includes(command));assert(masterText.includes(command))}
  for(const removed of ['群卫','发言日榜','发言月榜','#群管赞我','#确认加群','#拒绝加群','scheduledMute','autoBlacklistOnLeave'])assert(!JSON.stringify(helpTopics).includes(removed),removed)
  assert(masterText.includes('仅机器人主人私聊'));assert(masterText.includes('masters'))
})

test('本插件静态读取，只有布尔主人且私聊才附加主人页',async t=>{
  const f=fixture(t)
  assert.equal((await f.read({})).length,1)
  assert.equal((await f.read({isMaster:true,privateChat:false})).length,1)
  assert.equal((await f.read({isMaster:false,privateChat:true})).length,1)
  assert.equal((await f.read({isMaster:'true',privateChat:true})).length,1)
  assert.equal((await f.read({isMaster:true,privateChat:true})).length,2)
  assert.equal((await f.read({topic:'../../data/state.json'})).length,1)
})

test('来源哈希忽略CRLF差异，但内容变化立即使现有reader失效',async t=>{
  const f=fixture(t)
  fs.writeFileSync(path.join(f.root,'lib/help-content.mjs'),'// fixture\r\n')
  assert.equal((await f.read()).length,1)
  fs.appendFileSync(path.join(f.root,'lib/help-content.mjs'),'// changed\n')
  assert.equal(await f.read(),null)
})

test('图片损坏、尺寸不符、路径越界、私有页混入公开页均降级',async t=>{
  const cases=[
    f=>{fs.writeFileSync(path.join(f.root,f.manifest.cards['groupguard-public'][0].file),'broken')},
    f=>{f.manifest.cards['groupguard-public'][0].width=11},
    f=>{f.manifest.cards['groupguard-public'][0].file='resources/help/../../data/state.json'},
    f=>{f.manifest.cards['groupguard-public'][0]={...f.manifest.cards['groupguard-master'][0]}},
    f=>{f.manifest.sources[0].file='config/local.json'},
    f=>{f.manifest.cards['groupguard-public']=Array.from({length:9},()=>({...f.manifest.cards['groupguard-public'][0]}))},
    f=>{const page=f.manifest.cards['groupguard-public'][0],bytes=Buffer.alloc(2*1024*1024+1);fs.writeFileSync(path.join(f.root,page.file),bytes);page.sha256=sha256(bytes)}
  ]
  for(const change of cases){const f=fixture(t);change(f);f.save();assert.equal(await f.read({isMaster:true,privateChat:true}),null)}
})

test('缺清单、缺模板与无效JPEG均只返回null，不外泄路径',async t=>{
  const f=fixture(t)
  fs.unlinkSync(path.join(f.root,'resources/help-template.html'));assert.equal(await f.read(),null)
  assert.equal(await createHelpImages({root:path.join(f.root,'missing')})(),null)
  for(const bytes of [Buffer.from('not jpeg'),Buffer.from([255,216,255,217])])assert.equal(jpegDimensions(bytes),null)
})

test('目录链接不能绕过来源文件真实路径校验',async t=>{
  const f=fixture(t),linked=path.join(f.root,'lib'),actual=path.join(f.root,'other-lib')
  fs.renameSync(linked,actual)
  try{fs.symlinkSync(actual,linked,process.platform==='win32'?'junction':'dir')}
  catch(error){if(['EPERM','EACCES','ENOTSUP'].includes(error.code)){t.skip('host does not permit test directory links');return}throw error}
  assert.equal(await f.read(),null)
})

test('发布资产自包含、两张JPEG均通过来源/哈希/尺寸校验',async()=>{
  const root=fileURLToPath(new URL('..',import.meta.url)),read=createHelpImages({root})
  const images=await read({isMaster:true,privateChat:true})
  assert(images&&images.length===2,'run scripts/render-help.mjs after changing help content/template')
  for(const bytes of images){const dimensions=jpegDimensions(bytes);assert.equal(dimensions.width,1080);assert(dimensions.height>500)}
})
