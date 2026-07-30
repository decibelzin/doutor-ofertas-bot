import fs from 'node:fs';
import path from 'node:path';
import { logger } from '../logger';

/**
 * LANDINGS - uma página por nicho, servida em /<slug>.
 *
 * Por que uma por nicho e não uma só com seletor: o crawler do WhatsApp não
 * executa JS, então o og:image é fixo no HTML. Página única = card genérico
 * pra todo mundo, e é no card que o clique é ganho. Além disso um seletor
 * insere uma decisão antes do único toque que a página existe pra provocar.
 *
 * O conteúdo mora em config/landings.json (versionado - é copy, não segredo).
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
  /** `name` do nicho em config/niches.json - de onde saem os grupos. */
  niche: string;

  title: string;
  description: string;

  headline: string;
  /** Pedaço do headline em dourado (fica num <span class="gold">). */
  highlight: string;
  apoio: string;
  marcas: string[];
  /** Linha acima do botão. Vazio = não renderiza o bloco. */
  turma: string;
  nota: string;
  rodape: string;

  /** Convite usado enquanto o groups.json não carrega (ou se ele faltar). */
  fallbackInvite: string;

  og: LandingOg;
}

/**
 * Copy da página-raiz (o hub).
 *
 * Ela existe pra BUSCA POR MARCA: é onde cai quem digita o domínio ou procura
 * "doutor ofertas". Nenhum anúncio aponta pra cá - campanha vai direto pra
 * /<nicho>, que é a landing de conversão.
 */
export interface Hub {
  title: string;
  description: string;
  h1: string;
  apoio: string;
  rodape: string;
}

export interface LandingsFile {
  /** Origem pública, sem barra no fim. Usada nas metas Open Graph. */
  baseUrl: string;
  /** Nicho em destaque. Também é o og:image que a raiz empresta. */
  default: string;
  /** Sem isto, a raiz vira um redirect simples (comportamento antigo). */
  hub?: Hub;
  /**
   * Convite PERMANENTE do servidor do Discord (nunca expira, usos ilimitados).
   *
   * Porta alternativa pra quem não quer entrar em grupo de WhatsApp - lá os
   * outros participantes enxergam o telefone, e essa objeção é real, não
   * impressão. Ausente = a landing não mostra a alternativa.
   *
   * ⚠️ Convite do Discord expira em 7 dias por padrão. Um link com validade
   * aqui vira botão quebrado numa semana, sem erro nenhum aparecer.
   */
  discordInvite?: string;
  landings: Landing[];
}

const LANDINGS_FILE = path.resolve('config/landings.json');

/**
 * Origem pública do site, lida do config.
 *
 * Existe pra ninguém mais cravar o domínio no código: na primeira troca de
 * domínio, cada lugar hardcoded vira um bug silencioso — o card apontando pro
 * endereço velho, o /status sondando o site errado.
 */
export function baseUrlDoSite(): string {
  try {
    return loadLandings()?.baseUrl ?? '';
  } catch {
    return '';
  }
}

/**
 * URL da landing do nicho, com o canal (`?f=`) marcado.
 *
 * Serve pro rodapé do post: quando alguém encaminha uma oferta pro amigo, o
 * amigo recebe o perfume com desconto e — sem isso — NENHUMA forma de entrar
 * no grupo. Cada encaminhamento é um anúncio já pago que se perde.
 *
 * Devolve null quando o nicho não tem landing (nada de rodapé apontando pra
 * página que não existe).
 */
export function urlDaLanding(nicheName: string, fonte: string): string | null {
  const base = baseUrlDoSite();
  if (!base) return null;
  try {
    const slug = loadLandings()?.landings.find((l) => l.niche === nicheName)?.slug;
    return slug ? `${base}/${slug}?f=${fonte}` : null;
  } catch {
    return null;
  }
}

/** Hosts que são "nós" — inclui domínios antigos que ainda redirecionam. */
export function nossosHosts(): string[] {
  const base = baseUrlDoSite();
  const host = base ? new URL(base).hostname.replace(/^www\./, '') : '';
  return [host, ...DOMINIOS_ANTIGOS].filter(Boolean);
}

/**
 * Domínios que já foram oficiais e hoje só redirecionam. Ficam aqui pra que
 * tráfego vindo deles conte como navegação interna, não como origem externa.
 */
const DOMINIOS_ANTIGOS = ['doutoroferta.com.br'];

/** Campos sem os quais a página sai quebrada. */
const OBRIGATORIOS: (keyof Landing)[] = [
  'slug', 'niche', 'title', 'description', 'headline',
  'highlight', 'apoio', 'nota', 'rodape', 'fallbackInvite',
];

/**
 * Lê e valida config/landings.json.
 *
 * Devolve null quando o arquivo não existe - é o sinal de "modo antigo": uma
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
    l.turma = typeof l.turma === 'string' ? l.turma : '';
  }

  const slugs = landings.map((l) => l.slug);
  const dup = slugs.find((s, i) => slugs.indexOf(s) !== i);
  if (dup) throw new Error(`config/landings.json: slug duplicado "${dup}".`);

  const padrao = raw.default && slugs.includes(raw.default) ? raw.default : slugs[0];

  logger.info(
    { arquivo: LANDINGS_FILE, landings: slugs, padrao },
    '[Landings] Configuração carregada.'
  );

  const convite = (raw.discordInvite ?? '').trim();
  if (convite && !/^https:\/\/(discord\.gg|discord\.com\/invite)\//.test(convite)) {
    throw new Error(`config/landings.json: "discordInvite" não parece um convite do Discord: ${convite}`);
  }

  return {
    baseUrl,
    default: padrao,
    ...(raw.hub ? { hub: raw.hub } : {}),
    ...(convite ? { discordInvite: convite } : {}),
    landings,
  };
}
