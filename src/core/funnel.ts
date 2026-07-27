import fs from 'node:fs';
import zlib from 'node:zlib';
import path from 'node:path';
import { config } from '../config';
import { nossosHosts } from './landing';
import { logger } from '../logger';

/**
 * FUNIL DA LANDING lido direto dos logs do nginx.
 *
 * Não há pixel nem cookie: o formato `combined` do nginx já registra IP,
 * caminho, horário, referrer e user-agent - que é tudo que o funil precisa.
 *
 * Dois arquivos:
 *  - acessos: toda requisição ao site (visita = GET numa página de nicho)
 *  - cliques: só a rota /e, que o CTA chama via navigator.sendBeacon
 *
 * ⚠️ sendBeacon manda **POST**, não GET. Procurar só por GET conta zero clique
 * real e ainda casa com os `curl` de verificação - ou seja, mediria o próprio
 * ruído. Por isso `MetodoClique` aceita os dois.
 */

/** Uma linha do formato `combined` do nginx. */
interface Linha {
  ip: string;
  quando: Date;
  metodo: string;
  caminho: string;
  status: number;
  referrer: string;
  agente: string;
}

const COMBINED =
  /^(\S+) \S+ \S+ \[([^\]]+)\] "(\S+) (\S+)[^"]*" (\d{3}) \S+ "([^"]*)" "([^"]*)"/;

const MESES: Record<string, number> = {
  Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5,
  Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11,
};

/** Robô não é gente. Sem isso o próprio raspador de link do WhatsApp - que
 *  busca a página toda vez que alguém compartilha - entra como visita e afunda
 *  a taxa de clique. */
const ROBOS =
  /bot|crawler|spider|facebookexternalhit|whatsapp|discordbot|twitterbot|slackbot|telegrambot|curl|wget|headlesschrome|python-requests|go-http|monitoring|uptime/i;

/** Página de nicho: /perfumes ou /perfumes/ - um segmento, sem extensão. */
const PAGINA_NICHO = /^\/[a-z0-9-]+\/?$/;

/** `27/Jul/2026:14:05:44 +0000` - o nginx não escreve ISO. */
function parseData(bruto: string): Date | null {
  const m = /^(\d{2})\/(\w{3})\/(\d{4}):(\d{2}):(\d{2}):(\d{2}) ([+-]\d{4})$/.exec(bruto);
  if (!m) return null;
  const mes = MESES[m[2]];
  if (mes === undefined) return null;
  const offsetMin = (m[7].startsWith('-') ? 1 : -1) *
    (Number(m[7].slice(1, 3)) * 60 + Number(m[7].slice(3, 5)));
  return new Date(
    Date.UTC(Number(m[3]), mes, Number(m[1]), Number(m[4]), Number(m[5]), Number(m[6])) +
      offsetMin * 60_000
  );
}

/** Lê o log e os rotacionados recentes (`.1`, `.2.gz`…). */
function lerLog(arquivo: string): string {
  const partes: string[] = [];
  for (const nome of [arquivo, `${arquivo}.1`, `${arquivo}.2.gz`, `${arquivo}.3.gz`]) {
    try {
      const bruto = fs.readFileSync(nome);
      partes.push(nome.endsWith('.gz') ? zlib.gunzipSync(bruto).toString('utf8') : bruto.toString('utf8'));
    } catch {
      /* não existe ou ainda não rotacionou - normal */
    }
  }
  return partes.join('\n');
}

function parseLinhas(texto: string, desde: Date): Linha[] {
  const out: Linha[] = [];
  for (const linha of texto.split('\n')) {
    const m = COMBINED.exec(linha);
    if (!m) continue;
    const quando = parseData(m[2]);
    if (!quando || quando < desde) continue;
    if (ROBOS.test(m[7])) continue;
    out.push({
      ip: m[1], quando, metodo: m[3], caminho: m[4],
      status: Number(m[5]), referrer: m[6], agente: m[7],
    });
  }
  return out;
}

export interface FunilDia {
  dia: string;
  visitantes: number;
  cliques: number;
}

/** Um canal de divulgação (`?f=`) com visita e clique cruzados. */
export interface FunilFonte {
  fonte: string;
  visitantes: number;
  cliquesUnicos: number;
  /** null quando o canal tem clique mas nenhuma visita casada - não fingir 0%. */
  taxaPercent: number | null;
}

