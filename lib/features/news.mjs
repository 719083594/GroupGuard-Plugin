function secrets(config){
  const values=new Set()
  const sources=Array.isArray(config?.newsSources)?config.newsSources:[]
  for(const s of sources){
    if(typeof s?.key==='string'&&s.key)values.add(s.key)
    collectUrl(s?.url,s?.authName,values)
  }
  collectUrl(config?.dailyApi,'',values)
  collectUrl(config?.legacy?.dailyApi,'',values)
  return [...values].sort((a,b)=>b.length-a.length)
}
function collectUrl(value,name,values){
  try{
    const u=new URL(value)
    for(const [k,v]of u.searchParams)if(v&&(k===name||/^(?:api[-_]?key|key|token|access[-_]?token|authorization|secret|password)$/i.test(k)))values.add(v)
  }catch{}
}
function hideSecrets(text,config){
  let result=String(text??'')
  for(const value of secrets(config)){
    const forms=new Set([value])
    try{
      for(const encoded of [encodeURIComponent(value),encodeURI(value)]){
        forms.add(encoded);forms.add(encoded.replace(/%[0-9A-F]{2}/g,x=>x.toLowerCase()))
        forms.add(encoded.replace(/%20/g,'+'))
      }
    }catch{}
    for(const form of [...forms].sort((a,b)=>b.length-a.length))result=result.split(form).join('[密钥已隐藏]')
  }
  return result
}
export function redact(text,config){
  // URLs in an exception are not needed to diagnose HTTP/shape/timeout failures.
  return hideSecrets(String(text??'').replace(/https?:\/\/[^\s<>"'`]+/gi,'[链接已隐藏]'),config)
}
function imageUrl(value,config){
  if(typeof value!=='string'||value.length>8192||/[\r\n\u0000]/.test(value))throw new Error('日报图片网址格式不合法')
  let u
  try{u=new URL(value)}catch{throw new Error('日报图片网址格式不合法')}
  if(!['http:','https:'].includes(u.protocol)||u.username||u.password||hideSecrets(value,config)!==value)throw new Error('日报图片网址格式不合法或包含接口凭据')
  return value
}

export async function fetchNews({store,botId,groupId,config,fetcher=fetch}){
  const c=config??store.read(),s=store.getNews(botId,groupId,c)
  if(!s)throw new Error('本群日报 API 未配置；请通过后续浏览器管理界面配置，该界面尚待对接。')
  if(s.authType!=='none'&&!s.key)throw new Error('本群日报鉴权 Key 未配置；请通过后续浏览器管理界面完善。')
  const url=new URL(s.url),headers={Accept:'application/json'}
  if(s.authType==='bearer')headers.Authorization=`Bearer ${s.key}`
  if(s.authType==='header')Object.defineProperty(headers,s.authName,{value:s.key,enumerable:true,writable:true,configurable:true})
  if(s.authType==='query')url.searchParams.set(s.authName,s.key)
  try{
    const res=await fetcher(url.href,{headers,redirect:'error',signal:AbortSignal.timeout(10000)})
    if(!res?.ok)throw new Error(`日报 API HTTP ${Number.isInteger(res?.status)?res.status:'未知'}`)
    const data=await res.json()
    if(!data||typeof data!=='object'||Array.isArray(data))throw new Error('日报 API 响应不是有效对象')
    const image=data.imageUrl||data.data?.image||data.data?.imageUrl
    if(image)return [{type:'image',data:{file:imageUrl(image,c)}}]
    const news=data.data?.news
    const text=data.text||data.data?.text||(Array.isArray(news)&&news.every(v=>typeof v==='string')?news.join('\n'):'')
    if(typeof text!=='string'||!text.trim())throw new Error('日报 API 应返回 imageUrl、data.image、text 或 data.news')
    return [{type:'text',data:{text:hideSecrets(text,c).slice(0,4000)}}]
  }catch(error){
    const message=error?.name==='TimeoutError'||error?.name==='AbortError'?'日报 API 请求超时':String(error?.message??error)
    throw new Error(redact(message,c))
  }
}
