'use strict'

/**
 * 余额 + 用量服务（仅主进程使用）
 *
 * - 余额：DeepSeek 官方 API  GET https://api.deepseek.com/user/balance
 *   （可用 apiKeyOverride / balanceUrl 覆盖，兼容 new-api/one-api 风格的 quota 结构）
 * - 用量：解析 ~/.dsh/sessions/<工作区>/<session>/session.jsonl(.zstd)
 *   DSH 会话日志是“拼接 zstd 帧”容器：逐帧扫描 + node:zlib 内建 zstd 解码。
 *   用量事件按 (turn, step) 只取最后一次采样（与官方 token-meter 口径一致），
 *   再按本地日期聚合为天桶。
 */

const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const https = require('node:https')
const { zstdDecompressSync } = require('node:zlib')

const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const CREDENTIALS_FILE = path.join(DSH_HOME, '.credentials.yaml')
const SESSIONS_DIR = path.join(DSH_HOME, 'sessions')
const DEFAULT_BALANCE_URL = 'https://api.deepseek.com/user/balance'
const PLATFORM_USAGE_URL = 'https://platform.deepseek.com/usage'
const ZSTD_MAGIC = 0xfd2fb528
const DAY_MS = 24 * 3600 * 1000

// 计费单价（每百万 tokens，人民币元）。默认取 DeepSeek 官方公开价（deepseek-chat 档）作为估算基准，
// 用户可在设置中修改；金额均为「估算值」，以平台账单为准。
const DEFAULT_PRICES = { input: 2, output: 8, cacheRead: 0.5, cacheWrite: 2 }

/* ---------------- 凭据 ---------------- */

function readCredentialKey() {
  try {
    const text = fs.readFileSync(CREDENTIALS_FILE, 'utf8')
    const m = text.match(/^DEEPSEEK_API_KEY:\s*["']?([^\s"'#]+)/m)
    return m ? m[1] : ''
  } catch {
    return ''
  }
}

/* ---------------- HTTP ---------------- */

function httpGetJson(url, headers, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false
    const done = (value) => { if (!settled) { settled = true; resolve(value) } }
    let req
    try {
      req = https.get(url, { headers, timeout: timeoutMs }, (res) => {
        let body = ''
        res.on('data', (c) => {
          body += c
          if (body.length > 1000000) { req.destroy(); done({ error: '响应过大' }) }
        })
        res.on('end', () => {
          if (res.statusCode < 200 || res.statusCode >= 300) { done({ error: `HTTP ${res.statusCode}` }); return }
          try { done(JSON.parse(body)) } catch { done({ error: '响应不是 JSON' }) }
        })
      })
      req.on('error', (e) => done({ error: e.message }))
      req.on('timeout', () => { req.destroy(); done({ error: '请求超时' }) })
    } catch (e) {
      done({ error: e.message })
    }
  })
}

/* ---------------- 余额 ---------------- */

async function fetchBalance(cfg) {
  const url = (cfg && cfg.balanceUrl) || DEFAULT_BALANCE_URL
  const key = (cfg && cfg.apiKeyOverride) || readCredentialKey()
  if (!key) {
    return { ok: false, error: '未找到 API Key（~/.dsh/.credentials.yaml 中没有 DEEPSEEK_API_KEY）', at: Date.now() }
  }
  const data = await httpGetJson(url, { Authorization: `Bearer ${key}`, Accept: 'application/json' }, 10000)
  if (data.error) return { ok: false, error: data.error, at: Date.now() }

  // DeepSeek 官方结构
  if (typeof data.is_available !== 'undefined' || Array.isArray(data.balance_infos)) {
    const info = Array.isArray(data.balance_infos) ? data.balance_infos[0] : null
    return {
      ok: true,
      kind: 'deepseek',
      isAvailable: data.is_available !== false,
      currency: info ? info.currency : '',
      total: info ? info.total_balance : '',
      granted: info ? info.granted_balance : '',
      toppedUp: info ? info.topped_up_balance : '',
      at: Date.now()
    }
  }

  // new-api / one-api 风格兜底：{ data: { quota, used_quota } }
  const inner = data.data || data
  if (inner && typeof inner.quota !== 'undefined') {
    const quota = Number(inner.quota)
    const used = Number(inner.used_quota || 0)
    return {
      ok: true,
      kind: 'quota',
      isAvailable: true,
      currency: 'quota',
      total: String(quota),
      granted: '',
      toppedUp: '',
      used: String(used),
      remaining: String(Math.max(quota - used, 0)),
      at: Date.now()
    }
  }

  return { ok: false, error: '无法识别的余额响应结构', at: Date.now() }
}

