import { EventEmitter } from 'node:events'
import { Context } from 'cordis'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { authTokenStatus, selfInfo } from '@/common/globalVars'
import { DirectQQProtocol } from '../../../src/main/qqProtocol/direct'
import { DirectProtocolClient, type SessionInfo } from '../../../src/main/qqProtocol/direct-lib/client'
import { fetchQrCode } from '../../../src/main/qqProtocol/direct-lib/login'
import { deleteMachineGuid } from '../../../src/main/qqProtocol/direct-lib/machineGuid'
import { deleteSession } from '../../../src/main/qqProtocol/direct-lib/session'
import { requestSign } from '../../../src/main/qqProtocol/direct-lib/sign'
import { teaEncrypt } from '../../../src/main/qqProtocol/direct-lib/tea'
import { getCurrentLoginState } from '../../../src/main/llbot-ipc'

vi.mock('@/common/globalVars', () => ({
  selfInfo: { uin: '123456', uid: 'test-uid', nick: 'TestBot', online: true },
  authTokenStatus: { loginError: '' },
  TEMP_DIR: '/tmp/test-data/temp',
}))

vi.mock('@/main/config', () => ({
  authTokenUtil: { reload: vi.fn(() => 'test-auth-token') },
}))

vi.mock('@/main/qqProtocol/direct-lib/authTokenWatcher', () => ({
  startAuthTokenWatcher: vi.fn(),
}))

vi.mock('@/main/qqProtocol/direct-lib/machineGuid', () => ({
  loadMachineGuidSync: vi.fn(() => Buffer.alloc(16)),
  overwriteMachineGuid: vi.fn(),
  deleteMachineGuid: vi.fn(),
}))

vi.mock('@/main/qqProtocol/direct-lib/session', () => ({
  saveSession: vi.fn(),
  loadSession: vi.fn(),
  deleteSession: vi.fn(),
  listAvailableSessions: vi.fn(() => []),
  persistedToSessionInfo: vi.fn(),
  getSpecifiedUin: vi.fn(() => '123456'),
  getSessionFilePathForUin: vi.fn(),
}))

vi.mock('@/main/qqProtocol/direct-lib/sign', () => ({
  requestSign: vi.fn(),
  setupSign: vi.fn(),
  setSignMachineGuid: vi.fn(),
  acquireSignToken: vi.fn(async () => ({ token: 'test-token', ttlSecs: 3600 })),
  updateAuthToken: vi.fn(),
}))

vi.mock('@/main/qqProtocol/direct-lib/login', () => ({
  fetchQrCode: vi.fn(),
  pollQrCode: vi.fn(),
  loginWithQrResult: vi.fn(),
  getCorrectUin: vi.fn(),
  QrCodeState: { Confirmed: 0, WaitingForConfirm: 53, Expired: 17, Cancelled: 54 },
}))

vi.mock('@/main/qqProtocol/direct-lib/connection', () => ({
  TcpConnection: class extends EventEmitter {
    isConnected = true
    send = vi.fn()
    connect = vi.fn(async () => {
      this.isConnected = true
    })
    disconnect = vi.fn(() => {
      this.isConnected = false
      this.emit('close')
    })
  },
}))

function createSession(): SessionInfo {
  return {
    uin: '123456',
    uid: 'test-uid',
    d2: Buffer.alloc(16),
    d2Key: Buffer.alloc(16),
    tgt: Buffer.alloc(16),
    a2: Buffer.alloc(16),
    a2Key: Buffer.alloc(16),
    sKey: Buffer.alloc(0),
  }
}

function int32(value: number): Buffer {
  const data = Buffer.alloc(4)
  data.writeInt32BE(value)
  return data
}

// Synthetic protocol-12 responses exercise the real parser without account credentials or captured traffic.
function responseFrame(seq: number, retCode = 0, cmd = 'test.command', extraMsg = ''): Buffer {
  const extra = Buffer.from(extraMsg)
  const command = Buffer.from(cmd)
  const head = Buffer.concat([
    int32(seq),
    int32(retCode),
    int32(extra.length + 4),
    extra,
    int32(command.length + 4),
    command,
  ])
  const body = Buffer.concat([int32(head.length + 4), head, int32(4)])
  return Buffer.concat([int32(12), Buffer.from([2, 0]), int32(4), Buffer.from(teaEncrypt(body, Buffer.alloc(16)))])
}

