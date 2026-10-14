'use strict'

const dc = require('node:diagnostics_channel')

// TracingChannel names
const TRACE_QUERY = 'mssql:query'
const TRACE_BATCH = 'mssql:batch'
const TRACE_EXECUTE = 'mssql:execute'
const TRACE_BULK = 'mssql:bulk'
const TRACE_CONNECT = 'mssql:connect'
const TRACE_POOL_ACQUIRE = 'mssql:pool:acquire'
const TRACE_PREPARED_STATEMENT_PREPARE = 'mssql:prepared-statement:prepare'
const TRACE_PREPARED_STATEMENT_EXECUTE = 'mssql:prepared-statement:execute'

// Point-event channel names
const CONNECTION_ACQUIRE = 'mssql:connection:acquire'
const CONNECTION_RELEASE = 'mssql:connection:release'
const CONNECTION_CREATE = 'mssql:connection:create'
const CONNECTION_DESTROY = 'mssql:connection:destroy'
const POOL_CLOSE = 'mssql:pool:close'
const TRANSACTION_BEGIN = 'mssql:transaction:begin'
const TRANSACTION_COMMIT = 'mssql:transaction:commit'
const TRANSACTION_ROLLBACK = 'mssql:transaction:rollback'
const REQUEST_CANCEL = 'mssql:request:cancel'
const PREPARED_STATEMENT_UNPREPARE = 'mssql:prepared-statement:unprepare'

const CHANNELS = Object.freeze({
  TRACE_QUERY,
  TRACE_BATCH,
  TRACE_EXECUTE,
  TRACE_BULK,
  TRACE_CONNECT,
  TRACE_POOL_ACQUIRE,
  TRACE_PREPARED_STATEMENT_PREPARE,
  TRACE_PREPARED_STATEMENT_EXECUTE,
  CONNECTION_ACQUIRE,
  CONNECTION_RELEASE,
  CONNECTION_CREATE,
  CONNECTION_DESTROY,
  POOL_CLOSE,
  TRANSACTION_BEGIN,
  TRANSACTION_COMMIT,
  TRANSACTION_ROLLBACK,
  REQUEST_CANCEL,
  PREPARED_STATEMENT_UNPREPARE
})

// [letian-node14-patch] dc.tracingChannel 需 Node 18.19+/19.9+；部署目标
// Node 14.21.3（Windows Server 2008 R2）没有该 API。此处降级：无 tracingChannel
// 时不注册追踪通道，tracePromise/traceCallback 走库自带的“无订阅者直通”
// 快路径，查询功能不受影响，仅丢失 APM 追踪埋点。
const hasTracingChannel = typeof dc.tracingChannel === 'function'
const tracingChannels = hasTracingChannel
  ? {
      [TRACE_QUERY]: dc.tracingChannel(TRACE_QUERY),
      [TRACE_BATCH]: dc.tracingChannel(TRACE_BATCH),
      [TRACE_EXECUTE]: dc.tracingChannel(TRACE_EXECUTE),
      [TRACE_BULK]: dc.tracingChannel(TRACE_BULK),
      [TRACE_CONNECT]: dc.tracingChannel(TRACE_CONNECT),
      [TRACE_POOL_ACQUIRE]: dc.tracingChannel(TRACE_POOL_ACQUIRE),
      [TRACE_PREPARED_STATEMENT_PREPARE]: dc.tracingChannel(TRACE_PREPARED_STATEMENT_PREPARE),
      [TRACE_PREPARED_STATEMENT_EXECUTE]: dc.tracingChannel(TRACE_PREPARED_STATEMENT_EXECUTE)
    }
  : {}

// Pre-create point-event channel instances at module load time
// （dc.channel 自 Node 14.17 起可用，14.21.3 满足）
const pointChannels = {
  [CONNECTION_ACQUIRE]: dc.channel(CONNECTION_ACQUIRE),
  [CONNECTION_RELEASE]: dc.channel(CONNECTION_RELEASE),
  [CONNECTION_CREATE]: dc.channel(CONNECTION_CREATE),
  [CONNECTION_DESTROY]: dc.channel(CONNECTION_DESTROY),
  [POOL_CLOSE]: dc.channel(POOL_CLOSE),
  [TRANSACTION_BEGIN]: dc.channel(TRANSACTION_BEGIN),
  [TRANSACTION_COMMIT]: dc.channel(TRANSACTION_COMMIT),
  [TRANSACTION_ROLLBACK]: dc.channel(TRANSACTION_ROLLBACK),
  [REQUEST_CANCEL]: dc.channel(REQUEST_CANCEL),
  [PREPARED_STATEMENT_UNPREPARE]: dc.channel(PREPARED_STATEMENT_UNPREPARE)
}

function tracingChannelHasSubscribers (tc) {
  if (typeof tc.hasSubscribers === 'boolean') return tc.hasSubscribers
  return tc.start.hasSubscribers ||
    tc.end.hasSubscribers ||
    tc.asyncStart.hasSubscribers ||
    tc.asyncEnd.hasSubscribers ||
    tc.error.hasSubscribers
}

function tracePromise (name, fn, contextFactory) {
  const channel = tracingChannels[name]
  if (channel && tracingChannelHasSubscribers(channel)) {
    return channel.tracePromise(fn, contextFactory())
  }
  return fn()
}

function traceCallback (name, fn, position, contextFactory, thisArg, args) {
  const channel = tracingChannels[name]
  if (channel && tracingChannelHasSubscribers(channel)) {
    return channel.traceCallback(fn, position, contextFactory(), thisArg, ...args)
  }
  return fn.apply(thisArg, args)
}

function publish (name, factory) {
  const channel = pointChannels[name]
  if (channel.hasSubscribers) {
    channel.publish(factory())
  }
}

module.exports = {
  CHANNELS,
  tracingChannels,
  tracePromise,
  traceCallback,
  publish
}
