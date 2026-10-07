import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {GroupGuard,HELP} from '../lib/core.mjs'
import {OneBotAdapter} from '../lib/adapter.mjs'
import {createHelpImages} from '../lib/help-images.mjs'
import {helpTopics} from '../lib/help-content.mjs'

const jpeg=()=>Buffer.from([255,216,1,2,255,217])
const BOT='100000001',GROUP='200000001',MEMBER='300000001',MASTER='400000001'
function fixture(t,helpImages){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'groupguard-help-')),calls=[],replies=[]
  let now=10000
  const adapter=new OneBotAdapter(async(action,params)=>{
    calls.push({action,params})
    if(action==='send_group_msg'||action==='send_private_msg')replies.push(params.message)
    return {status:'ok',retcode:0,data:action==='get_group_member_info'?{role:'member'}:{message_id:1}}
  })
  const engine=new GroupGuard(root,{helpImages,now:()=>now,onError:()=>{}})
  engine.config.update(config=>{config.masters=[MASTER]})
  t.after(()=>{engine.close();fs.rmSync(root,{recursive:true,force:true})})
  return {engine,calls,replies,run:(msg,extra={})=>{now+=1100;return engine.handle({self_id:BOT,user_id:MEMBER,group_id:GROUP,msg,message:[],...extra},adapter)}}
}

test('公开固定帮助定义不含主人全局维护命令，独立主人页明确私聊',()=>{
  const publicText=JSON.stringify(helpTopics['groupguard-public'])
  const masterText=JSON.stringify(helpTopics['groupguard-master'])
  assert(publicText.includes('#群管帮助 文字'))
  for(const command of ['#群管全局','#群管群黑名单','#群管群白名单','#群管更新','#群管日志']){
    assert(!publicText.includes(command),command)
    assert(masterText.includes(command),command)
  }
  assert(masterText.includes('仅机器人主人私聊'))
  assert.deepEqual(Object.keys(helpTopics).sort(),['groupguard-master','groupguard-public'])
})

test('共享服务懒加载且只读固定topic；群内主人不能取得主人私聊页',async()=>{
  let loads=0,factories=0
  const requests=[]
  const read=createHelpImages({root:'public-source-root',loadService:async()=>{
    loads++
    return {createStaticHelpReader:options=>{
      factories++;assert.deepEqual(options,{root:'public-source-root'})
      return request=>{requests.push(request);return [jpeg()]}
    }}
  }})
  assert.equal(loads,0)
  await Promise.all([read({isMaster:true,privateChat:false,topic:'../../data/session.json'}),read({isMaster:false,privateChat:true})])
  assert.equal(loads,1);assert.equal(factories,1)
  assert.deepEqual(requests,[{topic:'groupguard-public',private:false},{topic:'groupguard-public',private:false}])
  requests.length=0
  const images=await read({isMaster:true,privateChat:true})
  assert.equal(images.length,2)
  assert.deepEqual(requests,[{topic:'groupguard-public',private:false},{topic:'groupguard-master',private:false}])
})

test('共享reader缺失或图片校验失败保留完整文字fallback，不触发渲染',async()=>{
  for(const loadService of [async()=>{throw new Error('missing sibling')},async()=>({}),async()=>({createStaticHelpReader:()=>()=>null}),async()=>({createStaticHelpReader:()=>()=>['/private/path.jpg']})]){
    assert.equal(await createHelpImages({root:'public-source-root',loadService})({}),null)
  }
})

test('帮助以OneBot内存图片发送，文字后缀跳过reader，非帮助命令不读图',async t=>{
  const contexts=[],f=fixture(t,async context=>{contexts.push(context);return [jpeg()]})
  await f.run('#群管帮助')
  assert.deepEqual(contexts,[{isMaster:false,privateChat:false}])
  assert.deepEqual(f.replies.at(-1),[{type:'image',data:{file:'base64://'+jpeg().toString('base64')}}])
  await f.run('#群管帮助 文字')
  assert.equal(contexts.length,1)
  assert.deepEqual(f.replies.at(-1),[{type:'text',data:{text:HELP}}])
  await f.run('#群卫帮助',{group_id:'',user_id:MASTER})
  assert.deepEqual(contexts.at(-1),{isMaster:true,privateChat:true})
  await f.run('#群管帮助',{user_id:MASTER})
  assert.deepEqual(contexts.at(-1),{isMaster:true,privateChat:false})
  await f.run('#群管版本')
  assert.equal(contexts.length,3)
  await f.run('#群管禁言 '+MASTER+' 1分钟')
  assert.equal(contexts.length,3)
  assert.equal(f.calls.some(call=>call.action==='set_group_ban'),false)
})

test('reader异常和无效图片路径均退回原HELP，不把路径交给OneBot',async t=>{
  for(const helpImages of [async()=>{throw new Error('private details')},async()=>['/private/account.jpg'],async()=>[Buffer.from('not an image')],async()=>Array.from({length:9},jpeg)]){
    const f=fixture(t,helpImages)
    await f.run('#群管帮助')
    assert.deepEqual(f.replies.at(-1),[{type:'text',data:{text:HELP}}])
    assert.equal(f.calls.some(call=>JSON.stringify(call.params).includes('/private/')),false)
  }
})
