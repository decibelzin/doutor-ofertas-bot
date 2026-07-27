import 'dotenv/config';
import path from 'node:path';

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
    // Re-postar dentro do cooldown SE o desconto atual melhorar N pontos vs o
    // melhor já postado (captura re-preço quente). 0 = desliga o bypass.
    repriceBypassPoints: number;
  };
  coupon: {
    // Caminho da imagem-banner do cupom (fixa, reusada). Vazio = manda só texto.
    bannerPath: string;
    // Link de busca opcional no rodapé do cupom (ex.: meli.la/...).
    searchLink: string;
    // Automação no scheduler: descobrir cupons + postar perfume+cupom sozinho.
    // Ligado por padrão quando há cookie/csrf do painel (COUPON_AUTO=false desliga).
    auto: boolean;
    // De quanto em quanto tempo atualizar o cache de cupons (horas).
    discoveryIntervalHours: number;
    // Intervalo entre posts de cupom (min); ainda respeita os tetos anti-ban.
    postIntervalMinutes: number;
    // Teto de páginas por varredura de descoberta (~507 = pool inteiro).
    maxPages: number;
    // Anunciar automaticamente ("CUPOM LIBERADO") quando surgir código novo.
    announceAuto: boolean;
    // De quanto em quanto tempo checar se há código novo (min).
    announceCheckMinutes: number;
    // Intervalo MÍNIMO entre dois anúncios (horas) — @all é sensível a spam.
    announceMinGapHours: number;
    // Quantos cupons de site inteiro (agregador) entram na mensagem.
    announceMaxFeedCoupons: number;
  };
  filter: {
    // Só postar perfume que a gente casa no banco (Fragrantica) OU que está fichado.
    // Corta marca no-name e produto obscuro. Ligado por padrão.
    onlyKnownPerfumes: boolean;
  };
  store: {
    file: string;
  };
  admin: {
    // Grupo/chat JID que recebe alertas de saúde (ex.: cookie expirado). Vazio = só loga.
    alertGroup: string;
  };
  site: {
    // Raiz servida pelo nginx. Cada nicho vira uma pasta: <dir>/<slug>/.
    // Default: a pasta de groupsFile, pra quem já tinha SITE_GROUPS_FILE no .env.
    dir: string;
    // Arquivo JSON que o SITE lê (bot e site na mesma VPS -> escreve direto na
    // pasta servida). Ex.: /var/www/doutorofertas/groups.json
    // LEGADO: só usado quando não há config/landings.json (site de nicho único).
    groupsFile: string;
    // Logs do nginx que alimentam o funil (visitas e cliques no CTA).
    logAcessos: string;
    logCliques: string;
    // Teto OPERACIONAL por grupo (folga sobre os 1024 do WhatsApp, evita corrida).
    groupLimit: number;
    // De quanto em quanto tempo atualizar o status dos grupos (min). 0 = desliga.
    refreshMinutes: number;
  };
  discord: {
    // Token do bot. Vazio = o serviço do Discord nem sobe.
    token: string;
    // ID da aplicação (usado pra registrar os slash commands).
    clientId: string;
    // Servidor onde os comandos são registrados. Registro por guild aparece na
    // hora; o global leva até 1h pra propagar.
    guildId: string;
    // De quanto em quanto tempo o painel do funil se reescreve. 0 = desliga
    // (fica só o botão Atualizar).
    funilRefreshMinutes: number;
  };
  moderation: {
    // Emojis que, reagidos num anúncio, VETAM aquele produto pra sempre.
    blockEmojis: string[];
    // JIDs extra autorizados a moderar (além da própria conta do bot, que sempre vale).
    moderatorJids: string[];
  };
  shopee: {
    enabled: boolean;
    appId: string;
    appSecret: string;
    graphqlEndpoint: string;
    searchTerms: string[];
    minDiscountPercent: number;
    sortType: number;
    limitPerTerm: number;
    fallbackCoupon: string;
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
    // Avaliação mínima (0–5) pra postar um produto do hub. 0 = desligado.
    minRating: number;
    // Quantas páginas (12 itens cada) buscar por termo no hub de afiliado.
    hubPagesPerTerm: number;
    // Busca pública (lista.mercadolivre.com.br): páginas por termo (48/pág). 0 = desliga.
    searchPagesPerTerm: number;
    // TTL do cache da busca pública (min) — raspa 1x por esse período, não a cada post.
    searchTtlMinutes: number;
    // TTL do cache dos CUPONS PÚBLICOS do ML (mercadolivre.com.br/cupons), em min.
    publicCouponsTtlMinutes: number;
    // Link de afiliado: 'matt' anexa matt_word/matt_tool; 'simple' usa uma tag única.
    linkMode: 'matt' | 'simple';
    mattWord: string;
    mattTool: string;
    simpleTag: string;
    // Link curto oficial (meli.la) via endpoint interno createLink.
    // Cookie de sessão + x-csrf-token capturados do painel de afiliado.
    affiliateCookie: string;
    affiliateCsrf: string;
  };
}

