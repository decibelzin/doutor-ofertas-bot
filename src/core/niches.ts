import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config';
import { logger } from '../logger';

/**
 * Nicho = um segmento (perfumes, fitness, saúde...) com seus próprios grupos e
 * suas fontes. Cada nicho posta só as ofertas que casam com ele.
 *
 * Fonte por nicho:
 *  - ml.categories: IDs de categoria do ML (ex.: "MLB6284" = Perfumes). O bot
 *    raspa a página /ofertas?category=<id> de cada uma.
 *  - shopee.keywords: palavras pra buscar na API da Shopee (quando liberada).
 *
 * Config em config/niches.json (gitignored). Sem esse arquivo, cai num nicho
 * "geral" com os grupos de WHATSAPP_GROUP_IDS e a /ofertas geral.
 */
export interface Niche {
  name: string;
  groups: string[];
  /** ML: `searchTerms` puxa do hub de afiliado (catálogo inteiro); `categories` é o fallback da página de ofertas. */
  ml?: { categories?: string[]; searchTerms?: string[] };
  shopee?: { keywords?: string[] };
  /** Override opcional do desconto mínimo do nicho. */
  minDiscountPercent?: number;
  /** Override opcional da avaliação mínima (0–5). */
  minRating?: number;
  /** Override opcional do intervalo (min) entre posts deste nicho. */
  intervalMinutes?: number;
}

const NICHES_FILE = path.resolve('config/niches.json');

export function loadNiches(): Niche[] {
  try {
    const raw = JSON.parse(fs.readFileSync(NICHES_FILE, 'utf8')) as Niche[];
    const niches = (Array.isArray(raw) ? raw : []).filter(
      (n) => n && n.name && Array.isArray(n.groups) && n.groups.length > 0
    );
    if (niches.length > 0) {
      logger.info(
        { fonte: 'config/niches.json', nichos: niches.map((n) => ({ nome: n.name, grupos: n.groups.length })) },
        '[Niches] Grupos carregados (fonte única = config/niches.json).'
      );
      return niches;
    }
  } catch {
    /* arquivo ausente/inválido -> fallback abaixo */
  }

  if (config.whatsapp.groupIds.length > 0) {
    logger.info(
      { fonte: 'WHATSAPP_GROUP_IDS (.env, fallback)', grupos: config.whatsapp.groupIds.length },
      '[Niches] Sem config/niches.json — usando nicho "geral" com os grupos do .env.'
    );
    return [{ name: 'geral', groups: config.whatsapp.groupIds, ml: { categories: [] } }];
  }

  logger.warn('[Niches] Nenhum nicho configurado e WHATSAPP_GROUP_IDS vazio — nada a postar.');
  return [];
}
