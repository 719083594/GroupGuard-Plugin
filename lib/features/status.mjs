import {buildStatusSnapshot,buildStatusText,buildStatusHtml} from '../status-view.mjs'

const MAX_IMAGE=2*1024*1024
const PNG=Buffer.from([137,80,78,71,13,10,26,10])
const SOF=new Set([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf])

export function isStatusImage(value){
  if(!Buffer.isBuffer(value)||value.length>MAX_IMAGE||value.length<12)return false
  if(value.subarray(0,8).equals(PNG)){
    let offset=8,first=true,image=false
    while(offset+12<=value.length){
      const length=value.readUInt32BE(offset),type=value.toString('ascii',offset+4,offset+8)
      if(length>value.length-offset-12)return false
      if(first){
        if(type!=='IHDR'||length!==13||!value.readUInt32BE(offset+8)||!value.readUInt32BE(offset+12))return false
        first=false
      }
      if(type==='IDAT'&&length>0)image=true
      offset+=length+12
      if(type==='IEND')return length===0&&image&&offset===value.length
    }
    return false
  }
  if(value[0]!==255||value[1]!==216||value.at(-2)!==255||value.at(-1)!==217)return false
  let offset=2,frame=false
  while(offset+4<=value.length){
    if(value[offset++]!==255)return false
    while(value[offset]===255)offset++
    const marker=value[offset++]
    if(offset+2>value.length-2)return false
    const length=value.readUInt16BE(offset)
    if(length<2||offset+length>value.length-2)return false
    if(SOF.has(marker)){
      if(length<8||!value.readUInt16BE(offset+3)||!value.readUInt16BE(offset+5))return false
      frame=true
    }
    if(marker===0xda)return frame&&length>=6&&offset+length<value.length-2
    offset+=length
  }
  return false
}

export async function renderStatusImage(renderer,html,{timeoutMs=8000}={}){
  const delay=Number.isFinite(timeoutMs)?Math.max(1,Math.min(8000,timeoutMs)):8000
  let timer
  const rendering=Promise.resolve().then(()=>renderer(html))
  try{
    return await Promise.race([rendering,new Promise((_,reject)=>{
      timer=setTimeout(()=>{const error=new Error('STATUS_IMAGE_TIMEOUT');error.code='STATUS_IMAGE_TIMEOUT';reject(error)},delay)
    })])
  }finally{clearTimeout(timer)}
}

export const statusMethods={
  async showStatus(e,a,c,g,args=''){
    await this.permission(e,a,c)
    const bot=await a.member(e.group_id,e.self_id)
    const snapshot=buildStatusSnapshot({version:this.version,config:c,group:g,role:bot?.role,
      newsConfigured:!!this.config.getNews(e.self_id,e.group_id,c),now:this.now(),groupId:e.group_id})
    const fallback=()=>this.notify(e,a,buildStatusText(snapshot))
    if(args==='文字'||typeof this.statusImage!=='function'){await fallback();return true}
    let image
    try{
      image=await renderStatusImage(this.statusImage,buildStatusHtml(snapshot),{timeoutMs:this.statusTimeoutMs})
      if(!isStatusImage(image)){this.onError('[GroupGuard] STATUS_IMAGE_INVALID');await fallback();return true}
    }catch(error){
      this.onError('[GroupGuard] '+(error?.code==='STATUS_IMAGE_TIMEOUT'?'STATUS_IMAGE_TIMEOUT':'STATUS_IMAGE_RENDER_FAILED'))
      await fallback();return true
    }
    try{await this.reply(e,a,[{type:'image',data:{file:'base64://'+image.toString('base64')}}])}
    catch{this.onError('[GroupGuard] STATUS_IMAGE_SEND_FAILED');await fallback()}
    return true
  }
}
