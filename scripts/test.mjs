import fs from 'node:fs'
import {fileURLToPath} from 'node:url'
import {spawnSync} from 'node:child_process'

// Do not let Node recursively discover copied tests in .test-tmp or backups.
// Passing explicit files also avoids shell glob differences on Node 20/Windows.
const tests=new URL('../tests/',import.meta.url)
const files=fs.readdirSync(tests,{withFileTypes:true})
  .filter(entry=>entry.isFile()&&entry.name.endsWith('.test.mjs'))
  .map(entry=>fileURLToPath(new URL(entry.name,tests)))
  .sort()
if(!files.length)throw new Error('未找到 tests/*.test.mjs，未运行测试')
const result=spawnSync(process.execPath,['--test',...files],{stdio:'inherit',cwd:fileURLToPath(new URL('..',import.meta.url))})
if(result.error)throw result.error
process.exitCode=result.status??1
