export declare const PROTOCOL_VERSION: string

export declare const VISIBILITY: {
  readonly PRIVATE: 'private'
  readonly PUBLIC: 'public'
  readonly GROUP: 'group'
}
export type Visibility = 'private' | 'public' | 'group'

export type FailureCode =
  | 'provider_auth'
  | 'provider_quota'
  | 'provider_rate'
  | 'provider_timeout'
  | 'gem_unavailable'
  | 'gem_cookie_expired'
  | 'browser_launch_failed'
  | 'db_locked'
  | 'db_corrupt'
  | 'config_invalid'
  | 'budget_exhausted'
  | 'context_guard'
  | 'window_closed'
  | 'interrupted'
  | 'unknown'

export declare const FAILURE_CODES: { readonly [K: string]: FailureCode }
export declare const CHANNEL_OPS: readonly ['ingest', 'outbox', 'ack']
export type ChannelOp = 'ingest' | 'outbox' | 'ack'

/** The finite set of controls a gem may declare for its config UI. */
export type ConfigFieldType = 'text' | 'textarea' | 'number' | 'boolean' | 'select' | 'list'
export declare const CONFIG_FIELD_TYPES: readonly ConfigFieldType[]
export type ConfigItemType = 'string' | 'number'
export declare const CONFIG_ITEM_TYPES: readonly ConfigItemType[]

export interface ConfigOption {
  value: string
  label: string
}

export interface ConfigField {
  key: string
  label: string
  type: ConfigFieldType
  default?: string | number | boolean | Array<string | number>
  help?: string
  placeholder?: string
  unit?: string
  min?: number
  max?: number
  step?: number
  required?: boolean
  group?: string
  options?: ConfigOption[]
  itemType?: ConfigItemType
}

export interface ConfigDeclaration {
  fields: ConfigField[]
}

export type IngestKind = 'message' | 'notice' | 'change'
export declare const INGEST_KINDS: readonly IngestKind[]

export declare const ENDPOINTS: {
  readonly ingest: '/living/ingest'
  readonly outbox: '/living/outbox'
  readonly ack: (id: string) => string
}

export interface McpDeclaration {
  command: string
  args?: string[]
  tools?: string[]
  env?: Record<string, string>
}

export interface EventDeclaration {
  protocol: ChannelOp[]
  visibility: Visibility
}

export type NotifyMode = 'ring' | 'silent'
export declare const NOTIFY_MODES: readonly NotifyMode[]

export interface NotifyBudget {
  /** 日额度耗尽时这一轮还跑不跑；false 同时关闭单轮 token 闸 */
  limit?: boolean
  /** token 与轮次数是否计入日预算 */
  count?: boolean
}

export interface NotifyPolicy {
  mode?: NotifyMode
  budget?: NotifyBudget
}

export interface NotifyDeclaration {
  push?: NotifyPolicy
  trusted?: NotifyPolicy
}

export interface ChannelDeclaration {
  command: string
  args?: string[]
}

export interface Limits {
  maxChars?: number
  perMinute?: number
  windowHours?: number
  [key: string]: number | undefined
}

export interface WorldGemManifest {
  id: string
  name: string
  version: string
  description?: string
  mcp?: McpDeclaration
  event?: EventDeclaration
  channel?: ChannelDeclaration
  notify?: NotifyDeclaration
  skill?: string
  capabilities?: Record<string, boolean>
  limits?: Limits
  etiquette?: string[]
  failure_hints?: Partial<Record<FailureCode, string>>
  config?: ConfigDeclaration
}

export interface NormalizedIngest {
  gem: string
  kind: IngestKind
  external_id: string
  from: { id: string; name: string }
  text: string
  ts: number | null
  meta: Record<string, unknown>
}

export interface OutboxItem {
  id: string
  gem: string
  to: string
  text: string
  media?: unknown
  visibility?: Visibility
  origin?: 'event' | 'proactive'
  attempts: number
  created_at: number
}

export declare class ProtocolError extends Error {
  code: string
  details: Record<string, unknown>
}

export declare const ERR: {
  readonly MANIFEST_INVALID: 'manifest_invalid'
  readonly INGEST_INVALID: 'ingest_invalid'
  readonly ACK_INVALID: 'ack_invalid'
}

export declare function isRetryable(code: string): boolean

export declare function validateWorldGem(manifest: unknown): {
  ok: boolean
  errors: Array<{ path: string; message: string }>
}

/** Validate submitted values against a manifest's declared config fields; unknown keys are allowed. */
export declare function validateGemConfigValues(fields: ConfigField[], config: unknown): {
  ok: boolean
  errors: Array<{ path: string; message: string }>
}

export declare function normalizeIngest(payload: unknown): NormalizedIngest

export declare function validateAck(body: unknown): {
  ok: boolean
  code: FailureCode | null
  external_id: string | null
  quota: { day: string; cap: number; sent: number } | null
}
