import fs from 'node:fs'

// Indicators only: do not grant Docker access or change a listener automatically.
export function environmentHints({exists=fs.existsSync,read=file=>fs.readFileSync(file,'utf8'),env=process.env}={}) {
  let container=exists('/.dockerenv')||exists('/run/.containerenv')
  if(!container){try{container=/docker|containerd|kubepods|libpod/.test(read('/proc/1/cgroup'))}catch{}}
  const host=env.GROUPGUARD_ADMIN_HOST||'127.0.0.1'
  return {container,adminEnabled:env.GROUPGUARD_ADMIN_ENABLED!=='0',host,port:Number(env.GROUPGUARD_ADMIN_PORT||15083),needsHostSetup:container&&['127.0.0.1','localhost','::1'].includes(host)}
}
