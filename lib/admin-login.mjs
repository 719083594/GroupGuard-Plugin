import {createHash,randomBytes} from 'node:crypto'

const digest=token=>createHash('sha256').update(token).digest('hex')
export function adminPublicOrigin(value=''){
  if(value==='')return ''
  let url
  try{url=new URL(value)}catch{throw new Error('GROUPGUARD_ADMIN_PUBLIC_URL 必须是完整的 HTTPS 地址')}
  const local=['127.0.0.1','localhost','[::1]'].includes(url.hostname)
  if(!(url.protocol==='https:'||url.protocol==='http:'&&local)||url.username||url.password||url.pathname!=='/'||url.search||url.hash)throw new Error('网页登录地址使用 HTTPS 源地址；本机调试可用 HTTP 回环地址')
  return url.origin
}

/** Raw tickets only leave this store once, through the owner's private reply. */
export class LoginTickets{
  constructor({now=()=>Date.now()}={}){this.now=now;this.values=new Map()}
  clean(){for(const [key,value] of this.values)if(value.expires<=this.now())this.values.delete(key)}
  issue({principal,authorize,authStamp}){
    this.clean()
    if(typeof principal!=='string'||!principal||principal.length>128||/[\r\n\0]/.test(principal)||typeof authorize!=='function')throw new Error('登录凭据缺少主人验证')
    for(const [key,value] of this.values)if(value.principal===principal)this.values.delete(key)
    if(this.values.size>=64)throw new Error('登录链接暂时繁忙，请稍后重试')
    const token=randomBytes(32).toString('base64url')
    this.values.set(digest(token),{principal,authorize,authStamp,expires:this.now()+180000})
    return token
  }
  take(token){
    this.clean()
    if(typeof token!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(token))return null
    const key=digest(token),value=this.values.get(key)
    this.values.delete(key)
    return value||null
  }
  clear(){this.values.clear()}
}
