import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
const exec=promisify(execFile)
export async function update(root){
  const run=(...args)=>exec('git',['-c','safe.directory='+root,'-C',root,...args],{timeout:30000,maxBuffer:1024*1024})
  const remote=(await run('remote','get-url','origin')).stdout.trim()
  if(remote!=='https://github.com/719083594/GroupGuard-Plugin.git')throw new Error('只允许从群卫官方 origin 更新；ZIP 安装请替换发布包')
  if((await run('status','--porcelain')).stdout.trim())throw new Error('源码有未提交改动，已停止更新。请先备份并同步本地和 GitHub')
  const result=await run('pull','--ff-only','origin','main')
  return `群卫更新完成，请主人重启机器人使源码生效。配置与数据已保留。\n${result.stdout.trim()}`
}
