import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {renderHelp} from '../scripts/render-help.mjs'

function fixture(t){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'groupguard-help-version-'))
  fs.mkdirSync(path.join(root,'resources/help'),{recursive:true});fs.mkdirSync(path.join(root,'lib'))
  for(const name of ['resources/help-template.html','lib/help-content.mjs'])fs.copyFileSync(new URL('../'+name,import.meta.url),path.join(root,name))
  fs.writeFileSync(path.join(root,'package.json'),JSON.stringify({version:'7.8.9'}))
  const images={}
  for(const topic of ['groupguard-public','groupguard-master'])images[topic]=fs.readFileSync(new URL('../resources/help/'+topic+'-1.jpg',import.meta.url))
  const requests=[]
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}))
  return {root,requests,renderer:async request=>{requests.push(request);return images[request.topic]}}
}

test('帮助制作默认将目标package版本交给渲染器，不回退旧角标',async t=>{
  const f=fixture(t);await renderHelp(f)
  assert.equal(f.requests.length,2)
  for(const request of f.requests)assert.ok(request.html.includes('7.8.9'))
})

test('帮助制作仍允许显式版本覆盖，且真实读取生成资源清单',async t=>{
  const f=fixture(t),manifest=await renderHelp({...f,version:'6.5.4'})
  for(const request of f.requests){assert.ok(request.html.includes('6.5.4'));assert.ok(!request.html.includes('7.8.9'))}
  assert.equal(Object.keys(manifest.cards).length,2)
  assert.ok(fs.existsSync(path.join(f.root,'resources/help/manifest.json')))
})