/* ---------------- zstd 帧扫描与解码 ---------------- */

function scanZstdFrames(buffer) {
  const frames = []
  let offset = 0
  while (offset + 5 <= buffer.length) {
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) break
    const descriptor = buffer.readUInt8(offset + 4)
    if ((descriptor & 24) !== 0) break // 保留位被占用 → 撕裂帧
    const checksum = (descriptor & 4) !== 0
    const dictIdSize = descriptor & 3
    const singleSegment = (descriptor & 32) !== 0
    const fcsFlag = descriptor >> 6
    let pos = offset + 5
    if (!singleSegment) pos += 1 // window descriptor
    pos += dictIdSize
    if (fcsFlag === 1) pos += 2
    else if (fcsFlag === 2) pos += 4
    else if (fcsFlag === 3) pos += 8
    else if (singleSegment) pos += 1
    let last = false
    let ok = true
    while (!last) {
      if (pos + 3 > buffer.length) { ok = false; break }
      const h0 = buffer.readUInt8(pos)
      const h1 = buffer.readUInt8(pos + 1)
      const h2 = buffer.readUInt8(pos + 2)
      last = (h0 & 1) !== 0
      const size = (h0 >> 3) | (h1 << 5) | (h2 << 13)
      pos += 3 + size
      if (pos > buffer.length) { ok = false; break }
    }
    if (!ok) break // 块越界 → 撕裂帧
    if (checksum) {
      if (pos + 4 > buffer.length) break
      pos += 4
    }
    frames.push({ start: offset, end: pos })
    offset = pos
  }
  return frames
}

function decodeSessionLog(filePath) {
  const buf = fs.readFileSync(filePath)
  if (buf.length >= 4 && buf.readUInt32LE(0) === ZSTD_MAGIC) {
    const frames = scanZstdFrames(buf)
    if (frames.length === 0) return ''
    let text = ''
    for (const f of frames) {
      try { text += zstdDecompressSync(buf.subarray(f.start, f.end)).toString('utf8') } catch { /* 跳过坏帧 */ }
    }
    return text
  }
  return buf.toString('utf8') // 兼容明文 .jsonl
}

/* ---------------- 用量聚合 ---------------- */

const usageFileCache = new Map() // filePath -> { mtimeMs, size, buckets }

function localDay(ts) {
  const d = new Date(ts)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function emptyBucket() {
  return { requests: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }
}

function bucketAddUsage(target, usage) {
  target.requests += 1
  target.inputTokens += usage.inputTokens || 0
  target.outputTokens += usage.outputTokens || 0
  target.cacheReadTokens += usage.cacheReadTokens || 0
  target.cacheWriteTokens += usage.cacheWriteTokens || 0
}

function bucketAddBucket(target, src) {
  target.requests += src.requests
  target.inputTokens += src.inputTokens
  target.outputTokens += src.outputTokens
  target.cacheReadTokens += src.cacheReadTokens
  target.cacheWriteTokens += src.cacheWriteTokens
}

function costOf(bucket, prices) {
  const p = prices || DEFAULT_PRICES
  const m = 1000000
  return {
    input: (bucket.inputTokens * (p.input || 0)) / m,
    output: (bucket.outputTokens * (p.output || 0)) / m,
    cacheRead: (bucket.cacheReadTokens * (p.cacheRead || 0)) / m,
    cacheWrite: (bucket.cacheWriteTokens * (p.cacheWrite || 0)) / m
  }
}

function withCost(bucket, prices) {
  const c = costOf(bucket, prices)
  return Object.assign({}, bucket, { cost: Object.assign({}, c, { total: c.input + c.output + c.cacheRead + c.cacheWrite }) })
}

function scanSessionLog(filePath) {
  let st
  try { st = fs.statSync(filePath) } catch { return new Map() }
  const cached = usageFileCache.get(filePath)
  if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) return cached.buckets

  let buckets = new Map()
  try {
    const text = decodeSessionLog(filePath)
    const lastSample = new Map() // 'turn:step' -> { ts, usage }
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue
      let ev
      try { ev = JSON.parse(line) } catch { continue }
      const d = ev.data
      if (!d || d.turn === undefined || d.step === undefined) continue
      let usage = null
      if (ev.type === 'assistant/chunk' && d.chunk && d.chunk.type === 'usage' && d.chunk.usage) usage = d.chunk.usage
      else if (ev.type === 'assistant/message' && d.usage) usage = d.usage
      if (!usage) continue
      const key = `${d.turn}:${d.step}`
      const ts = typeof ev.time === 'number' ? ev.time : 0
      const prev = lastSample.get(key)
      if (!prev || ts >= prev.ts) lastSample.set(key, { ts, usage })
    }
    for (const { ts, usage } of lastSample.values()) {
      const day = ts > 0 ? localDay(ts) : localDay(Date.now())
      let b = buckets.get(day)
      if (!b) { b = emptyBucket(); buckets.set(day, b) }
      bucketAddUsage(b, usage)
    }
  } catch { /* 解析失败保留空桶 */ }

  usageFileCache.set(filePath, { mtimeMs: st.mtimeMs, size: st.size, buckets })
  return buckets
}