const authMessage = '身份验证失败，请你重新登录。(s20)'

describe('direct session authentication failures', () => {
  let client: DirectProtocolClient

  beforeEach(() => {
    vi.useFakeTimers()
    client = new DirectProtocolClient()
    client.setSession(createSession())
    selfInfo.online = true
    authTokenStatus.loginError = ''
  })

  afterEach(() => {
    client.disconnect()
    vi.clearAllTimers()
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it.each(['unmatched', 'matched'])('invalidates the session for an %s authentication failure', async (kind) => {
    const expired = vi.fn()
    const pushed = vi.fn()
    client.on('session-expired', expired)
    client.on('push', pushed)
    const seq = client['seq']
    const requests = Promise.allSettled([
      client.sendCommand('test.command', Buffer.alloc(0)),
      client.sendCommand('test.other', Buffer.alloc(0)),
    ])

    client['conn'].emit('packet', responseFrame(kind === 'matched' ? seq : 0, -10001, '', authMessage))

    const results = await requests
    for (const result of results) {
      expect(result.status).toBe('rejected')
      if (result.status === 'rejected') expect(result.reason.message).toContain(authMessage)
    }
    expect(client.isLoggedIn).toBe(false)
    expect(expired).toHaveBeenCalledExactlyOnceWith('123456', expect.any(Error))
    expect(pushed).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('invalidates an idle session even when there are no pending requests', () => {
    const expired = vi.fn()
    client.on('session-expired', expired)
    client['conn'].emit('packet', responseFrame(0, -10001, '', authMessage))
    client['conn'].emit('packet', responseFrame(0, -10001, '', authMessage))
    expect(expired).toHaveBeenCalledTimes(1)
    expect(client.isLoggedIn).toBe(false)
  })

  it('keeps ordinary request errors scoped to the matching request', async () => {
    const expired = vi.fn()
    client.on('session-expired', expired)
    const seq = client['seq']
    const first = client.sendCommand('test.command', Buffer.alloc(0))
    const rejected = expect(first).rejects.toThrow('retCode=-2')
    const second = client.sendCommand('test.other', Buffer.alloc(0))

    client['conn'].emit('packet', responseFrame(seq, -2, 'test.command', 'Request failed'))
    client['conn'].emit('packet', responseFrame(seq + 1, 0, 'test.other'))

    await rejected
    await expect(second).resolves.toMatchObject({ cmd: 'test.other', retCode: 0 })
    expect(client.isLoggedIn).toBe(true)
    expect(expired).not.toHaveBeenCalled()
  })

  it('continues forwarding ordinary unsolicited pushes', () => {
    const pushed = vi.fn()
    client.on('push', pushed)
    client['conn'].emit('packet', responseFrame(0, 0, 'trpc.msg.olpush.OlPushService.MsgPush'))
    expect(pushed).toHaveBeenCalledWith(expect.objectContaining({ cmd: 'trpc.msg.olpush.OlPushService.MsgPush' }))
    expect(client.isLoggedIn).toBe(true)
  })

  it('does not send a command whose signing finishes after session invalidation', async () => {
    client.setAuthToken('test-auth-token')
    const session = client.getSession()!
    session.signToken12B = 'test-token'
    session.signTokenExpiresAt = Date.now() + 60_000
    let finishSign!: (result: { sign: Buffer; token: Buffer; extra: Buffer }) => void
    vi.mocked(requestSign).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishSign = resolve
        }),
    )
    const request = client.sendCommand('MessageSvc.PbSendMsg', Buffer.alloc(0))
    const rejected = expect(request).rejects.toThrow('QQ session changed')
    await vi.waitFor(() => expect(requestSign).toHaveBeenCalled())

    client['conn'].emit('packet', responseFrame(0, -10001, '', authMessage))
    finishSign({ sign: Buffer.alloc(0), token: Buffer.from('test-token'), extra: Buffer.alloc(0) })

    await rejected
    expect(client['conn'].send).not.toHaveBeenCalled()
  })

  it.each([true, false])('exposes a fresh QR login after invalidation (already online: %s)', async (alreadyOnline) => {
    const ctx = new Context()
    const protocol = new DirectQQProtocol(ctx)
    protocol['directClient'] = client
    protocol['onlineEmitted'] = alreadyOnline
    selfInfo.online = alreadyOnline
    protocol['runtimeUinOverride'] = '123456'
    protocol['qrResult'] = { qrcodeUrl: 'stale', pngBase64: '', expireTimeSec: 180, sig: 'stale' }
    protocol['qrFetchedAt'] = Date.now()
    const stopHeartbeat = vi.fn()
    protocol['directStopHeartbeat'] = stopHeartbeat
    const reconnect = vi.fn()
    protocol['reconnectTimer'] = setTimeout(reconnect, 5000) as unknown as NodeJS.Timeout
    const disconnect = vi.fn()
    ctx.on('protocol/disconnect', disconnect)
    const qrLoop = vi
      .spyOn(protocol as unknown as { ensureQrLoop(): void }, 'ensureQrLoop')
      .mockImplementation(() => {})
    protocol['bindDirectClientEvents'](client)
    const seq = client['seq']
    const pending = protocol.sendPB('test.command', Buffer.alloc(0))
    const rejected = expect(pending).rejects.toThrow(authMessage)

    client['conn'].emit('packet', responseFrame(0, -10001, '', authMessage))

    await rejected
    expect(selfInfo.online).toBe(false)
    expect(protocol.get_is_connected()).toBe(false)
    expect(authTokenStatus.loginError).toContain(authMessage)
    expect(deleteSession).toHaveBeenCalledExactlyOnceWith('123456')
    expect(deleteMachineGuid).not.toHaveBeenCalled()
    expect(stopHeartbeat).toHaveBeenCalledTimes(1)
    expect(disconnect).toHaveBeenCalledTimes(alreadyOnline ? 1 : 0)
    expect(qrLoop).toHaveBeenCalledTimes(1)
    expect(getCurrentLoginState()).toMatchObject({ state: 'need_qrcode' })
    expect(client['conn'].disconnect).not.toHaveBeenCalled()
    await expect(protocol.sendPB('test.command', Buffer.alloc(0))).rejects.toThrow('not logged in')

    // A late reply must not restore the expired session or report the account online.
    client['conn'].emit('packet', responseFrame(seq))
    expect(selfInfo.online).toBe(false)
    vi.mocked(fetchQrCode).mockResolvedValue({
      url: 'fresh-qr',
      image: Buffer.alloc(0),
      sig: Buffer.alloc(16),
      tgtgtKey: Buffer.alloc(16),
    })
    await expect(protocol.getLoginQrCode()).resolves.toMatchObject({ qrcodeUrl: 'fresh-qr' })
    expect(fetchQrCode).toHaveBeenCalledWith(client)
    await vi.advanceTimersByTimeAsync(5000)
    expect(reconnect).not.toHaveBeenCalled()

    // A replacement session can use the same client and report online again.
    client.setSession(createSession())
    selfInfo.online = true
    const online = vi.fn()
    ctx.on('qq/online', online)
    protocol['maybeEmitOnline']()
    expect(online).toHaveBeenCalledTimes(1)
    expect(authTokenStatus.loginError).toBe('')
  })

  it('preserves saved credentials on an ordinary transport close', () => {
    const ctx = new Context()
    const protocol = new DirectQQProtocol(ctx)
    protocol['directClient'] = client
    protocol['onlineEmitted'] = true
    protocol['bindDirectClientEvents'](client)
    const reconnect = vi
      .spyOn(protocol as unknown as { scheduleReconnect(): void }, 'scheduleReconnect')
      .mockImplementation(() => {})

    client['conn'].emit('close')

    expect(selfInfo.online).toBe(false)
    expect(deleteSession).not.toHaveBeenCalled()
    expect(reconnect).toHaveBeenCalledTimes(1)
  })
})
