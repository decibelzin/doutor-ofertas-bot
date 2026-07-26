import fs from 'node:fs';
import path from 'node:path';
import { logger } from '../logger';

/**
 * LANDINGS — uma página por nicho, servida em /<slug>.
 *
 * Por que uma por nicho e não uma só com seletor: o crawler do WhatsApp não
 * executa JS, então o og:image é fixo no HTML. Página única = card genérico
 * pra todo mundo, e é no card que o clique é ganho. Além disso um seletor
 * insere uma decisão antes do único toque que a página existe pra provocar.
 *
 * O conteúdo mora em config/landings.json (versionado — é copy, não segredo).
 * Os grupos continuam vindo de config/niches.json (fora do git), ligados por
 * `niche` → `name`.
 */
export interface LandingOg {
  title: string;
  description: string;
  /** Linhas do headline na arte 1200x630. */
  linhas: string[];
  /** Linha de apoio da arte. Sem isso usa a da página, que às vezes é longa demais. */
  apoio?: string;
  /** Índice (0-based) da linha pintada em dourado. */
  destaque?: number;
  pilula?: string;
}

export interface Landing {
  /** Vira a URL: /<slug>. Também é o nome da pasta em website/. */
  slug: string;
  /** `name` do nicho em config/niches.json — de onde saem os grupos. */
  niche: string;

  title: string;
  description: string;

  headline: string;
  /** Pedaço do headline em dourado (fica num <span class="gold">). */
  highlight: string;
  apoio: string;
  marcas: string[];
  turma: string;
  nota: string;
  rodape: string;

  /** Convite usado enquanto o groups.json não carrega (ou se ele faltar). */
  fallbackInvite: string;

  og: LandingOg;
}

export interface LandingsFile {
  /** Origem pública, sem barra no fim. Usada nas metas Open Graph. */
  baseUrl: string;
  /** Slug pra onde a raiz `/` manda quem chega sem nicho. */
  default: string;
  landings: Landing[];
}

const LANDINGS_FILE = path.resolve('config/landings.json');

/** Campos sem os quais a página sai quebrada. */
const OBRIGATORIOS: (keyof Landing)[] = [
  'slug', 'niche', 'title', 'description', 'headline',
  'highlight', 'apoio', 'turma', 'nota', 'rodape', 'fallbackInvite',
];

/**
 * Lê e valida config/landings.json.
 *
 * Devolve null quando o arquivo não existe — é o sinal de "modo antigo": uma
 * landing só, servida na raiz. Assim quem ainda não migrou não quebra.
 */
export function loadLandings(): LandingsFile | null {
  let raw: Partial<LandingsFile>;
  try {
    raw = JSON.parse(fs.readFileSync(LANDINGS_FILE, 'utf8')) as Partial<LandingsFile>;
  } catch {
    return null;
  }

  const baseUrl = (raw.baseUrl ?? '').replace(/\/+$/, '');
  if (!baseUrl) throw new Error('config/landings.json: "baseUrl" é obrigatório (og:image exige URL absoluta).');

  const landings = (Array.isArray(raw.landings) ? raw.landings : []).filter(Boolean);
  if (landings.length === 0) throw new Error('config/landings.json: nenhuma landing definida.');

  for (const l of landings) {
    const faltando = OBRIGATORIOS.filter((k) => !l[k]);
    if (faltando.length > 0) {
      throw new Error(`config/landings.json: landing "${l.slug ?? '?'}" sem ${faltando.join(', ')}.`);
    }
    if (!/^[a-z0-9-]+$/.test(l.slug)) {
      throw new Error(`config/landings.json: slug "${l.slug}" inválido (use só a-z, 0-9 e hífen).`);
    }
    if (!l.og?.linhas?.length) {
      throw new Error(`config/landings.json: landing "${l.slug}" sem og.linhas (a arte 1200x630 precisa do texto).`);
    }
    l.marcas = Array.isArray(l.marcas) ? l.marcas : [];
  }

  const slugs = landings.map((l) => l.slug);
  const dup = slugs.find((s, i) => slugs.indexOf(s) !== i);
  if (dup) throw new Error(`config/landings.json: slug duplicado "${dup}".`);

  const padrao = raw.default && slugs.includes(raw.default) ? raw.default : slugs[0];

  logger.info(
    { arquivo: LANDINGS_FILE, landings: slugs, padrao },
    '[Landings] Configuração carregada.'
  );

  return { baseUrl, default: padrao, landings };
}
