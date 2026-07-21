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

function bool(value: string | undefined, fallback = false): boolean {
  if (value === undefined || value === '') return fallback;
  return String(value).toLowerCase() === 'true';
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
  schedule: {
    startHour: number;
    endHour: number;
    intervalMinutes: number;
    jitterMinutes: number;
    maxPostsPerHour: number;
    maxPostsPerDay: number | null;
  };
  dedup: {
    cooldownDays: number;
  };
  store: {
    file: string;
  };
  mercadoLivre: {
    enabled: boolean;
    clientId: string;
    clientSecret: string;
    redirectUri: string;
    tokenFile: string;
    siteId: string;
    searchTerms: string[];
    minDiscountPercent: number;
    // Link de afiliado: 'matt' anexa matt_word/matt_tool; 'simple' usa uma tag única.
    linkMode: 'matt' | 'simple';
    mattWord: string;
    mattTool: string;
    simpleTag: string;
  };
}

const mlTerms = list(process.env.ML_SEARCH_TERMS);

export const config: Config = {
  logLevel: process.env.LOG_LEVEL ?? 'info',
  timezone: process.env.TIMEZONE ?? 'America/Sao_Paulo',
  whatsapp: {
    sessionDir: process.env.SESSION_DIR ?? './data/auth',
    groupIds: list(process.env.WHATSAPP_GROUP_IDS),
  },
  throttle: {
    groupDelayMinMs: num(process.env.GROUP_DELAY_MIN_MS, 5_000),
    groupDelayMaxMs: num(process.env.GROUP_DELAY_MAX_MS, 20_000),
  },
  schedule: {
    startHour: num(process.env.START_HOUR, 8),
    endHour: num(process.env.END_HOUR, 22),
    intervalMinutes: num(process.env.POST_INTERVAL_MINUTES, 8),
    jitterMinutes: num(process.env.POST_JITTER_MINUTES, 3),
    maxPostsPerHour: num(process.env.MAX_POSTS_PER_HOUR, 8),
    maxPostsPerDay: process.env.MAX_POSTS_PER_DAY ? Number(process.env.MAX_POSTS_PER_DAY) : null,
  },
  dedup: {
    cooldownDays: num(process.env.DEDUP_COOLDOWN_DAYS, 3),
  },
  store: {
    file: process.env.STORE_FILE ?? './data/posted.json',
  },
  mercadoLivre: {
    enabled: bool(process.env.ML_ENABLED, false),
    clientId: process.env.ML_CLIENT_ID ?? '',
    clientSecret: process.env.ML_CLIENT_SECRET ?? '',
    redirectUri: process.env.ML_REDIRECT_URI ?? 'https://example.com',
    tokenFile: process.env.ML_TOKEN_FILE ?? './data/ml_token.json',
    siteId: process.env.ML_SITE_ID ?? 'MLB',
    searchTerms: mlTerms.length ? mlTerms : ['casa', 'eletronicos', 'eletrodomesticos', 'beleza'],
    minDiscountPercent: num(process.env.ML_MIN_DISCOUNT_PERCENT, 15),
    linkMode: (process.env.ML_LINK_MODE ?? 'matt').toLowerCase() === 'simple' ? 'simple' : 'matt',
    mattWord: process.env.ML_MATT_WORD ?? '',
    mattTool: process.env.ML_MATT_TOOL ?? '',
    simpleTag: process.env.ML_SIMPLE_TAG ?? '',
  },
};