export interface FunilResumo {
  dias: number;
  desde: Date;
  visitantes: number;
  paginas: number;
  cliques: number;
  cliquesUnicos: number;
  /** null quando não houve visita - evita dividir por zero e fingir 0%. */
  taxaCliquePercent: number | null;
  /**
   * Origem por REFERRER, em visitantes (IP único) - mesma unidade de
   * `visitantes` e de `porFonte`. A soma pode passar do total: quem chegou
   * duas vezes por caminhos diferentes conta nas duas origens.
   */
  origens: { origem: string; visitantes: number }[];
  porFonte: FunilFonte[];
  porNicho: { nicho: string; cliques: number }[];
  porDia: FunilDia[];
  /** Avisos pro consumidor mostrar (ex.: log ausente). */
  avisos: string[];
}

const diaSP = (d: Date): string =>
  d.toLocaleDateString('pt-BR', { timeZone: config.timezone, day: '2-digit', month: '2-digit' });

/** De onde veio a visita, agrupado por domínio. */
function origem(referrer: string): string {
  if (!referrer || referrer === '-') return 'direto ou app';
  try {
    const h = new URL(referrer).hostname.replace(/^www\./, '');
    // Auto-referência é navegação interna, não uma origem de tráfego.
    // Domínio antigo entra aqui também: ele redireciona pro oficial, então
    // visita vinda dele é navegação interna, não origem externa de tráfego.
    return nossosHosts().some((n) => h === n || h.endsWith(`.${n}`)) ? 'navegação no site' : h;
  } catch {
    return 'desconhecido';
  }
}

/**
 * Canal que trouxe a visita, lido do `?f=` da URL.
 *
 * Existe porque `origem()` não resolve o problema real: clique vindo do
 * WhatsApp, do Instagram ou de um QR chega SEM referrer e cai inteiro em
 * "direto ou app". Ou seja, justo os canais que a gente divulga são os que o
 * referrer não enxerga. O `?f=` é posto por nós no link publicado, então é o
 * único sinal que sobrevive ao webview.
 *
 * Só aceita o formato que a landing sanitiza - isto aqui é texto de fora.
 */
const FONTE = /[?&]f=([a-z0-9-]{1,16})(?:&|$)/;

const fonte = (caminho: string): string => FONTE.exec(caminho)?.[1] ?? 'sem fonte';

/**
 * IPs únicos por chave.
 *
 * A unidade honesta pra "quantas PESSOAS" - `contar` responde "quantas linhas
 * de log", que é outra coisa. Misturar as duas no mesmo painel foi bug de
 * verdade: "De onde vieram" somava 40 (páginas) embaixo de "Visitantes 11".
 */
const unicosPor = (linhas: Linha[], chave: (l: Linha) => string): Map<string, Set<string>> => {
  const m = new Map<string, Set<string>>();
  for (const l of linhas) {
    const k = chave(l);
    if (!m.has(k)) m.set(k, new Set());
    m.get(k)!.add(l.ip);
  }
  return m;
};

const contar = <T>(itens: T[], chave: (t: T) => string): Map<string, number> => {
  const m = new Map<string, number>();
  for (const i of itens) m.set(chave(i), (m.get(chave(i)) ?? 0) + 1);
  return m;
};

const ordenado = (m: Map<string, number>): [string, number][] =>
  [...m.entries()].sort((a, b) => b[1] - a[1]);

/**
 * Monta o funil de uma janela ROLANTE de `dias` × 24h a partir de agora.
 *
 * Rolante, e não dia do calendário, de propósito: um painel que zera à
 * meia-noite parece quebrado às 9h da manhã. `dias = 1` é "últimas 24 horas",
 * não "hoje desde a meia-noite" - a quebra `porDia` é que agrupa por data.
 */