const mlTerms = list(process.env.ML_SEARCH_TERMS);
const shopeeAppId = process.env.SHOPEE_APP_ID ?? '';
const shopeeAppSecret = process.env.SHOPEE_APP_SECRET ?? '';
const shopeeTerms = list(process.env.SHOPEE_SEARCH_TERMS);

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
    repriceBypassPoints: num(process.env.DEDUP_REPRICE_BYPASS_POINTS, 10),
  },
  coupon: {
    bannerPath: process.env.COUPON_BANNER_PATH ?? '',
    searchLink: process.env.COUPON_SEARCH_LINK ?? '',
    auto: bool(process.env.COUPON_AUTO, true),
    discoveryIntervalHours: num(process.env.COUPON_DISCOVERY_INTERVAL_HOURS, 8),
    postIntervalMinutes: num(process.env.COUPON_POST_INTERVAL_MINUTES, 90),
    maxPages: num(process.env.COUPON_MAX_PAGES, 600),
    announceAuto: bool(process.env.COUPON_ANNOUNCE_AUTO, true),
    announceCheckMinutes: num(process.env.COUPON_ANNOUNCE_CHECK_MINUTES, 60),
    announceMinGapHours: num(process.env.COUPON_ANNOUNCE_MIN_GAP_HOURS, 12),
    announceMaxFeedCoupons: num(process.env.COUPON_ANNOUNCE_MAX_FEED, 4),
  },
  filter: {
    onlyKnownPerfumes: bool(process.env.ONLY_KNOWN_PERFUMES, true),
  },
  store: {
    file: process.env.STORE_FILE ?? './data/posted.json',
  },
  admin: {
    alertGroup: process.env.ADMIN_ALERT_GROUP ?? '',
  },
  site: {
    dir: process.env.SITE_DIR ?? path.dirname(process.env.SITE_GROUPS_FILE ?? './website/groups.json'),
    groupsFile: process.env.SITE_GROUPS_FILE ?? './website/groups.json',
    groupLimit: num(process.env.SITE_GROUP_LIMIT, 1000),
    refreshMinutes: num(process.env.SITE_REFRESH_MINUTES, 15),
    logAcessos: process.env.SITE_LOG_ACESSOS ?? '/var/log/nginx/doutoroferta-acessos.log',
    logCliques: process.env.SITE_LOG_CLIQUES ?? '/var/log/nginx/doutoroferta-cliques.log',
  },
  discord: {
    token: process.env.DISCORD_TOKEN ?? '',
    clientId: process.env.DISCORD_CLIENT_ID ?? '',
    guildId: process.env.DISCORD_GUILD_ID ?? '',
    funilRefreshMinutes: num(process.env.DISCORD_FUNIL_REFRESH_MINUTES, 30),
  },
  moderation: {
    blockEmojis: list(process.env.MODERATION_BLOCK_EMOJIS).length
      ? list(process.env.MODERATION_BLOCK_EMOJIS)
      : ['❌', '✖️', '✖', '🚫', '❎'],
    moderatorJids: list(process.env.MODERATION_MODERATOR_JIDS),
  },
  shopee: {
    // Habilitado quando há credenciais Open API.
    enabled: Boolean(shopeeAppId && shopeeAppSecret),
    appId: shopeeAppId,
    appSecret: shopeeAppSecret,
    graphqlEndpoint:
      process.env.SHOPEE_GRAPHQL_ENDPOINT ?? 'https://open-api.affiliate.shopee.com.br/graphql',
    searchTerms: shopeeTerms.length
      ? shopeeTerms
      : ['casa', 'eletronicos', 'eletrodomesticos', 'beleza', 'moveis'],
    minDiscountPercent: num(process.env.SHOPEE_MIN_DISCOUNT_PERCENT, 20),
    sortType: num(process.env.SHOPEE_SORT_TYPE, 5),
    limitPerTerm: num(process.env.SHOPEE_LIMIT_PER_TERM, 20),
    fallbackCoupon: process.env.SHOPEE_FALLBACK_COUPON ?? '',
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
    minRating: num(process.env.ML_MIN_RATING, 4.0),
    hubPagesPerTerm: num(process.env.ML_HUB_PAGES_PER_TERM, 2),
    searchPagesPerTerm: num(process.env.ML_SEARCH_PAGES_PER_TERM, 2),
    searchTtlMinutes: num(process.env.ML_SEARCH_TTL_MINUTES, 25),
    publicCouponsTtlMinutes: num(process.env.ML_PUBLIC_COUPONS_TTL_MINUTES, 60),
    linkMode: (process.env.ML_LINK_MODE ?? 'matt').toLowerCase() === 'simple' ? 'simple' : 'matt',
    mattWord: process.env.ML_MATT_WORD ?? '',
    mattTool: process.env.ML_MATT_TOOL ?? '',
    simpleTag: process.env.ML_SIMPLE_TAG ?? '',
    affiliateCookie: process.env.ML_AFFILIATE_COOKIE ?? '',
    affiliateCsrf: process.env.ML_AFFILIATE_CSRF ?? '',
  },
};
