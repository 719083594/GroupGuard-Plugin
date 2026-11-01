import test from 'node:test'
import assert from 'node:assert/strict'
import {MAIN_COMMANDS,COMMAND_DEFINITIONS,parseCommand,commandMessage,commandRules} from '../lib/command.mjs'

test('正式命令白名单与半角斜杠入口一致，参数不损坏模板内部空白',()=>{
  for(const name of MAIN_COMMANDS)for(const prefix of ['#','/'])assert.deepEqual(parseCommand(`  ${prefix}群管${name}  `),{name,args:''})
  assert.deepEqual(parseCommand('#群管设置 welcomeMessage 欢迎  {name}！'),{name:'设置',args:'welcomeMessage 欢迎  {name}！'})
  assert.deepEqual(parseCommand('/群管帮助 文字'),{name:'帮助',args:'文字'})
  assert.equal(new Set(COMMAND_DEFINITIONS.flatMap(row=>row.names)).size,MAIN_COMMANDS.length)
})

test('指定简写、裸赞我与带引用裸撤回仅按明确边界匹配',()=>{
  for(const prefix of ['','#','/'])for(const name of ['禁言','解禁'])assert.deepEqual(parseCommand(`${prefix}${name} 123456789 10分钟`),{name,args:'123456789 10分钟'})
  assert.deepEqual(parseCommand(' 赞我 '),{name:'赞我',args:''})
  assert.deepEqual(parseCommand(' 撤回 ',{replyId:'123',groupId:'200000001'}),{name:'撤回',args:''})
  for(const options of [{},{replyId:'123'},{groupId:'200000001'}])assert.equal(parseCommand('撤回',options),null)
  for(const input of ['快来赞我','赞我 10','撤回一下','#撤回','/撤回','引用撤回'])assert.equal(parseCommand(input,{replyId:'123',groupId:'200000001'}),null,input)
})

test('取消的入口不能经规范化、别名或模糊前缀重新进入',()=>{
  const removed=['#群管','/群管','#确认加群','#拒绝加群','/确认加群','确认加群','#群管发言日榜','/群管发言月榜','#群管赞我','/群管赞我','#赞我','/赞我','#群管未知','#群管今日榜额外文字']
  for(const prefix of ['#','/','＃','／'])for(const suffix of ['','帮助','帮助 文字','禁言 123456789','全局 inviteMode accept'])removed.push(prefix+'群卫'+suffix)
  for(const prefix of ['＃','／'])for(const name of MAIN_COMMANDS)removed.push(prefix+'群管'+name)
  removed.push('＃禁言 123456789','／解禁 123456789')
  for(const input of removed){
    assert.equal(parseCommand(' '+input+' ',{replyId:'123',groupId:'200000001'}),null,input)
    assert.equal(commandMessage(' '+input+' '),' '+input+' ',input)
  }
})

test('规范字符串不恢复停用入口，规则不包含框架主人预拦截',()=>{
  assert.equal(commandMessage('/群管今日榜'),'#群管今日榜')
  assert.equal(commandMessage(' /禁言 123456789 10分钟 '),'#群管禁言 123456789 10分钟')
  assert.equal(commandMessage(' 赞我 '),'赞我')
  const rules=commandRules()
  assert.equal(rules.some(rule=>rule.permission==='master'),false)
  for(const name of MAIN_COMMANDS)assert.equal(rules.some(rule=>rule.reg.test('/群管'+name)),true,name)
  for(const input of ['#群卫帮助','＃群管状态','／群管帮助','#群管','#确认加群','#群管赞我','#赞我','#群管发言日榜'])assert.equal(rules.some(rule=>rule.reg.test(input)),false,input)
})
