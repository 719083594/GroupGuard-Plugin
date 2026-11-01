import fs from 'node:fs'
import path from 'node:path'
import {createHash} from 'node:crypto'

export const helpLimits=Object.freeze({pages:8,bytes:2*1024*1024,width:4096,height:12000,pixels:20_000_000})
export const sha256=buffer=>createHash('sha256').update(buffer).digest('hex')
export const sourceHash=buffer=>sha256(Buffer.from(String(buffer).replace(/\r\n?/g,'\n')))
const sources=new Set(['lib/help-content.mjs','resources/help-template.html'])
const hashPattern=/^[a-f0-9]{64}$/
const samePath=(a,b)=>process.platform==='win32'?a.toLowerCase()===b.toLowerCase():a===b

export function jpegDimensions(bytes) {
  if(!Buffer.isBuffer(bytes)||bytes.length<12||bytes[0]!==255||bytes[1]!==216||bytes.at(-2)!==255||bytes.at(-1)!==217)return null
  let offset=2
  while(offset+3<bytes.length){
    if(bytes[offset++]!==255)return null
    while(bytes[offset]===255)offset++
    const marker=bytes[offset++]
    if(marker===0xDA||marker===0xD9)return null
    if(marker===0x01||(marker>=0xD0&&marker<=0xD7))continue
    if(offset+2>bytes.length)return null
    const length=bytes.readUInt16BE(offset)
    if(length<2||offset+length>bytes.length)return null
    if([0xC0,0xC1,0xC2,0xC3,0xC5,0xC6,0xC7,0xC9,0xCA,0xCB,0xCD,0xCE,0xCF].includes(marker)){
      if(length<8)return null
      const height=bytes.readUInt16BE(offset+3),width=bytes.readUInt16BE(offset+5)
      return width&&height?{width,height}:null
    }
    offset+=length
  }
  return null
}

function localFile(root,relative,maxBytes){
  if(typeof relative!=='string'||relative.includes('\\')||relative.split('/').some(part=>part==='..'||part==='.'||!part)||path.isAbsolute(relative))throw new Error('HELP_PATH')
  const file=path.resolve(root,...relative.split('/'))
  if(!file.startsWith(root+path.sep)||!samePath(fs.realpathSync(file),file)||fs.lstatSync(file).isSymbolicLink())throw new Error('HELP_PATH')
  const stat=fs.statSync(file)
  if(!stat.isFile()||stat.size>maxBytes)throw new Error('HELP_SIZE')
  return fs.readFileSync(file)
}

// Read only this plugin's released assets. Every call rechecks source freshness.
export function createHelpImages({root}={}){
  if(typeof root!=='string'||!root)throw new TypeError('INVALID_HELP_READER')
  return async function helpImages({isMaster=false,privateChat=false}={}){
    try{
      const base=fs.realpathSync(root)
      const manifest=JSON.parse(localFile(base,'resources/help/manifest.json',64*1024).toString('utf8'))
      if(manifest.version!==1||manifest.hashAlgorithm!=='sha256-lf-v1'||!manifest.cards||!Array.isArray(manifest.sources)||manifest.sources.length!==sources.size)return null
      const seen=new Set()
      for(const source of manifest.sources){
        if(!source||!sources.has(source.file)||seen.has(source.file)||!hashPattern.test(source.sha256))return null
        seen.add(source.file)
        if(sourceHash(localFile(base,source.file,256*1024))!==source.sha256)return null
      }
      for(const topic of ['groupguard-public','groupguard-master']){
        const pages=manifest.cards[topic]
        if(!Array.isArray(pages)||!pages.length||pages.length>helpLimits.pages)return null
        const files=new Set()
        for(const page of pages){
          if(!page||!new RegExp('^resources/help/'+topic+'-[1-9]\\d*\\.jpe?g$').test(page.file)||files.has(page.file)||!hashPattern.test(page.sha256))return null
          files.add(page.file)
          if(!Number.isInteger(page.width)||!Number.isInteger(page.height)||page.width<1||page.height<1||page.width>helpLimits.width||page.height>helpLimits.height||page.width*page.height>helpLimits.pixels)return null
        }
      }
      const topics=['groupguard-public']
      if(isMaster===true&&privateChat===true)topics.push('groupguard-master')
      const pages=topics.flatMap(topic=>manifest.cards[topic])
      if(pages.length>helpLimits.pages)return null
      const images=[]
      for(const page of pages){
        const bytes=localFile(base,page.file,helpLimits.bytes),size=jpegDimensions(bytes)
        if(sha256(bytes)!==page.sha256||!size||size.width!==page.width||size.height!==page.height)return null
        images.push(bytes)
      }
      return images
    }catch{return null}
  }
}
