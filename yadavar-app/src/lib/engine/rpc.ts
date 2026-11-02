import * as pbModule from 'protobufjs/light'
import type { INamespace, IConversionOptions, Service, Type } from 'protobufjs'
import descriptor from './anki.json'
import methods from './methods.json'

/**
 * Talks to the Anki backend (rslib) in its own language: protobuf messages sent to numbered (service, method)
 * pairs. The numbering and message definitions come straight from Anki's .proto files (see tools/gen-proto.mjs).
 * On the phone the bytes go through JNI to the library AnkiDroid uses; in tests they go to the Python wheel.
 */
export interface Transport {
  /** Sends one backend call; rejects with a `BackendRpcError` when the backend answers with an error. */
  run(service: number, method: number, data: Uint8Array): Promise<Uint8Array>
}

export class BackendRpcError extends Error {
  /** `anki.backend.BackendError.Kind` (e.g. NOT_FOUND) when the backend sent one */
  kind: number | undefined
  constructor(message: string, kind?: number) {
    super(message)
    this.kind = kind
  }
}

/** Anki's error kinds we react to (anki.backend.BackendError.Kind) */
export const ErrorKind = { NOT_FOUND: 11 } as const

// CommonJS package: Node wraps it in `default`, bundlers expose the names directly
const pb = ((pbModule as unknown as { default?: typeof pbModule }).default ?? pbModule) as typeof pbModule

type MethodInfo = { s: number; m: number; svc: string; rpc: string }
const table = methods as unknown as Record<string, MethodInfo>

const root = pb.Root.fromJSON(descriptor as unknown as INamespace)
const errorType = root.lookupType('anki.backend.BackendError')

const OUT = { longs: Number, enums: Number, arrays: true, objects: true } as IConversionOptions

/** Decodes the `BackendError` message the backend returns on failure. */
export function decodeBackendError(bytes: Uint8Array): BackendRpcError {
  try {
    const e = errorType.toObject(errorType.decode(bytes), { enums: Number }) as { message?: string; kind?: number }
    return new BackendRpcError(e.message || 'backend error', e.kind)
  } catch {
    return new BackendRpcError('backend error')
  }
}

export class Rpc {
  private cache = new Map<string, { info: MethodInfo; req: Type; res: Type }>()

  constructor(private transport: Transport) {}

  private resolve(name: string) {
    let hit = this.cache.get(name)
    if (!hit) {
      const info = table[name]
      if (!info) throw new Error(`unknown backend method ${name}`)
      const rpc = (root.lookupService(info.svc) as Service).methods[info.rpc]
      rpc.resolve()
      hit = { info, req: rpc.resolvedRequestType!, res: rpc.resolvedResponseType! }
      this.cache.set(name, hit)
    }
    return hit
  }

  /** `call('answerCard', {...})` — camelCase method and field names, plain objects in and out. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async call(name: string, request: Record<string, unknown> = {}): Promise<any> {
    const { info, req, res } = this.resolve(name)
    const bytes = req.encode(req.fromObject(request)).finish()
    const out = await this.transport.run(info.s, info.m, bytes)
    return res.toObject(res.decode(out), OUT)
  }

  /** For the "legacy" calls that carry JSON in a `Json { bytes json }` message. */
  async json(name: string, value?: unknown): Promise<unknown> {
    const { info, req, res } = this.resolve(name)
    const payload = value === undefined ? {} : { json: new TextEncoder().encode(JSON.stringify(value)) }
    const out = await this.transport.run(info.s, info.m, req.encode(req.fromObject(payload)).finish())
    const msg = res.decode(out) as unknown as { json?: Uint8Array }
    return msg.json && msg.json.length ? JSON.parse(new TextDecoder().decode(msg.json)) : null
  }
}
