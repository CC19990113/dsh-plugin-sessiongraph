import { Context } from '@deepseek-ai/cordis'
import * as servicePlugin from '../packages/service/lib/index.js'
import * as sqlitePlugin from '../packages/sqlite/lib/index.js'
import * as sessionsPlugin from '../packages/sessions/lib/index.js'
import { homedir } from 'node:os'
import { join } from 'node:path'

const INDEX_ROOT = join(homedir(), '.dsh', 'sessiongraph')
const ctx = new Context()
console.log('--- 装配 ---')
await ctx.plugin(servicePlugin)
console.log('service 装载: ctx.sessiongraph =', typeof ctx.sessiongraph)
await ctx.plugin(sqlitePlugin, { defaultIndexRoot: INDEX_ROOT })
console.log('sqlite store 注册完成')
await ctx.plugin(sessionsPlugin, { sessionsRoot: join(homedir(), '.dsh', 'sessions') })
console.log('sessions indexer 注册完成')

console.log('\n--- 通过 seam 查询 ---')
const st = await ctx.sessiongraph.query({ operation: 'status', indexRoot: INDEX_ROOT })
console.log('status:', JSON.stringify({ indexed: st.indexed, sessions: st.sessions, entries: st.entries, workspaces: st.workspaces, bytes: st.bytes }))

const r = await ctx.sessiongraph.query({ operation: 'search', query: '点击跳转', limit: 2, indexRoot: INDEX_ROOT })
console.log(`\nsearch「点击跳转」→ ${r.total} 命中`)
for (const h of r.hits) console.log(`  [${h.kind}] ${new Date(h.time).toLocaleString('zh-CN')} ${h.snippet.slice(0,80).replace(/\n/g,' ')}`)

const tl = await ctx.sessiongraph.query({ operation: 'timeline', limit: 2, indexRoot: INDEX_ROOT })
console.log(`\ntimeline → ${tl.sessions.length} 个会话，最新: ${tl.sessions[0]?.title ?? '(无标题)'}`)

console.log('\n--- 无索引的 root：status 应返回零值而不是抛错 ---')
const empty = await ctx.sessiongraph.query({ operation: 'status', indexRoot: '/tmp/no-such-index-root' })
console.log('empty status:', JSON.stringify({ indexed: empty.indexed, sessions: empty.sessions, indexPath: empty.indexPath }))

console.log('\n--- 无索引的 root：search 应抛错 ---')
try {
  await ctx.sessiongraph.query({ operation: 'search', query: '广告', limit: 1, indexRoot: '/tmp/no-such-index-root' })
  console.log('!! 没抛错，不符合契约')
} catch (e) { console.log('正确抛出:', e.code, '|', e.message.slice(0, 70)) }
