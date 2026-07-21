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
  ml?: { categories?: string[] };
  shopee?: { keywords?: string[] };
  /** Override opcional do desconto mínimo do nicho. */
  minDiscountPercent?: number;
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
      logger.info({ nichos: niches.map((n) => n.name) }, '[Niches] Carregados de config/niches.json.');
      return niches;
    }
  } catch {
    /* arquivo ausente/inválido -> fallback abaixo */
  }

  if (config.whatsapp.groupIds.length > 0) {
    logger.info('[Niches] Sem config/niches.json — usando nicho "geral" (WHATSAPP_GROUP_IDS + /ofertas geral).');
    return [{ name: 'geral', groups: config.whatsapp.groupIds, ml: { categories: [] } }];
  }

  logger.warn('[Niches] Nenhum nicho configurado e WHATSAPP_GROUP_IDS vazio — nada a postar.');
  return [];
}
