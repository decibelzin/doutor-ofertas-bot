import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config';
import { logger } from '../logger';
import { writeFileAtomic } from '../util/atomic';
import type { Deal } from './deal';

/**
 * Persistência simples em arquivo JSON: histórico de postagens + dedup.
 *
 * Guarda um registro por (oferta, grupo) postado. Serve para:
 *  - não repostar a mesma oferta dentro de um cooldown (N dias);
 *  - contar postagens por hora/dia (tetos anti-ban).
 *
 * Escala do bot é pequena (dezenas/dia), então JSON basta. A interface permite
 * trocar por SQLite depois (analytics) sem mexer no resto.
 */
export interface PostRecord {
  dealId: string;
  groupId: string;
  ts: number;
  store: string;
  title: string;
  price: number;
  discount: number;
}

const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // poda registros com mais de 30 dias

class Store {
  private readonly file: string;
  private records: PostRecord[];

  constructor(file: string) {
    this.file = path.resolve(file);
    this.records = this.load();
  }

  private load(): PostRecord[] {
    let raw: string;
    try {
      raw = fs.readFileSync(this.file, 'utf8');
    } catch {
      return []; // arquivo ainda não existe (1ª execução) — normal.
    }
    try {
      const parsed = JSON.parse(raw) as PostRecord[];
      const cutoff = Date.now() - MAX_AGE_MS;
      return Array.isArray(parsed) ? parsed.filter((r) => r.ts >= cutoff) : [];
    } catch {
      // Arquivo EXISTE mas não parseia (corrupção/escrita parcial). NÃO zerar o
      // dedup em silêncio — isso causaria repost em massa (risco de ban). Preserva
      // o suspeito num .bak e alerta ALTO; segue com histórico vazio só nesta
      // sessão (a escrita atômica torna esse caso raríssimo).
      const bak = `${this.file}.corrupt-${Date.now()}.bak`;
      try {
        fs.renameSync(this.file, bak);
      } catch {
        /* melhor esforço */
      }
      logger.error(
        { file: this.file, bak },
        '[Store] posted.json ILEGÍVEL (corrompido). Preservado em .bak. Dedup vazio nesta sessão — RISCO DE REPOST; verifique o .bak.'
      );
      return [];
    }
  }

  private save(): void {
    writeFileAtomic(this.file, JSON.stringify(this.records, null, 2));
  }

  /** A oferta foi postada (em QUALQUER grupo) nos últimos `withinMs`? */
  wasPostedRecently(dealId: string, withinMs: number): boolean {
    const cutoff = Date.now() - withinMs;
    return this.records.some((r) => r.dealId === dealId && r.ts >= cutoff);
  }

  /** A oferta JÁ foi postada alguma vez (dentro do que o store retém, ~30d)? */
  hasEverPosted(dealId: string): boolean {
    return this.records.some((r) => r.dealId === dealId);
  }

  /** Maior desconto (%) já postado dessa oferta nos últimos `withinMs` (ou null). */
  bestDiscountPosted(dealId: string, withinMs: number): number | null {
    const cutoff = Date.now() - withinMs;
    let best: number | null = null;
    for (const r of this.records) {
      if (r.dealId === dealId && r.ts >= cutoff && (best === null || r.discount > best)) {
        best = r.discount;
      }
    }
    return best;
  }

  /**
   * Pode postar AGORA respeitando o cooldown? True se: nunca postado no
   * `withinMs`, OU voltou com desconto `repriceBypassPoints` melhor que o já
   * postado (re-preço quente). Usado por oferta e cupom pra decidir o dedup.
   */
  canPostNow(dealId: string, discountPercent: number, withinMs: number): boolean {
    if (!this.wasPostedRecently(dealId, withinMs)) return true;
    const bypass = config.dedup.repriceBypassPoints;
    if (bypass <= 0) return false;
    const best = this.bestDiscountPosted(dealId, withinMs);
    return best !== null && discountPercent >= best + bypass;
  }

  /** Quantas mensagens (registros por grupo) desde `sinceMs`. */
  countSince(sinceMs: number): number {
    return this.records.filter((r) => r.ts >= sinceMs).length;
  }

  /**
   * Quantas OFERTAS distintas foram postadas desde `sinceMs` (1 oferta enviada a
   * N grupos conta 1, não N). É essa a métrica dos tetos anti-ban — senão um
   * único post pra 10 grupos já estouraria um teto de 8 e travaria a cadência.
   */
  countDealsSince(sinceMs: number): number {
    const ids = new Set<string>();
    for (const r of this.records) if (r.ts >= sinceMs) ids.add(r.dealId);
    return ids.size;
  }

  /** Registra o envio de uma oferta para um grupo. */
  markPosted(deal: Deal, groupId: string, ts: number = Date.now()): void {
    this.records.push({
      dealId: deal.id,
      groupId,
      ts,
      store: deal.store,
      title: deal.title,
      price: deal.priceNow,
      discount: deal.discountPercent,
    });
    this.save();
  }
}

export const store = new Store(config.store.file);
