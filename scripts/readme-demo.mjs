/** Offline HTML preview using synthetic accounts and the real local core. */
import fs from 'node:fs'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import {GroupGuard} from '../lib/core.mjs'
import {OneBotAdapter} from '../lib/adapter.mjs'

const project=fileURLToPath(new URL('..',import.meta.url))
const args=process.argv.slice(2)
if(args.includes('--help')){
  console.log('node scripts/readme-demo.mjs [--out <离线HTML路径>]\n默认输出 .test-tmp/readme-demo.html；不启动HTTP服务，不连接QQ。')
  process.exit(0)
}
if(args.length&&!(args.length===2&&args[0]==='--out'&&args[1]))throw new Error('用法：node scripts/readme-demo.mjs [--out <离线HTML路径>]')
const output=path.resolve(args[1]||path.join(project,'.test-tmp','readme-demo.html'))
const tempParent=path.resolve(process.env.README_DEMO_TMP||path.join(project,'.test-tmp'))
fs.mkdirSync(tempParent,{recursive:true})
const root=fs.mkdtempSync(path.join(tempParent,'groupguard-readme-'))
let engine
let now=Date.parse('2026-11-01T02:00:00Z'),counter=100
const BOT='100000001',GROUP='200000001',ADMIN='300000001',USER='300000002'
const members={[BOT]:{role:'admin'},[ADMIN]:{role:'owner'},[USER]:{role:'member'}}
const replies=[],scenes=[],actions=[]
const adapter=new OneBotAdapter(async(action,params)=>{
  actions.push(action)
  if(action==='get_group_member_info')return {status:'ok',retcode:0,data:members[String(params.user_id)]}
  if(action==='send_group_msg'||action==='send_private_msg'){
    replies.push(params.message.map(segment=>segment.data?.text||'').join(''))
    return {status:'ok',retcode:0,data:{message_id:++counter}}
  }
  throw new Error('离线演示不允许外部动作：'+action)
})
try{
  engine=new GroupGuard(root,{now:()=>now,onError:()=>{},fetcher:async()=>{throw new Error('离线演示禁止网络请求')}})
  engine.config.setGroup(BOT,GROUP,group=>{group.enabled=true})
  async function command(title,label,msg,user=ADMIN){
    now+=1500
    const before=replies.length
    const handled=await engine.handle({self_id:BOT,group_id:GROUP,user_id:user,post_type:'message',msg,message_id:++counter,message:[],sender:{nickname:label}},adapter)
    const reply=replies.slice(before).join('\n')
    if(!handled||!reply)throw new Error('演示命令没有产生可核对的回复：'+msg)
    scenes.push({title,label,command:msg,reply})
  }
  await command('开启欢迎提示','群主','#群管设置 welcomeEnabled 开')
  await command('自定义欢迎语','群主','#群管设置 welcomeMessage 欢迎 {name} 加入本群！')
  await command('普通成员权限保护','普通成员','#群管设置 rankLimit 15',USER)
  await command('调整批量撤回上限','群主','#群管设置 recallLimit 10')
  const settings=engine.config.group(BOT,GROUP)
  if(!settings.welcomeEnabled||settings.recallLimit!==10||settings.rankLimit!==10)throw new Error('离线示例的配置或权限结果不符合预期')
  if(actions.some(action=>!['get_group_member_info','send_group_msg','send_private_msg'].includes(action)))throw new Error('离线演示出现未授权动作')
}finally{
  try{engine?.close()}finally{
    // Resolve and verify the one directory created by this invocation before removal.
    const resolved=path.resolve(root)
    if(path.dirname(resolved)!==tempParent||!path.basename(resolved).startsWith('groupguard-readme-'))throw new Error('临时目录范围校验失败，未清理')
    fs.rmSync(resolved,{recursive:true,force:true})
  }
}
const escape=value=>String(value).replace(/[&<>"]/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[char]))
const html=`<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>GroupGuard 2.0 · 离线模拟示例</title>
<style>
*{box-sizing:border-box}body{margin:0;background:#0b1720;color:#e5eff2;font-family:"Microsoft YaHei",sans-serif}
main{max-width:1150px;margin:auto;padding:38px 30px}header{border-bottom:1px solid #29404a;padding-bottom:20px}
h1{font-size:32px;margin:8px 0}p{color:#a5bdc7;line-height:1.7}.badge{color:#80eed3;font-size:13px}
.scenes{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:20px;margin:26px 0}
article{background:#11232d;border:1px solid #29404a;border-radius:16px;overflow:hidden}
h2{font-size:15px;margin:0;padding:15px 20px;background:#162e38}.chat{padding:20px}
.who{font-size:12px;color:#a7bdc7;margin-bottom:8px}.bubble{border-radius:10px;padding:14px 16px;line-height:1.7;white-space:pre-wrap;overflow-wrap:anywhere}
.user{background:#235244;color:#dcfff3;margin-left:20px;margin-bottom:20px}.bot{background:#1b3340;border:1px solid #2c4b56;margin-right:20px}
footer{font-size:12px;color:#9ab3bc;line-height:1.7}@media(max-width:700px){.scenes{grid-template-columns:1fr}main{padding:24px 16px}h1{font-size:26px}}
</style></head><body><main><header><div class="badge">GROUPGUARD 2.0 / OFFLINE PREVIEW</div>
<h1>群内配置与权限示例</h1><p>离线 HTML · 合成账号 · 本地核心实际回复。未连接 QQ，未启动任何服务。</p></header>
<div class="scenes">${scenes.map((scene,index)=>`<article><h2>${index+1}. ${escape(scene.title)}</h2><div class="chat">
<div class="who">${escape(scene.label)} · 虚构身份</div><div class="bubble user">${escape(scene.command)}</div>
<div class="who">GroupGuard · 本地模拟适配器</div><div class="bubble bot">${escape(scene.reply)}</div></div></article>`).join('')}</div>
<footer>回复由 lib/core.mjs 在临时目录运行生成，聊天排版仅作示例。没有调用真实管理、新闻或点赞接口；普通成员修改配置的请求在本地被拒绝。运行后仅保存本 HTML，临时配置和状态已清理。</footer>
</main></body></html>`
fs.mkdirSync(path.dirname(output),{recursive:true})
fs.writeFileSync(output,html,'utf8')
console.log('离线HTML已保存：'+output)
