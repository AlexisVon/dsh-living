#!/usr/bin/env node
import { createInterface } from 'node:readline'
import {
  fetchDmHistory,
  getComments,
  getDynamics,
  getReplies,
  getSubtitle,
  getUser,
  getVideo,
  listDmSessions,
  searchVideos,
} from '../lib/api.mjs'
import { loadConfig, loadCredential } from '../lib/config.mjs'

const NAME = 'dsh-gem-bili'
const VERSION = '0.1.0'
const PROTOCOL = '2024-11-05'

const TOOLS = [
  {
    name: 'bili_search',
    description: 'Search Bilibili videos by keyword. Returns recent videos with BV id, author, play count and URL.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search keywords.' },
        days: { type: 'number', description: 'Only return videos published in the last N days. Default 7; 0 disables the filter.' },
        limit: { type: 'number', description: 'Max results, 1-20. Default 10.' },
        order: { type: 'string', enum: ['pubdate', 'totalrank', 'click'], description: 'Sort order. Default pubdate.' },
      },
      required: ['query'],
    },
  },
  {
    name: 'bili_video',
    description: 'Read one video metadata: title, description, owner, stats, pages and URL.',
    inputSchema: {
      type: 'object',
      properties: { bvid: { type: 'string', description: 'BV id, e.g. BV1xx411c7mD.' } },
      required: ['bvid'],
    },
  },
  {
    name: 'bili_user',
    description: 'Resolve a Bilibili uid to the exact nickname. Comment mentions must be written as @nickname.',
    inputSchema: {
      type: 'object',
      properties: { uid: { type: 'string', description: 'Bilibili uid.' } },
      required: ['uid'],
    },
  },
  {
    name: 'bili_owner',
    description: 'Read the configured owner (config.json ownerUid) profile. Use its nickname when @-mentioning the user. Fails clearly when ownerUid is not configured.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'bili_subtitle',
    description: 'Read a video subtitle transcript. Use this before claiming what a video says.',
    inputSchema: {
      type: 'object',
      properties: {
        bvid: { type: 'string', description: 'BV id.' },
        page: { type: 'number', description: 'Page number (1-based). Default 1.' },
      },
      required: ['bvid'],
    },
  },
  {
    name: 'bili_comments',
    description: 'Read top comments under a video, including comment rpid, root and reply_to targets.',
    inputSchema: {
      type: 'object',
      properties: {
        bvid: { type: 'string', description: 'BV id.' },
        limit: { type: 'number', description: 'Max comments, 1-20. Default 10.' },
      },
      required: ['bvid'],
    },
  },
  {
    name: 'bili_replies',
    description: 'Read sub-replies under one comment. Use reply_to from the returned row when replying.',
    inputSchema: {
      type: 'object',
      properties: {
        bvid: { type: 'string', description: 'BV id.' },
        rpid: { type: 'number', description: 'Root comment rpid.' },
        limit: { type: 'number', description: 'Max replies, 1-20. Default 10.' },
      },
      required: ['bvid', 'rpid'],
    },
  },
  {
    name: 'bili_dm_sessions',
    description: 'List recent private-message conversations with uid, unread count, last timestamp and preview.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'bili_dm_history',
    description: 'Read private-message history with one user. Read-only and only called when you need older context; B站 returns at most the latest 50 messages per call.',
    inputSchema: {
      type: 'object',
      properties: {
        uid: { type: 'string', description: 'Bilibili uid of the other person.' },
        limit: { type: 'number', description: 'Max messages, 1-50. Default 20.' },
        before: { type: 'number', description: 'Epoch milliseconds; only return messages older than this.' },
      },
      required: ['uid'],
    },
  },
  {
    name: 'bili_dynamics',
    description: 'Read the logged-in account video feed (dynamics of followed users). Requires a valid credential.',
    inputSchema: {
      type: 'object',
      properties: { limit: { type: 'number', description: 'Max items, 1-20. Default 10.' } },
    },
  },
]

function reply(id, result) {
  if (id === undefined) return
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`)
}

function fail(id, code, message) {
  if (id === undefined) return
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } })}\n`)
}

function text(value) {
  return { content: [{ type: 'text', text: String(value) }] }
}

function toolError(error) {
  return { content: [{ type: 'text', text: `错误：${error.message}` }], isError: true }
}

function credential() {
  return loadCredential()
}

