'use strict';

export type UserRole = 'admin' | 'user';
export type Platform = 'ctyun' | 'ydpc' | 'ecloud' | string;
export type LogLevel = 'info' | 'success' | 'warning' | 'error' | 'progress' | string;

export interface NotifyConfig {
  enabled?: boolean;
  channel?: string;
  webhookUrl?: string;
  secret?: string;
  customTitleTemplate?: string;
  customContentTemplate?: string;
  [key: string]: unknown;
}

export interface AccountFeatures {
  keepAlive?: boolean;
  autoSign?: boolean;
  aiChat?: boolean;
  cloudHang?: boolean;
  autoRedeem?: boolean;
  autoBoot?: boolean;
  ecloudL1AccountKeep?: boolean;
  ecloudL2DesktopReg?: boolean;
  [key: string]: boolean | undefined;
}

export interface Desktop {
  id?: string;
  name?: string;
  keepaliveEnabled?: boolean;
  taskEnabled?: boolean;
  autoBootEnabled?: boolean;
  [key: string]: unknown;
}

export interface Account {
  id?: string;
  name?: string;
  user?: string;
  password?: string;
  platform?: Platform;
  ownerId?: string;
  enabled?: boolean;
  deviceCode?: string;
  features?: AccountFeatures;
  desktops?: Desktop[];
  notify?: NotifyConfig;
  ecloudDeviceUid?: string;
  stats?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface AppUser {
  id: string;
  username: string;
  passwordHash: string;
  role: UserRole;
  maxQuota?: number;
  avatar?: string;
  createdAt?: string;
  notify?: NotifyConfig;
}

export interface CronSettings {
  executeTime?: string;
  enableSubCron?: boolean;
  signCron?: string;
  aiChatCron?: string;
  cloudHangCron?: string;
  redeemCron?: string;
}

export interface AppSettings {
  webPort?: number;
  keepAliveSeconds?: number;
  pulseIntervalSeconds?: number;
  allowRegistration?: boolean;
  defaultQuota?: number;
  cron?: CronSettings;
  notify?: NotifyConfig;
  systemTitle?: string;
  systemSubtitle?: string;
  [key: string]: unknown;
}

export interface AppConfig {
  version?: string;
  settings: AppSettings;
  users: AppUser[];
  accounts: Account[];
}

export interface AuthSession {
  userId: string;
  username: string;
  role: UserRole | '';
  maxQuota: number;
  remember?: boolean;
  createdAt?: number;
  expiresAt: number;
  avatar?: string;
  token?: string;
}

export interface SessionStore {
  load: () => Record<string, unknown> | null;
  save: (obj: Record<string, unknown>) => void;
}

export interface LogEntry {
  id?: number | string;
  time?: string;
  source?: string;
  message: string;
  level?: LogLevel;
  platform?: string;
  account?: string;
  count?: number;
  [key: string]: unknown;
}

export interface NotifyResult {
  success: boolean;
  message: string;
}

export interface TaskGateResult {
  enabled: boolean;
  reason: string;
}
