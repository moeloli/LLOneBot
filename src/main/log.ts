import path from 'node:path'
import { Context, Logger } from 'cordis'
import { appendFile, stat } from 'node:fs'
import { LOG_DIR } from '@/common/globalVars'
import { noop } from 'cosmokit'

interface Config {
  enable: boolean
  filename: string
}

// 日志切片配置
const MAX_FILE_SIZE = 5 * 1024 * 1024 // 5MB
const MAX_ENTRIES = 10000

function generateLogFilename(): string {
  return `llbot-${new Date().toLocaleString('zh-CN')}.log`.replace(/\//g, '-').replace(/:/g, '-')
}

export interface LogRecord {
  timestamp: number
  type: string
  content: string
  dateTimeStr: string
}

// 日志缓存
const LOG_CACHE_SIZE = 1000
const logCache: LogRecord[] = []

export function getLogCache(): LogRecord[] {
  return logCache
}

declare module 'cordis' {
  interface Events {
    'llob/log': (record: LogRecord) => void
  }
}

export default class Log {
  static name = 'logger'

  constructor(ctx: Context, cfg: Config) {
    Logger.targets.splice(0, Logger.targets.length)
    let enable = cfg.enable
    let currentFile = path.join(LOG_DIR, cfg.filename)
    let currentEntries = 0
    let currentSize = 0

    // 获取现有文件大小
    stat(currentFile, (err, stats) => {
      if (!err && stats) {
        currentSize = stats.size
      }
    })

    const rotate = () => {
      currentFile = path.join(LOG_DIR, generateLogFilename())
      currentEntries = 0
      currentSize = 0
    }

    const target: Logger.Target = {
      colors: 0,
      record: (record: Logger.Record) => {
        const dateTime = new Date(record.timestamp)
        const dateTimeStr = `${dateTime.getFullYear()}-${(dateTime.getMonth() + 1).toString().padStart(2, '0')}-${dateTime.getDate().toString().padStart(2, '0')} ${dateTime.getHours().toString().padStart(2, '0')}:${dateTime.getMinutes().toString().padStart(2, '0')}:${dateTime.getSeconds().toString().padStart(2, '0')}`
        let content = `${dateTimeStr} | ${record.content}\n\n`
        console.log(content)

        const logRecord: LogRecord = {
          timestamp: record.timestamp,
          type: record.type,
          content: record.content,
          dateTimeStr,
        }

        // 缓存日志
        logCache.push(logRecord)
        if (logCache.length > LOG_CACHE_SIZE) {
          logCache.shift()
        }

        // 发送日志事件到 SSE
        ctx.parallel('llob/log', logRecord)

        if (!enable) {
          return
        }
        content = `[${record.type}] | ${content}`

        // 检查是否需要切片
        if (currentSize >= MAX_FILE_SIZE || currentEntries >= MAX_ENTRIES) {
          rotate()
        }

        appendFile(currentFile, content, noop)
        currentEntries++
        currentSize += Buffer.byteLength(content)
      },
    }
    Logger.targets.push(target)
    ctx.on('llob/config-updated', input => {
      enable = input.log!
    })
  }
}
