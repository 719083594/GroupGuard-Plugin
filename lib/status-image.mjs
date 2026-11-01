// Framework-free adapter for one fixed TRSS template. It never reads image paths.
export const STATUS_IMAGE_MAX_BYTES=2*1024*1024
export const STATUS_RENDER_NAME='GroupGuard-Plugin/status'
const TEMPLATE_SAVE_ID='status'
const SHARED_STATE=Symbol.for('GroupGuard-Plugin.status-image.render-state.v1')
const PNG_SIGNATURE=Buffer.from([137,80,78,71,13,10,26,10])
const PNG_END=Buffer.from([0,0,0,0,73,69,78,68,174,66,96,130])

function renderState(){
  if(!globalThis[SHARED_STATE])Object.defineProperty(globalThis,SHARED_STATE,{value:{busy:false}})
  return globalThis[SHARED_STATE]
}

/** Accept bytes or inline base64 only; copy before the shared template is unlocked. */
export function normalizeStatusImage(value){
  let bytes
  if(Buffer.isBuffer(value)){
    if(value.length>STATUS_IMAGE_MAX_BYTES)return null
    bytes=Buffer.from(value)
  }else if(value instanceof Uint8Array){
    if(value.byteLength>STATUS_IMAGE_MAX_BYTES)return null
    bytes=Buffer.from(value)
  }else if(typeof value==='string'){
    if(value.length>Math.ceil(STATUS_IMAGE_MAX_BYTES*4/3)+128)return null
    let encoded=value
    if(encoded.startsWith('base64://'))encoded=encoded.slice(9)
    else if(encoded.startsWith('data:image/png;base64,'))encoded=encoded.slice(22)
    encoded=encoded.replace(/\s/g,'')
    if(!encoded||encoded.length%4===1||!(/^[A-Za-z0-9+/]+={0,2}$/).test(encoded))return null
    bytes=Buffer.from(encoded,'base64')
    if(bytes.toString('base64').replace(/=+$/,'')!==encoded.replace(/=+$/,''))return null
  }else return null
  if(bytes.length<45||bytes.length>STATUS_IMAGE_MAX_BYTES||
    !bytes.subarray(0,8).equals(PNG_SIGNATURE)||
    bytes.readUInt32BE(8)!==13||bytes.toString('ascii',12,16)!=='IHDR'||
    !bytes.readUInt32BE(16)||!bytes.readUInt32BE(20)||
    !bytes.subarray(-12).equals(PNG_END))return null
  return bytes
}

/**
 * render(name, data) is supplied by the entry point. A busy request returns null:
 * no queue, no template overwrite, and no parallel screenshot after a caller timeout.
 * A renderer that hangs keeps this slot until its actual promise settles; later
 * requests can immediately use text without accumulating background work.
 */
export function createStatusImageRenderer({render,tplFile}={}){
  if(typeof render!=='function')throw new TypeError('STATUS_RENDER_FUNCTION_REQUIRED')
  if(typeof tplFile!=='string'||!tplFile)throw new TypeError('STATUS_TEMPLATE_REQUIRED')
  return async function statusImage(html){
    if(typeof html!=='string'||!html.trim()||Buffer.byteLength(html,'utf8')>1024*1024)return null
    const state=renderState()
    if(state.busy)return null
    state.busy=true
    try{
      const result=await render(STATUS_RENDER_NAME,{
        tplFile,saveId:TEMPLATE_SAVE_ID,imgType:'png',multiPage:false,omitBackground:false,
        pageGotoParams:{waitUntil:'load',timeout:6500},html
      })
      return normalizeStatusImage(result)
    }finally{state.busy=false}
  }
}
