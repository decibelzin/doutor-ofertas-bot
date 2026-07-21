import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config';
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
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8')) as PostRecord[];
      const cutoff = Date.now() - MAX_AGE_MS;
      return Array.isArray(raw) ? raw.filter((r) => r.ts >= cutoff) : [];
    } catch {
      return [];
    }
  }

  private save(): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(this.records, null, 2));
  }

  /** A oferta foi postada (em QUALQUER grupo) nos últimos `withinMs`? */
  wasPostedRecently(dealId: string, withinMs: number): boolean {
    const cutoff = Date.now() - withinMs;
    return this.records.some((r) => r.dealId === dealId && r.ts >= cutoff);
  }

  /** Quantas postagens desde `sinceMs` (para os tetos por hora/dia). */
  countSince(sinceMs: number): number {
    return this.records.filter((r) => r.ts >= sinceMs).length;
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
