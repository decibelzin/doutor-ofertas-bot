import fs from 'node:fs';
import path from 'node:path';

/**
 * Fichas curadas por produto ("presets") + limpeza automática de título.
 *
 * O bot continua raspando o ML normalmente (preço, desconto, link e imagem vêm
 * do anúncio). A ficha é só um OVERLAY opcional por produto:
 *
 *   { "match": "afnan 9pm",                       // acha o produto no título do anúncio
 *     "nome": "Afnan 9PM",                        // nome limpo que aparece
 *     "descricao": "🍐 O CAPITÃO USA ESSE NA BALADA",  // headline chamativa (negrito)
 *     "imagem": "https://..." }                   // opcional; vazio = usa a do anúncio
 *
 * `match` é substring (ignora acento/caixa) procurada no título cru do anúncio;
 * se omitido, usa o próprio `nome`. Só `nome` é obrigatório.
 *
 * Pros produtos SEM ficha, `cleanTitle` corta o "título SEO" gigante do ML
 * (mantém marca + linha + volume). Config em config/presets.json (gitignored).
 */

export interface Preset {
  /**
   * Palavra(s) que precisam aparecer no título do anúncio pra casar. String
   * vira lista de palavras (AND: TODAS precisam estar, em qualquer ordem). Se
   * omitido, usa o próprio `nome`. Ex.: ["212", "vip"] casa "Carolina Herrera
   * 212 VIP Men" mas a ficha só "212" NÃO casa o VIP (ver `not`).
   */
  match?: string | string[];
  /** Exclusões: se QUALQUER uma aparecer, a ficha NÃO casa (desempata linhas iguais). */
  not?: string | string[];
  /** Id do ML (ex.: "MLB123456") - casa cravado, sem ambiguidade. */
  id?: string;
  nome: string;
  descricao?: string;
  imagem?: string;
  /** Notas do perfume (3-5), exibidas na mensagem. Ex.: ["Bergamota","Pimenta","Ambroxan"]. */
  notas?: string[];
}

interface PresetsConfig {
  presets: Preset[];
  brands: string[];
}

const PRESETS_FILE = path.resolve('config/presets.json');
const MAX_LEN = 70;

// Marcas/linhas de perfume comuns - ajudam a achar o pedaço certo do título.
const DEFAULT_BRANDS = [
  'Lancôme', 'O Boticário', 'Boticário', 'Eudora', 'Natura', 'Avon',
  'Lattafa', 'Armaf', 'Al Haramain', 'Afnan', 'Calvin Klein', 'Paco Rabanne',
  'Carolina Herrera', 'Dior', 'Versace', 'Giorgio Armani', 'Armani',
  'Hugo Boss', 'Dolce & Gabbana', 'Montblanc', 'Azzaro', 'Jean Paul Gaultier',
  'Ferrari', 'Antonio Banderas', 'Shakira', 'Prada', 'Yves Saint Laurent',
  'Bvlgari', 'Givenchy', 'Kaiak', 'Malbec', 'Egeo', 'Quasar', 'Zaad',
];

// Um segmento QUE COMEÇA com um destes é palavra-chave, não nome (testado sem acento).
const FLUFF_SEGMENT =
  /^(perfum|fragranc|arom|frasco|kit|combo|linha|eau de|deo|colonia|body|desodorante|hidratante|locao|spray|apresenta)/;

// Tokens de enchimento removidos das pontas/meio do nome escolhido.
const FLUFF_TOKENS =
  /\b(eau de parfum|eau de toilette|edp|edt|deo[\s-]?col[oôó]nia|col[oôó]nia|perfume|masculin[oa]|feminin[oa]|unissex|importad[oa]|original|lacrad[oa]|para)\b/gi;

let cache: PresetsConfig | null = null;

function load(): PresetsConfig {
  if (cache) return cache;
  let presets: Preset[] = [];
  let brands = DEFAULT_BRANDS;
  try {
    const raw = JSON.parse(fs.readFileSync(PRESETS_FILE, 'utf8')) as Partial<PresetsConfig>;
    if (Array.isArray(raw.presets)) {
      presets = raw.presets.filter((p): p is Preset => Boolean(p && p.nome));
    }
    if (Array.isArray(raw.brands) && raw.brands.length) {
      brands = [...raw.brands, ...DEFAULT_BRANDS];
    }
  } catch {
    /* sem arquivo -> só heurística com marcas padrão */
  }
  cache = { presets, brands };
  return cache;
}

