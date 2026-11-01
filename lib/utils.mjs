export function timeParts(now, timezone) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(now)).map(item => [item.type, item.value]))
  return {day: parts.year + '-' + parts.month + '-' + parts.day,
    month: parts.year + '-' + parts.month, time: parts.hour + ':' + parts.minute}
}

function chineseNumber(value) {
  if (/^\d+$/.test(value)) return Number(value)
  const digits = {零: 0, 一: 1, 壹: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9}
  const units = {十: 10, 百: 100, 千: 1000}
  let digit = 0, sum = 0
  for (const char of value) {
    if (Object.hasOwn(digits, char)) digit = digits[char]
    else if (Object.hasOwn(units, char)) { sum += (digit || 1) * units[char]; digit = 0 }
    else throw new Error('禁言时长不合法')
  }
  return sum + digit
}

export function duration(value) {
  const match = String(value).match(/^([\d零一壹二两三四五六七八九十百千]+)(秒|分|分钟|时|小时|天)?$/)
  if (!match) throw new Error('请使用 10分钟、2小时、1天这样的时长')
  const seconds = chineseNumber(match[1]) * {秒: 1, 分: 60, 分钟: 60, 时: 3600, 小时: 3600, 天: 86400}[match[2] || '分钟']
  if (!Number.isInteger(seconds) || seconds < 1 || seconds > 30 * 86400) throw new Error('禁言时间必须在1秒～30天之间')
  return seconds
}

export const textSegment = text => [{type: 'text', data: {text: String(text)}}]
export const replace = (text, values) => text.replace(/\{(\w+)\}/g, (match, key) => String(values[key] ?? match))

// Calendar arithmetic uses the already-local date, not elapsed 24-hour periods.
export const shiftDay = (day, amount) => new Date(Date.parse(day + 'T12:00:00Z') + amount * 86400000).toISOString().slice(0, 10)
export function shiftMonth(month, amount) {
  const [year, value] = month.split('-').map(Number)
  return new Date(Date.UTC(year, value - 1 + amount, 1)).toISOString().slice(0, 7)
}
