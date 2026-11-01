import fs from 'node:fs'
import path from 'node:path'
import {id,GLOBAL_CHAT_FIELDS,GROUP_CHAT_FIELDS} from '../config.mjs'
import {redact} from './news.mjs'
export const settingsMethods={
  parseValue(text,current){
    text=text.trim()
    if(typeof current==='boolean'){if(['开','true','开启','1'].includes(text))return true;if(['关','false','关闭','0'].includes(text))return false;throw new Error('开关值请用 开/关')}
    if(typeof current==='number'){if(!/^\d+$/.test(text))throw new Error('请输入整数');return Number(text)}
    if(Array.isArray(current)){const v=JSON.parse(text);if(!Array.isArray(v))throw new Error('请输入 JSON 数组');return v}
    return text
  },
  async globalCommand(e,a,c,cmd,args){
    if(cmd==='全局'){
      const split=args.indexOf(' ');if(split<0)throw new Error('用法：#群管全局 字段 值')
      const field=args.slice(0,split)
      if(!GLOBAL_CHAT_FIELDS.has(field))throw new Error('未知/受保护字段，masters 请在本地配置')
      const value=this.parseValue(args.slice(split+1),c[field]);this.config.update(c=>{c[field]=value});this.audit(e,'global',field);this.trySave();await this.notify(e,a,`全局 ${field} 已保存`);return
    }
    if(cmd==='群黑名单'||cmd==='群白名单'){
      const field=cmd==='群黑名单'?'blackGroups':'whiteGroups'
      if(!args){await this.notify(e,a,`${cmd}：${c[field].join('、')||'空'}`);return}
      const m=args.match(/^(添加|删除)\s+(\d+)$/);if(!m)throw new Error('用法：#群管群黑名单/群白名单 添加/删除 群号');const target=id(m[2])
      this.config.update(c=>{c[field]=m[1]==='添加'?[...new Set([...c[field].map(String),target])]:c[field].filter(x=>String(x)!==target)});this.audit(e,cmd,args);this.trySave();await this.notify(e,a,`${cmd}已${m[1]} ${target}`);return
    }
    if(cmd==='日志'){await this.notify(e,a,redact(this.state.audit.slice(-20).map(x=>`${new Date(x.time).toISOString()} ${x.action} 群${x.group} ${x.detail}`).join('\n')||'暂无日志',c));return}
    if(cmd==='更新日志'){await this.notify(e,a,fs.readFileSync(path.join(this.root,'CHANGELOG.md'),'utf8').slice(0,3500));return}
    const update=this.updater||(await import('../update.mjs')).update
    await this.notify(e,a,await update(this.root))
  },
  async groupSetting(e,a,c,g,args){
    await this.permission(e,a,c)
    const split=args.indexOf(' ')
    if(split<0)throw new Error('用法：#群管设置 字段 值')
    const field=args.slice(0,split)
    if(!GROUP_CHAT_FIELDS.has(field))throw new Error('未知或受保护字段；新闻 API/Key 请在浏览器管理界面维护')
    const value=this.parseValue(args.slice(split+1),g[field])
    this.config.setGroup(e.self_id,e.group_id,x=>{x[field]=value})
    this.audit(e,'setting',field);this.trySave()
    await this.notify(e,a,'已保存 '+field+'，立即生效')
  },
  async memberList(e,a,c,g,cmd,args){
    await this.permission(e,a,c)
    const field=cmd==='黑名单'?'blackUsers':'whiteUsers'
    if(!args){await this.notify(e,a,cmd+'：'+(g[field].join('、')||'空'));return}
    const match=args.match(/^(添加|删除)\s+(\d+)$/)
    if(!match)throw new Error('用法：#群管'+cmd+' 添加/删除 QQ')
    const target=id(match[2])
    this.config.setGroup(e.self_id,e.group_id,x=>{x[field]=match[1]==='添加'?[...new Set([...x[field].map(String),target])]:x[field].filter(value=>String(value)!==target)})
    this.audit(e,cmd,match[1]);this.trySave();await this.notify(e,a,cmd+'已'+match[1]+' '+target)
  }
}