/** Remove acentos e baixa a caixa, pra comparar sem se importar com diacrítico. */
export function norm(s: string): string {
  return s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

/**
 * Quebra um match/not em GRUPOS de alternativas. Cada palavra vira um requisito
 * (AND entre palavras); dentro da palavra, `/` são alternativas (OR). Ex.:
 * "one/1 million" -> [["one","1"], ["million"]] = (one OU 1) E million.
 */
function toGroups(v?: string | string[]): string[][] {
  if (!v) return [];
  const arr = Array.isArray(v) ? v : [v];
  return arr
    .flatMap((s) => norm(s).split(/\s+/))
    .map((word) => word.split('/').map((a) => a.replace(/[^a-z0-9]+/g, '')).filter(Boolean))
    .filter((group) => group.length > 0);
}

/** O grupo está satisfeito se QUALQUER uma das alternativas aparece como palavra. */
function groupPresent(hayNorm: string, group: string[]): boolean {
  return group.some((alt) => hasWord(hayNorm, alt));
}

/**
 * Vira o token num padrão que tolera espaço na virada dígito↔letra: "9pm" casa
 * tanto "9pm" quanto "9 PM" (grafia comum de perfume estilizado). Ex.: "9pm" ->
 * "9\s*pm". Tokens são alfanuméricos (a-z0-9), então nada precisa ser escapado.
 */
function tokenPattern(token: string): string {
  let out = '';
  for (let i = 0; i < token.length; i += 1) {
    if (i > 0) {
      const prevDigit = token[i - 1]! >= '0' && token[i - 1]! <= '9';
      const curDigit = token[i]! >= '0' && token[i]! <= '9';
      if (prevDigit !== curDigit) out += '\\s*';
    }
    out += token[i];
  }
  return out;
}

/** `token` (já normalizado, alfanumérico) aparece como PALAVRA INTEIRA no texto? */
export function hasWord(hayNorm: string, token: string): boolean {
  return new RegExp(`(?:^|[^a-z0-9])${tokenPattern(token)}(?:[^a-z0-9]|$)`).test(hayNorm);
}

function idMatches(p: Preset, idNorm: string): boolean {
  return Boolean(p.id && idNorm && idNorm.includes(norm(p.id)));
}

/** nº de palavras exigidas no `match` - quanto mais, mais específica a ficha. */
function specificity(p: Preset): number {
  return toGroups(p.match ?? p.nome).length;
}

/**
 * Acha a ficha certa pro anúncio. Casa quando: o `id` bate (crava), OU todas as
 * palavras de `match` aparecem no título E nenhuma de `not`. Entre as que casam,
 * ganha a mais específica (id > mais palavras > palavras mais longas).
 */
export function resolvePreset(rawTitle: string, itemId?: string): Preset | null {
  return pickPreset(load().presets, rawTitle, itemId);
}

// Termos de CONCENTRAÇÃO são ruído que colide com nomes de flanker (ex.: "Sauvage
// Parfum" vs "Sauvage Eau de Parfum"). São removidos do título antes do match -
// logo, não servem como `match`/`not`; pra separar flanker "Parfum" use `id`.
const CONCENTRATION =
  /\b(eau de parfum|eau de toilette|eau de cologne|edp|edt|edc|parfum|toilette|cologne|colonia|deo[\s-]?colonia)\b/g;

/** Remove os termos de concentração de um texto JÁ normalizado (norm()). */
export function stripConcentration(hayNorm: string): string {
  return hayNorm.replace(CONCENTRATION, ' ');
}

/** Núcleo puro do matching (sem I/O) - recebe as fichas explicitamente. Testável. */
export function pickPreset(presets: Preset[], rawTitle: string, itemId?: string): Preset | null {
  const hay = norm(rawTitle ?? '').replace(CONCENTRATION, ' ');
  const idNorm = norm(itemId ?? '');

  const candidates = presets.filter((p) => {
    const excluded = toGroups(p.not).some((g) => groupPresent(hay, g));
    if (excluded) return false;
    if (idMatches(p, idNorm)) return true;
    if (p.id && !p.match) return false; // ficha só-id: se o id não bateu, acabou
    const groups = toGroups(p.match ?? p.nome);
    return groups.length > 0 && groups.every((g) => groupPresent(hay, g));
  });

  if (candidates.length === 0) return null;

  const charLen = (p: Preset): number => toGroups(p.match ?? p.nome).flat().join('').length;
  candidates.sort((a, b) => {
    const idDelta = Number(idMatches(b, idNorm)) - Number(idMatches(a, idNorm));
    if (idDelta !== 0) return idDelta;
    const specDelta = specificity(b) - specificity(a);
    if (specDelta !== 0) return specDelta;
    return charLen(b) - charLen(a);
  });

  return candidates[0] ?? null;
}

/** "Frasco com 150 ml" -> "150ml" (ou null). */
function extractVolume(title: string): string | null {
  const m = title.match(/(\d+)\s?ml\b/i);
  return m ? `${m[1]}ml` : null;
}

/** Tira tokens de enchimento e pontuação solta das pontas. */
function tidy(s: string): string {
  return s
    .replace(FLUFF_TOKENS, ' ')
    .replace(/\s{2,}/g, ' ')
    /* ⚠️ O hífen fica no FIM da classe de propósito. Já esteve escrito
       `[\s,;.\--|]`, onde o `\-` seguido de `-|` virava um INTERVALO de U+002D
       a U+007C - ou seja, todo dígito, todo A-Z, todo a-z e quase toda
       pontuação. O efeito era comer as pontas do nome até bater num caractere
       fora da faixa (um acento): "Trésor Lancôme" saía "ésor Lancô". E em
       título sem acento a classe engolia a string inteira, o resultado vazio
       era descartado e o cleanTitle caía no `?? raw` - então ele NUNCA limpou
       nada, só parecia funcionar. */
    .replace(/^[\s,;.|-]+|[\s,;.|-]+$/g, '')
    .trim();
}

function truncate(s: string): string {
  if (s.length <= MAX_LEN) return s;
  const cut = s.slice(0, MAX_LEN);
  const lastSpace = cut.lastIndexOf(' ');
  return `${cut.slice(0, lastSpace > 30 ? lastSpace : MAX_LEN).trim()}…`;
}

/** Encurta o "título SEO" do ML pro nome real (fallback pros produtos sem ficha). */
export function cleanTitle(rawTitle: string): string {
  const { brands } = load();
  const raw = (rawTitle ?? '').trim();
  if (!raw) return raw;

  const volume = extractVolume(raw);
  const tidied = raw
    .split(/[,/]/)
    .map((s) => ({ raw: s.trim(), clean: tidy(s) }))
    .filter((x) => x.clean.length > 1);

  let name: string;
  const brandOnes = tidied.filter((x) => brands.some((b) => norm(x.clean).includes(norm(b))));
  if (brandOnes.length) {
    // Com marca: pega o mais completo (linha + marca), tipo "La Vie Est Belle Lancôme".
    name = brandOnes.sort((a, b) => b.clean.length - a.clean.length)[0]!.clean;
  } else {
    // Sem marca: descarta clausulas de palavra-chave e pega o mais curto (nome é curto).
    const nonFluff = tidied.filter((x) => !FLUFF_SEGMENT.test(norm(x.raw)));
    const pool = nonFluff.length ? nonFluff : tidied;
    name = pool.sort((a, b) => a.clean.length - b.clean.length)[0]?.clean ?? raw;
  }

  if (volume && !/\d+\s?ml\b/i.test(name)) name = `${name} ${volume}`;

  return truncate(name.replace(/\s{2,}/g, ' ').trim()) || raw;
}

/** Nome de exibição: da ficha se houver, senão o título limpo. */
export function displayName(rawTitle: string): string {
  return resolvePreset(rawTitle)?.nome ?? cleanTitle(rawTitle);
}
