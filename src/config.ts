import 'dotenv/config';

function num(value: string | undefined, fallback: number): number {
  if (value === undefined || value === '') return fallback;
  const n = Number(value);
  return Number.isNaN(n) ? fallback : n;
}

function list(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

export interface Config {
  logLevel: string;
  timezone: string;
  whatsapp: {
    sessionDir: string;
    groupIds: string[];
  };
  throttle: {
    groupDelayMinMs: number;
    groupDelayMaxMs: number;
  };
}

export const config: Config = {
  logLevel: process.env.LOG_LEVEL ?? 'info',
  timezone: process.env.TIMEZONE ?? 'America/Sao_Paulo',
  whatsapp: {
    sessionDir: process.env.SESSION_DIR ?? './data/auth',
    groupIds: list(process.env.WHATSAPP_GROUP_IDS),
  },
  throttle: {
    groupDelayMinMs: num(process.env.GROUP_DELAY_MIN_MS, 30_000),
    groupDelayMaxMs: num(process.env.GROUP_DELAY_MAX_MS, 90_000),
  },
};