export function lerFunil(dias = 1): FunilResumo {
  const avisos: string[] = [];
  const desde = new Date(Date.now() - dias * 24 * 3600_000);

  for (const [rotulo, arq] of [['acessos', config.site.logAcessos], ['cliques', config.site.logCliques]] as const) {
    if (!fs.existsSync(arq)) avisos.push(`Log de ${rotulo} não encontrado em ${arq}.`);
  }

  const acessos = parseLinhas(lerLog(config.site.logAcessos), desde)
    .filter((l) => l.metodo === 'GET' && l.status === 200 && PAGINA_NICHO.test(l.caminho.split('?')[0]));

  // sendBeacon = POST. Aceitar só GET contaria zero e casaria com os curl de teste.
  const cliques = parseLinhas(lerLog(config.site.logCliques), desde)
    .filter((l) => l.caminho.startsWith('/e'));

  const ipsVisita = new Set(acessos.map((l) => l.ip));
  const ipsClique = new Set(cliques.map((l) => l.ip));

  /* Visita e clique cruzados POR CANAL. É o que transforma "chegaram 60
     pessoas" em "o Pinterest trouxe 40 e converteu 5%, o Facebook trouxe 20 e
     converteu 30%". Com quatro canais no ar ao mesmo tempo e um número só, não
     dá pra saber o que matar e o que dobrar - o funil vira placar, não bússola.
     Por IP único dos dois lados, senão a taxa mistura base diferente. */
  const visitasFonte = unicosPor(acessos, (l) => fonte(l.caminho));
  const cliquesFonte = unicosPor(cliques, (l) => fonte(l.caminho));
  const porFonte: FunilFonte[] = [...new Set([...visitasFonte.keys(), ...cliquesFonte.keys()])]
    .map((f) => {
      const visitantes = visitasFonte.get(f)?.size ?? 0;
      const cliquesUnicos = cliquesFonte.get(f)?.size ?? 0;
      return {
        fonte: f,
        visitantes,
        cliquesUnicos,
        taxaPercent: visitantes > 0 ? (cliquesUnicos / visitantes) * 100 : null,
      };
    })
    .sort((a, b) => b.visitantes - a.visitantes || b.cliquesUnicos - a.cliquesUnicos);

  const porDia = new Map<string, { v: Set<string>; c: number }>();
  for (const l of acessos) {
    const d = diaSP(l.quando);
    if (!porDia.has(d)) porDia.set(d, { v: new Set(), c: 0 });
    porDia.get(d)!.v.add(l.ip);
  }
  for (const l of cliques) {
    const d = diaSP(l.quando);
    if (!porDia.has(d)) porDia.set(d, { v: new Set(), c: 0 });
    porDia.get(d)!.c += 1;
  }

  return {
    dias,
    desde,
    visitantes: ipsVisita.size,
    paginas: acessos.length,
    cliques: cliques.length,
    cliquesUnicos: ipsClique.size,
    taxaCliquePercent: ipsVisita.size > 0 ? (ipsClique.size / ipsVisita.size) * 100 : null,
    origens: [...unicosPor(acessos, (l) => origem(l.referrer)).entries()]
      .map(([origem, ips]) => ({ origem, visitantes: ips.size }))
      .sort((a, b) => b.visitantes - a.visitantes),
    porFonte,
    porNicho: ordenado(
      contar(cliques, (l) => /[?&]n=([a-z0-9-]+)/.exec(l.caminho)?.[1] ?? 'sem nicho')
    ).map(([nicho, cliques]) => ({ nicho, cliques })),
    porDia: [...porDia.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([dia, x]) => ({ dia, visitantes: x.v.size, cliques: x.c })),
    avisos,
  };
}

/** Texto pronto pro terminal. O Discord monta o dele a partir do objeto. */
export function formatarFunil(f: FunilResumo): string {
  const L: string[] = [];
  L.push('', `FUNIL - últimos ${f.dias} dia(s)`, '─'.repeat(38));
  const linha = (r: string, v: string | number) => L.push(`  ${r.padEnd(24)} ${v}`);
  linha('visitantes (IP único)', f.visitantes);
  linha('páginas vistas', f.paginas);
  linha('cliques no botão', f.cliques);
  linha('quem clicou (IP único)', f.cliquesUnicos);
  linha('TAXA DE CLIQUE', f.taxaCliquePercent === null ? '-' : `${f.taxaCliquePercent.toFixed(1)}%`);

  if (f.origens.length) {
    L.push('', '  De onde vieram (visitantes):');
    for (const o of f.origens.slice(0, 8)) L.push(`    ${String(o.visitantes).padStart(5)}  ${o.origem}`);
  }
  if (f.porFonte.length) {
    L.push('', '  Por canal (?f=):');
    for (const x of f.porFonte.slice(0, 10)) {
      const taxa = x.taxaPercent === null ? '     -' : `${x.taxaPercent.toFixed(1)}%`.padStart(6);
      L.push(
        `    ${String(x.visitantes).padStart(5)} visitantes  ` +
          `${String(x.cliquesUnicos).padStart(4)} cliques  ${taxa}  ${x.fonte}`
      );
    }
  }
  if (f.porNicho.length) {
    L.push('', '  Cliques por nicho:');
    for (const n of f.porNicho) L.push(`    ${String(n.cliques).padStart(5)}  ${n.nicho}`);
  }
  if (f.porDia.length > 1) {
    L.push('', '  Por dia:');
    for (const d of f.porDia) L.push(`    ${d.dia}  ${String(d.visitantes).padStart(4)} visitantes  ${String(d.cliques).padStart(4)} cliques`);
  }
  for (const a of f.avisos) L.push('', `  ⚠ ${a}`);
  L.push('');
  return L.join('\n');
}

export function caminhoLogs(): { acessos: string; cliques: string } {
  return {
    acessos: path.resolve(config.site.logAcessos),
    cliques: path.resolve(config.site.logCliques),
  };
}

logger.debug({ logs: caminhoLogs() }, '[funil] Caminhos de log configurados.');
