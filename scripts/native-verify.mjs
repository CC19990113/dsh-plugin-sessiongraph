import { homedir } from 'node:os'
import { join } from 'node:path'
import { rmSync, mkdirSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const native = require('../packages/native/sessiongraph-core.darwin-arm64.node')
const { openIndex, IndexPool, status: statusQuery, search, timeline } = await import('../packages/sqlite/lib/index.js')

const ROOT = '/tmp/sg-rust'
rmSync(ROOT, { recursive: true, force: true }); mkdirSync(ROOT, { recursive: true })
const INDEX_PATH = join(ROOT, 'index.db')

console.log('=== Rust 全量建索引 ===')
const t0 = Date.now()
const report = native.indexSessions({
  sessionsRoot: join(homedir(), '.dsh', 'sessions'),
  indexPath: INDEX_PATH,
  force: true,
  maxEntryChars: 4000,
  toolCallChars: 2000,
  maxFileBytes: 64 * 1024 * 1024,
})
const wall = Date.now() - t0
console.log(JSON.stringify({ ...report, wallMs: wall }, null, 2))
console.log('索引体积:', (statSync(INDEX_PATH).size / 1e6).toFixed(1) + 'MB')

console.log('\n=== TS store 读 Rust 建的库（跨实现兼容验收）===')
const db = openIndex(ROOT)
for (const q of ['广告', '点击跳转', '鸿蒙 SDK', 'sessiongraph']) {
  const t = performance.now()
  const r = search(db, { operation: 'search', query: q, limit: 2, indexRoot: ROOT }, 240)
  console.log(`查「${q}」→ ${r.total} 命中 (${(performance.now()-t).toFixed(1)}ms)`)
  for (const h of r.hits) console.log(`   [${h.kind}] ${h.snippet.slice(0, 90).replace(/\n/g,' ')}`)
}
const tl = timeline(db, { operation: 'timeline', limit: 2, indexRoot: ROOT })
console.log('\n时间线:', tl.sessions.map(s => `${s.title ?? '(无标题)'} (${s.entries}条)`).join(' | '))
const pool = new IndexPool(ROOT, 4)
console.log('status:', JSON.stringify(statusQuery(pool, ROOT)))
