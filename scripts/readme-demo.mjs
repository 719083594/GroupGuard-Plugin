/** Real GroupGuard replies in a fictional group; every adapter action is local. */
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {GroupGuard} from '../lib/core.mjs'
import {OneBotAdapter} from '../lib/adapter.mjs'

const tempParent=path.resolve(process.env.README_DEMO_TMP||os.tmpdir())
const root=fs.mkdtempSync(path.join(tempParent,'groupguard-readme-'))
let now=Date.parse('2026-10-09T02:00:00Z'),counter=100
const BOT='100000001',GROUP='200000001',ADMIN='300000001',USER='300000002'
const members={[BOT]:{role:'admin'},[ADMIN]:{role:'owner'},[USER]:{role:'member'}}
const replies=[],scenes=[],actions=[]
const adapter=new OneBotAdapter(async(action,params)=>{
  actions.push(action)
  if(action==='get_group_member_info')return {status:'ok',retcode:0,data:members[String(params.user_id)]}
  if(action==='send_group_msg'||action==='send_private_msg'){replies.push(params.message.map(s=>s.data?.text||'').join(''));return {status:'ok',retcode:0,data:{message_id:++counter}}}
  throw new Error(`No external actions allowed: ${action}`)
})
const engine=new GroupGuard(root,{now:()=>now,fetcher:async()=>{throw new Error('Network disabled in README demo')}})
engine.config.update(c=>Object.assign(c,{groups:[{botId:BOT,groupId:GROUP,enabled:true}]}))
async function command(label,msg,user=ADMIN){
  now+=1500
  const before=replies.length
  await engine.handle({self_id:BOT,group_id:GROUP,user_id:user,post_type:'message',msg,message_id:++counter,message:[],sender:{nickname:label}},adapter)
  scenes.push({label,command:msg,reply:replies.slice(before).join('\n')})
}
await command('管理员','#群管设置 welcomeEnabled 开')
await command('管理员','#群管设置 welcomeMessage 欢迎来到橙汁小站！')
await command('普通成员','#群管设置 scheduledMute 开',USER)
await command('管理员','#群管设置 muteTime 23:00')
engine.close()
if(actions.some(a=>!['get_group_member_info','send_group_msg','send_private_msg'].includes(a)))throw new Error('Unexpected action')
if(path.dirname(root)!==tempParent||!path.basename(root).startsWith('groupguard-readme-'))throw new Error('Unexpected temporary path')
fs.rmSync(root,{recursive:true,force:true})
const escape=s=>String(s).replace(/[&<>\"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]))
const html=`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>GroupGuard · 模拟群演示</title><style>
*{box-sizing:border-box}body{margin:0;background:#0b1720;color:#e5eff2;font-family:"Microsoft YaHei",sans-serif}.page{max-width:1250px;margin:auto;padding:44px 48px}.kicker{font-size:12px;letter-spacing:3px;font-weight:700;color:#5addc0}.head{display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid #263b42;padding-bottom:24px}h1{font-size:34px;letter-spacing:-1px;margin:10px 0}p{color:#9bb1bc;line-height:1.7;margin:8px 0}.badge{border:1px solid #35665c;background:#13352e;color:#80eed3;padding:9px 14px;border-radius:99px;font-size:13px}.scenes{display:grid;grid-template-columns:1fr 1fr;gap:22px;margin:26px 0}.scene{background:#11232d;border:1px solid #29404a;border-radius:18px;overflow:hidden}.scene-title{padding:15px 20px;background:#162e38;color:#b5d5d7;font-size:13px;display:flex;justify-content:space-between}.chat{padding:22px}.who{font-size:12px;color:#94abb5;margin-bottom:8px}.bubble{border-radius:12px;padding:15px 18px;font-size:16px;line-height:1.6;white-space:pre-wrap;overflow-wrap:anywhere}.user{background:#235244;color:#dcfff3;margin-left:34px;margin-bottom:22px}.bot{background:#1b3340;border:1px solid #2c4b56;color:#e6f4f6;margin-right:24px}.bot-label{color:#70dfc4}.foot{display:flex;justify-content:space-between;gap:30px;font-size:12px;color:#8da9b4}.dot{color:#5de0b9}.index{color:#68e2c1;letter-spacing:1px}
</style><div class="page"><div class="head"><div><div class="kicker">GROUPGUARD / COMMAND PREVIEW</div><h1>群聊事务，一句指令。</h1><p>即时调整配置 · 明确核查权限 · 每个群独立管理</p></div><div class="badge">模拟群演示 · 真实核心回复</div></div><div class="scenes">${scenes.map((s,i)=>`<section class="scene"><div class="scene-title"><span>${['开启欢迎提示','自定义欢迎语','成员权限保护','设置定时参数'][i]}</span><span class="index">0${i+1}</span></div><div class="chat"><div class="who">${escape(s.label)} · 虚构身份</div><div class="bubble user">${escape(s.command)}</div><div class="who bot-label">GroupGuard</div><div class="bubble bot">${escape(s.reply)}</div></div></section>`).join('')}</div><div class="foot"><span><span class="dot">●</span> 回复由 lib/core.mjs 实际运行生成；聊天排版仅为展示包装。</span><span>本地模拟适配器 · 未连接 QQ · 未执行真实群操作</span></div></div></html>`
http.createServer((req,res)=>{res.setHeader('Content-Type','text/html; charset=utf-8');res.end(html)}).listen(Number(process.env.README_DEMO_PORT||48884),'127.0.0.1',()=>console.log('Read-only demo: http://127.0.0.1:'+Number(process.env.README_DEMO_PORT||48884)))
