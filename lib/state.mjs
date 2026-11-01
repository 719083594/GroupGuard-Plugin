import fs from 'node:fs'
import path from 'node:path'
import {randomUUID} from 'node:crypto'
import {atomic} from './config.mjs'
import {timeParts} from './utils.mjs'

const object = value => value && typeof value === 'object' && !Array.isArray(value)

// One writer owns the persistent ledger. A crash leaves conservative reservations.
export class StateStore {
  constructor(root, {now = Date.now(), timezone = 'Asia/Shanghai', legacyInstall = false} = {}) {
    this.directory = path.join(root, 'data')
    this.file = path.join(this.directory, 'state.json')
    this.lockFile = path.join(this.directory, '.groupguard.lock')
    this.token = randomUUID()
    fs.mkdirSync(this.directory, {recursive: true})
    this.acquire()
    try {
      const existed = fs.existsSync(this.file)
      const old = existed ? JSON.parse(fs.readFileSync(this.file, 'utf8')) : {}
      if (!object(old)) throw new Error('群管状态格式无效，已停止读取，原文件保留')
      if (old.schemaVersion !== undefined && ![1, 2].includes(old.schemaVersion)) throw new Error('不支持此状态版本，原文件保留')
      for (const key of ['groups', 'jobs', 'likes', 'requests', 'operations', 'exits']) if (old[key] !== undefined && !object(old[key])) throw new Error('群管状态字段无效：' + key)
      for (const key of ['pending', 'audit']) if (old[key] !== undefined && !Array.isArray(old[key])) throw new Error('群管状态字段无效：' + key)
      if (old.exits) for (const record of Object.values(old.exits)) if (!object(record) || !Number.isFinite(record.at) ||
        !['preparing', 'pending', 'success', 'failed', 'unknown'].includes(record.status)) throw new Error('自动退群防重记录无效，原文件保留')
      if (old.likes) for (const days of Object.values(old.likes)) {
        if (!object(days)) throw new Error('点赞账本格式无效，原文件保留')
        for (const [day, budget] of Object.entries(days)) {
          if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !object(budget) || !Number.isInteger(budget.used) ||
            budget.used < 0 || budget.used > 100 || budget.used % 10 || !object(budget.users) ||
            Object.keys(budget.users).length * 10 !== budget.used) throw new Error('点赞账本额度无效，原文件保留')
          for (const record of Object.values(budget.users)) if (!object(record) ||
            !['reserved', 'sent', 'success', 'failed', 'unknown'].includes(record.status) ||
            record.count !== 10 || !Number.isFinite(record.time)) throw new Error('点赞账本记录无效，原文件保留')
        }
      }
      this.value = {groups: {}, pending: [], jobs: {}, audit: [], likes: {}, requests: {}, ...old}
      if (old.schemaVersion !== 2) {
        if (existed) {
          const backup = path.join(this.directory, 'state.schema-v1.backup.json')
          if (!fs.existsSync(backup)) fs.copyFileSync(this.file, backup, fs.constants.COPYFILE_EXCL)
        }
        if (existed || legacyInstall) this.value.likeMigrationBlockedDay = timeParts(now, timezone).day
        this.value.schemaVersion = 2
        this.save()
      }
    } catch (error) { this.close(); throw error }
  }

  acquire() {
    if (fs.existsSync(this.lockFile)) {
      let owner
      try { owner = JSON.parse(fs.readFileSync(this.lockFile, 'utf8')) } catch { throw new Error('群管状态锁无效，请核对原进程；没有覆盖数据') }
      if (!Number.isSafeInteger(owner.pid) || owner.pid < 1) throw new Error('群管状态锁无效')
      let alive = true
      try { process.kill(owner.pid, 0) } catch (error) { if (error.code === 'ESRCH') alive = false }
      if (alive) throw new Error('群管已有状态写入进程，拒绝启动第二个写入者')
      const latest = JSON.parse(fs.readFileSync(this.lockFile, 'utf8'))
      if (latest.token !== owner.token || latest.pid !== owner.pid) throw new Error('群管状态锁正在变化，停止启动')
      fs.unlinkSync(this.lockFile)
    }
    const handle = fs.openSync(this.lockFile, 'wx', 0o600)
    try { fs.writeFileSync(handle, JSON.stringify({pid: process.pid, token: this.token})) }
    finally { fs.closeSync(handle) }
  }

  save(value = this.value) {
    const owner = JSON.parse(fs.readFileSync(this.lockFile, 'utf8'))
    if (owner.token !== this.token) throw new Error('群管状态写入锁已变化，停止保存')
    atomic(this.file, value)
  }

  close() {
    if (!fs.existsSync(this.lockFile)) return
    try {
      const owner = JSON.parse(fs.readFileSync(this.lockFile, 'utf8'))
      if (owner.token === this.token) fs.unlinkSync(this.lockFile)
    } catch {}
  }
}