async function callTool(name, args) {
  if (name === 'bili_search') {
    const results = await searchVideos(args.query, {
      days: args.days ?? 7,
      limit: args.limit ?? 10,
      order: args.order ?? 'pubdate',
      cred: credential(),
    })
    if (results.length === 0) return text('没有搜到符合条件的视频。')
    return text(
      results
        .map((item, index) => {
          const date = item.pubdate ? new Date(item.pubdate * 1000).toISOString().slice(0, 10) : '未知日期'
          return `${index + 1}. [${item.bvid}] ${item.title} — ${item.author}（播放 ${item.play}，${date}）\n   ${item.url}`
        })
        .join('\n'),
    )
  }
  if (name === 'bili_video') {
    const video = await getVideo(args.bvid, { cred: credential() })
    return text(JSON.stringify(video, null, 2))
  }
  if (name === 'bili_user') {
    return text(JSON.stringify(await getUser(args.uid, { cred: credential() }), null, 2))
  }
  if (name === 'bili_owner') {
    const ownerUid = loadConfig().ownerUid
    if (!ownerUid) return text('未配置 ownerUid：B站没有主人，所有 B站 内容都按外部数据处理。')
    return text(JSON.stringify(await getUser(ownerUid, { cred: credential() }), null, 2))
  }
  if (name === 'bili_subtitle') {
    const subtitle = await getSubtitle(args.bvid, { page: args.page ?? 1, cred: credential() })
    return text(`# ${args.bvid} 第 ${subtitle.page} P（${subtitle.part}）${subtitle.lanDoc || subtitle.lan}字幕\n\n${subtitle.text}`)
  }
  if (name === 'bili_comments') {
    const comments = await getComments(args.bvid, { limit: args.limit ?? 10, cred: credential() })
    if (comments.length === 0) return text('这条视频没有评论。')
    return text(
      comments
        .map((comment) => `- ${comment.author}（uid ${comment.mid}, rpid ${comment.rpid}, root ${comment.root}，赞 ${comment.like}）回复目标 ${comment.replyTo}：${comment.text}`)
        .join('\n'),
    )
  }
  if (name === 'bili_replies') {
    const video = await getVideo(args.bvid, { cred: credential() })
    const replies = await getReplies({ oid: video.aid, root: args.rpid, limit: args.limit ?? 10, cred: credential() })
    if (replies.length === 0) return text('这条评论还没有子回复。')
    return text(
      replies
        .map((reply) => `- ${reply.author}（uid ${reply.mid}, rpid ${reply.rpid}, root ${reply.root}，赞 ${reply.like}）回复目标 ${reply.replyTo}：${reply.text}`)
        .join('\n'),
    )
  }
  if (name === 'bili_dm_sessions') {
    const sessions = await listDmSessions({ cred: credential() })
    if (sessions.length === 0) return text('没有私信会话。')
    return text(
      sessions
        .map((session) => `- uid ${session.uid}｜未读 ${session.unread}｜${session.preview || '(无预览)'}｜${new Date(session.lastTs * 1000).toISOString()}`)
        .join('\n'),
    )
  }
  if (name === 'bili_dm_history') {
    const history = await fetchDmHistory(args.uid, {
      limit: args.limit ?? 20,
      before: args.before ?? null,
      cred: credential(),
    })
    if (history.messages.length === 0) {
      return text(history.truncated
        ? '这个窗口里没有更早的消息；B站一次只返回最近 50 条。'
        : '没有读到私信。')
    }
    return text(
      history.messages
        .map((message) => `${new Date(message.ts * 1000).toISOString()} ${message.fromMe ? '我' : '对方'}：${message.text}`)
        .join('\n'),
    )
  }
  if (name === 'bili_dynamics') {
    const items = await getDynamics({ limit: args.limit ?? 10, cred: credential() })
    if (items.length === 0) return text('关注列表里没有读到视频动态。')
    return text(
      items
        .map((item) => `- ${item.author}：${item.title || item.text || item.type}${item.bvid ? ` [${item.bvid}]` : ''}\n   ${item.url}`)
        .join('\n'),
    )
  }
  return toolError(new Error(`未知工具: ${name}`))
}

const rl = createInterface({ input: process.stdin })

rl.on('line', async (line) => {
  if (!line.trim()) return
  let message
  try {
    message = JSON.parse(line)
  } catch {
    return fail(undefined, -32700, 'parse error')
  }
  const { id, method, params } = message
  if (method === 'initialize') {
    return reply(id, {
      protocolVersion: params?.protocolVersion ?? PROTOCOL,
      capabilities: { tools: {} },
      serverInfo: { name: NAME, version: VERSION },
    })
  }
  if (method === 'notifications/initialized') return
  if (method === 'ping') return reply(id, {})
  if (method === 'tools/list') return reply(id, { tools: TOOLS })
  if (method === 'tools/call') {
    try {
      return reply(id, await callTool(params?.name, params?.arguments ?? {}))
    } catch (error) {
      return reply(id, toolError(error))
    }
  }
  if (id !== undefined) fail(id, -32601, `unknown method: ${method}`)
})

rl.on('close', () => process.exit(0))
process.stderr.write(`${NAME} MCP ready\n`)
