/** Build-time only. Installed plugins read released JPEGs without rendering.
 * TRSS integration: inject renderer(request), a small adapter around the installed
 * Renderer.render API, returning JPEG/PNG bytes (or a local image filename).
 * CLI fallback: node scripts/render-help.mjs --browser "<Chrome or Edge executable>".
 * No packages are installed; a fresh, temporary browser profile is used and removed.
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import {fileURLToPath,pathToFileURL} from 'node:url'
import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
import {helpTopics} from '../lib/help-content.mjs'
import {jpegDimensions,sha256,sourceHash,helpLimits,createHelpImages} from '../lib/help-images.mjs'

const exec=promisify(execFile)
const escape=value=>String(value).replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]))
const literal=value=>"'"+value.replace(/'/g,"''")+"'"

async function convertWindows(input,output){
  if(process.platform!=='win32')throw new Error('PNG 转 JPEG 需要注入 convertToJpeg；也可令 TRSS 渲染器直接返回 JPEG')
  const code=`Add-Type -AssemblyName System.Drawing; $image=[System.Drawing.Image]::FromFile(${literal(input)}); try { $codec=[System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object MimeType -eq 'image/jpeg'; $params=New-Object System.Drawing.Imaging.EncoderParameters(1); $params.Param[0]=New-Object System.Drawing.Imaging.EncoderParameter([System.Drawing.Imaging.Encoder]::Quality, [long]90); $image.Save(${literal(output)},$codec,$params); $params.Dispose() } finally { $image.Dispose() }`
  await exec('powershell.exe',['-NoProfile','-NonInteractive','-Command',code],{windowsHide:true,timeout:20000,maxBuffer:1024*1024})
  return fs.readFileSync(output)
}

async function browserRender(browser,request,temp){
  const profile=path.join(temp,'profile-'+request.topic)
  const args=['--headless','--no-first-run','--no-default-browser-check','--disable-background-networking','--disable-extensions','--disable-gpu','--hide-scrollbars','--force-device-scale-factor=1','--user-data-dir='+profile,'--virtual-time-budget=1000']
  const {stdout}=await exec(browser,[...args,'--dump-dom',pathToFileURL(request.htmlPath).href],{windowsHide:true,timeout:20000,maxBuffer:2*1024*1024})
  const height=Number(stdout.match(/data-help-height="(\d+)"/)?.[1])
  if(!Number.isInteger(height)||height<100||height>helpLimits.height)throw new Error('帮助页面高度无法确认或超出限制')
  const png=path.join(temp,request.topic+'.png')
  await exec(browser,[...args,'--window-size=1080,'+(height+8),'--screenshot='+png,pathToFileURL(request.htmlPath).href],{windowsHide:true,timeout:20000,maxBuffer:2*1024*1024})
  return fs.readFileSync(png)
}

export async function renderHelp({root=fileURLToPath(new URL('..',import.meta.url)),version,renderer,browser,convertToJpeg}={}){
  if(renderer!==undefined&&typeof renderer!=='function')throw new TypeError('renderer 必须是 TRSS 渲染适配函数')
  if(!renderer&&(!browser||!fs.existsSync(browser)))throw new Error('请注入 TRSS Renderer.render 适配函数，或用 --browser 指定现有 Chrome/Edge 可执行文件')
  const base=fs.realpathSync(root)
  version??=JSON.parse(fs.readFileSync(path.join(base,'package.json'),'utf8')).version
  if(typeof version!=='string'||!version.trim()||version.length>80)throw new Error('帮助版本号无效')
  const temp=fs.mkdtempSync(path.join(os.tmpdir(),'groupguard-help-render-'))
  const template=fs.readFileSync(path.join(base,'resources/help-template.html'),'utf8')
  const manifest={version:1,hashAlgorithm:'sha256-lf-v1',cards:{},sources:['lib/help-content.mjs','resources/help-template.html'].map(file=>({file,sha256:sourceHash(fs.readFileSync(path.join(base,file)))}))}
  const outputs=[]
  try{
    for(const [topic,content] of Object.entries(helpTopics)){
      const groups=content.groups.map(group=>`<section><h2>${escape(group.title)}</h2>${group.items.map(item=>`<article><div class="command">${escape(item.command)}</div><div class="description">${escape(item.description)}</div>${item.permission?`<div class="permission">权限 · ${escape(item.permission)}</div>`:''}</article>`).join('')}</section>`).join('')
      const replacements={TITLE:content.title,SUBTITLE:content.subtitle,VERSION:version,FOOTER:content.footer}
      const html=template.replace(/\{\{(TITLE|SUBTITLE|VERSION|FOOTER)\}\}/g,(_,name)=>escape(replacements[name])).replace('{{GROUPS}}',groups)
      const htmlPath=path.join(temp,topic+'.html');fs.writeFileSync(htmlPath,html)
      const request={topic,page:1,html,htmlPath,width:1080,height:undefined,outputPath:path.join(temp,topic+'.jpg')}
      let rendered=renderer?await renderer(request):await browserRender(browser,request,temp)
      if(typeof rendered==='string')rendered=fs.readFileSync(rendered)
      if(rendered instanceof Uint8Array&&!Buffer.isBuffer(rendered))rendered=Buffer.from(rendered)
      if(!Buffer.isBuffer(rendered))throw new Error('渲染适配器必须返回 JPEG/PNG 字节或本地图片路径')
      let bytes=rendered
      if(!jpegDimensions(bytes)){
        const input=path.join(temp,topic+'-render.png');fs.writeFileSync(input,rendered)
        bytes=convertToJpeg?await convertToJpeg(rendered,request):await convertWindows(input,request.outputPath)
      }
      const size=jpegDimensions(bytes)
      if(!size||bytes.length>helpLimits.bytes||size.width>helpLimits.width||size.height>helpLimits.height||size.width*size.height>helpLimits.pixels)throw new Error('生成的 JPEG 格式、尺寸或大小不符合帮助读取约定')
      const file=`resources/help/${topic}-1.jpg`
      manifest.cards[topic]=[{file,sha256:sha256(bytes),...size}];outputs.push({file,bytes})
    }
    fs.mkdirSync(path.join(base,'resources/help'),{recursive:true})
    for(const {file,bytes} of outputs)fs.writeFileSync(path.join(base,file),bytes)
    const manifestFile=path.join(base,'resources/help/manifest.json'),pending=manifestFile+'.tmp'
    fs.writeFileSync(pending,JSON.stringify(manifest,null,2)+'\n');fs.renameSync(pending,manifestFile)
    if(!(await createHelpImages({root:base})({isMaster:true,privateChat:true})))throw new Error('生成后重新读取清单失败')
    return manifest
  }finally{
    // This directory was created by this invocation; never touch user profiles.
    fs.rmSync(temp,{recursive:true,force:true,maxRetries:4,retryDelay:250})
  }
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const browserIndex=process.argv.indexOf('--browser')
  const rendererIndex=process.argv.indexOf('--renderer')
  const renderer=rendererIndex>=0?(await import(pathToFileURL(path.resolve(process.argv[rendererIndex+1])).href)).render:undefined
  const manifest=await renderHelp({browser:browserIndex>=0?process.argv[browserIndex+1]:undefined,renderer})
  for(const [topic,pages] of Object.entries(manifest.cards))console.log(`${topic}: ${pages.map(page=>`${page.width}×${page.height}`).join(', ')}`)
}