function collectUsage(prices) {
  const merged = new Map()
  let sessionCount = 0

  // sessions/<工作区>/<会话>/session.jsonl(.zstd) —— 递归查找会话日志文件
  const sessionLogs = []
  const walk = (dir, depth) => {
    if (depth > 4) return
    let entries
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const ent of entries) {
      if (ent.isDirectory()) walk(path.join(dir, ent.name), depth + 1)
      else if (ent.isFile() && (ent.name === 'session.jsonl' || ent.name === 'session.jsonl.zstd')) {
        sessionLogs.push(path.join(dir, ent.name))
      }
    }
  }
  walk(SESSIONS_DIR, 0)

  for (const fp of sessionLogs) {
    try {
      const buckets = scanSessionLog(fp)
      if (buckets.size === 0) continue
      for (const [day, b] of buckets) {
        let t = merged.get(day)
        if (!t) { t = emptyBucket(); merged.set(day, t) }
        bucketAddBucket(t, b)
      }
      sessionCount++
    } catch { }
  }

  const sum = (days) => {
    const acc = emptyBucket()
    for (const day of days) {
      const b = merged.get(day)
      if (b) bucketAddBucket(acc, b)
    }
    return acc
  }
  const days = [...merged.keys()].sort()
  const last7 = []
  for (let i = 0; i < 7; i++) last7.push(localDay(Date.now() - i * DAY_MS))

  // 本月按天序列（1 号到今天，缺失日补零，保证图表连续）
  const now = new Date()
  const monthPrefix = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-`
  const monthDays = []
  let monthBucket = emptyBucket()
  for (let d = 1; d <= now.getDate(); d++) {
    const dayKey = monthPrefix + String(d).padStart(2, '0')
    const b = merged.get(dayKey) || emptyBucket()
    bucketAddBucket(monthBucket, b)
    monthDays.push(Object.assign({ day: dayKey, dayOfMonth: d }, withCost(b, prices)))
  }

  return {
    today: withCost(sum([localDay(Date.now())]), prices),
    last7d: withCost(sum(last7), prices),
    total: withCost(sum(days), prices),
    month: {
      bucket: withCost(monthBucket, prices),
      days: monthDays,
      prices: Object.assign({}, DEFAULT_PRICES, prices || {})
    },
    sessionCount,
    scannedAt: Date.now()
  }
}

/* ---------------- 快照 ---------------- */

let balanceState = null
let usageState = null

async function refreshBalance(cfg) {
  balanceState = await fetchBalance(cfg)
  return balanceState
}

async function refreshUsage(prices) {
  usageState = collectUsage(prices)
  return usageState
}

function getSnapshot() {
  return { balance: balanceState, usage: usageState }
}

module.exports = {
  readCredentialKey,
  refreshBalance,
  refreshUsage,
  getSnapshot,
  DEFAULT_BALANCE_URL,
  DEFAULT_PRICES,
  PLATFORM_USAGE_URL
}
