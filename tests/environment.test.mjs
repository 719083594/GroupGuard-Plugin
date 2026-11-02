import test from 'node:test'
import assert from 'node:assert/strict'
import {environmentHints} from '../lib/environment.mjs'

test('环境识别只返回提示，不改变环境或默认监听地址',()=>{
  const env={}
  const info=environmentHints({exists:file=>file==='/.dockerenv',read:()=>'',env})
  assert.deepEqual(info,{container:true,adminEnabled:true,host:'127.0.0.1',port:15083,needsHostSetup:true})
  assert.deepEqual(env,{})
})
test('cgroup 提示与显式设置、关闭管理服务均保留',()=>{
  const info=environmentHints({exists:()=>false,read:()=>'/docker/synthetic',env:{GROUPGUARD_ADMIN_HOST:'0.0.0.0',GROUPGUARD_ADMIN_PORT:'15100',GROUPGUARD_ADMIN_ENABLED:'0'}})
  assert.equal(info.container,true)
  assert.equal(info.needsHostSetup,false)
  assert.equal(info.adminEnabled,false)
  assert.equal(info.port,15100)
})
test('普通环境和不可读 cgroup 不应被判断成容器',()=>{
  const info=environmentHints({exists:()=>false,read:()=>{throw new Error('not available')},env:{}})
  assert.equal(info.container,false)
  assert.equal(info.needsHostSetup,false)
})
