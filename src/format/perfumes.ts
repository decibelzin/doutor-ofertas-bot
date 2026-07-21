import fs from 'node:fs';
import path from 'node:path';
import { norm, hasWord, stripConcentration } from './title';

/**
 * Enriquecimento AUTOMÁTICO de notas a partir de um banco local de perfumes
 * (data/perfumes.json, derivado do dataset doevent/perfume — Fragrantica).
 *
 * Casa o título raspado do ML → o perfume certo no banco → devolve as notas (PT).
 * Reusa a mesma lógica do matcher de ficha (palavra inteira, mais específico
 * ganha) só que dentro do balde da MARCA, com TRAVA DE AMBIGUIDADE: se sobra
 * mais de um nome distinto empatado, devolve null (nunca manda nota errada).
 */

export interface PerfumeRec {
  marca: string;
  nome: string;
  notas: string[];
}

const DATA_FILE = path.resolve('data/perfumes.json');
const MAX_NOTAS = 6;

interface Entry {
  notas: string[];
  nameTokens: string[];
  key: string;
}
interface Brand {
  tokens: string[];
  entries: Entry[];
}

// Abreviações de marca comuns no ML: se `when` aparece no título, injeto os
// tokens `add` (como a marca está no dataset) pra detecção funcionar.
const ALIASES: Array<{ when: string[]; add: string[] }> = [
  { when: ['ysl'], add: ['yves', 'saint', 'laurent'] },
  { when: ['ck'], add: ['calvin', 'klein'] },
  { when: ['jpg'], add: ['jean', 'paul', 'gaultier'] },
  { when: ['dg'], add: ['dolce', 'gabbana'] },
  { when: ['mont', 'blanc'], add: ['montblanc'] },
  { when: ['paco', 'rabanne'], add: ['rabanne'] },
];

let brands: Map<string, Brand> | null = null;
let tokenToBrand: Map<string, string[]> | null = null;

// "Pour Homme/Femme", "For Men" etc. são descritores de gênero que o dataset mete
// no nome mas o título do ML não tem. (Só a FRASE — "Homme" sozinho é nome, ex.: Dior Homme.)
const NOISE = /\b(pour homme|pour femme|pour elle|pour lui|for men|for women|for him|for her|for man|for woman)\b/g;

/** Normaliza + tira elisão francesa ("l'eau"->"eau") + "pour homme" + concentração. */
function prep(s: string): string {
  return stripConcentration(
    norm(s)
      .replace(/\b[a-z]'/g, '')
      .replace(NOISE, ' ')
  );
}

function toks(s: string): string[] {
  return prep(s)
    .split(/\s+/)
    .map((t) => t.replace(/[^a-z0-9]+/g, ''))
    .filter(Boolean);
}

function load(): void {
  if (brands) return;
  brands = new Map();
  tokenToBrand = new Map();
  let recs: PerfumeRec[];
  try {
    recs = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')) as PerfumeRec[];
  } catch {
    return; // sem banco -> lookup sempre null (cai no fallback sem notas)
  }
  for (const r of recs) {
    if (!r || !r.marca || !r.nome || !Array.isArray(r.notas) || r.notas.length === 0) continue;
    const bKey = norm(r.marca);
    let b = brands.get(bKey);
    if (!b) {
      b = { tokens: toks(r.marca), entries: [] };
      brands.set(bKey, b);
      for (const t of b.tokens) {
        const arr = tokenToBrand.get(t) ?? [];
        arr.push(bKey);
        tokenToBrand.set(t, arr);
      }
    }
    const bSet = new Set(b.tokens);
    // toks() já tira concentração/elisão do nome (o título também vem assim) —
    // senão "Sauvage Eau de Parfum" nunca casaria com o título raspado.
    const nameTokens = toks(r.nome).filter((t) => !bSet.has(t));
    if (nameTokens.length === 0) continue; // nome == marca (ou só concentração): não distingue
    b.entries.push({ notas: r.notas, nameTokens, key: nameTokens.join(' ') });
  }
}

/**
 * Acha as notas do perfume do título (ou null se não achar com segurança).
 * @param max quantas notas devolver (padrão 6).
 */
export function lookupNotas(rawTitle: string, max = MAX_NOTAS): string[] | null {
  load();
  if (!brands || !tokenToBrand) return null;

  const hay = prep(rawTitle ?? '');
  const titleTokens = new Set(
    hay
      .split(/\s+/)
      .map((t) => t.replace(/[^a-z0-9]+/g, ''))
      .filter(Boolean)
  );

  // Aliases: "ysl" -> injeta "yves saint laurent", "mont blanc" -> "montblanc" etc.
  for (const a of ALIASES) {
    if (a.when.every((t) => titleTokens.has(t))) for (const t of a.add) titleTokens.add(t);
  }

  // 1) Marcas presentes no título (todas as palavras da marca precisam aparecer).
  const candBrandKeys = new Set<string>();
  for (const t of titleTokens) for (const bk of tokenToBrand.get(t) ?? []) candBrandKeys.add(bk);

  const presentBrands: Brand[] = [];
  for (const bk of candBrandKeys) {
    const b = brands.get(bk)!;
    if (b.tokens.every((t) => titleTokens.has(t))) presentBrands.push(b);
  }
  if (presentBrands.length === 0) return null;

  // 2) Perfume mais específico cujo nome inteiro aparece no título.
  let best: Entry[] = [];
  let bestSpec = 0;
  for (const b of presentBrands) {
    for (const e of b.entries) {
      if (!e.nameTokens.every((t) => hasWord(hay, t))) continue;
      const spec = e.nameTokens.length;
      if (spec > bestSpec) {
        bestSpec = spec;
        best = [e];
      } else if (spec === bestSpec) {
        best.push(e);
      }
    }
  }
  if (best.length === 0) return null;

  // Trava de ambiguidade: nomes distintos empatados no topo -> não arrisca.
  const distinctKeys = new Set(best.map((e) => e.key));
  if (distinctKeys.size > 1) return null;

  return best[0]!.notas.slice(0, max);
}

/**
 * O perfume do título existe no banco (Fragrantica) com casamento seguro?
 * Serve de filtro de qualidade: só postar o que é perfume conhecido de verdade
 * (corta marca no-name tipo "Vonter Voker" e deo-colônia nacional obscuro).
 */
export function isInBank(rawTitle: string): boolean {
  return lookupNotas(rawTitle) !== null;
}
