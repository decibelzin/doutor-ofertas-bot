import path from 'node:path';
import type { WASocket } from '@whiskeysockets/baileys';
import { config } from '../config';
import { logger } from '../logger';
import { loadNiches } from './niches';
import { loadLandings } from './landing';
import { writeFileAtomic } from '../util/atomic';

/**
 * STATUS DOS GRUPOS pro site: quantos membros cada grupo tem e qual o link de
 * convite. O site lê esse JSON e aponta o botão pro primeiro grupo com vaga.
 *
 * Como o bot roda na MESMA VPS do site, ele escreve direto na pasta servida -
 * sem commit, sem rebuild, sem CORS (mesma origem).
 *
 * Requisitos: o bot precisa ser ADMIN do grupo pra obter o link de convite.
 */

/** Teto do WhatsApp por grupo. */
const WHATSAPP_LIMIT = 1024;

/** JID (`5511...@s.whatsapp.net`, às vezes com `:device`) → só os dígitos. */
const soDigitos = (jid: string): string => jid.split('@')[0]!.split(':')[0]!.replace(/\D/g, '');

/**
 * É o bot ou alguém da equipe? Então não é inscrito.
 *
 * Compara contra o id E o LID: o WhatsApp passou a identificar participante de
 * grupo por LID (`<numero>@lid`), que NÃO é o telefone. Comparando só com o
 * telefone, o bot deixava de ser reconhecido e cada grupo VAZIO voltava a
 * contar 1 pessoa.
 */
function ehDaCasa(jid: string, nossos: Set<string>): boolean {
  const n = soDigitos(jid);
  return nossos.has(n) || config.admin.teamNumbers.includes(n);
}

export interface GroupStatus {
  name: string;
  /** Link de convite (chat.whatsapp.com/…) ou null se não deu pra obter. */
  link: string | null;
  members: number;
  /**
   * INSCRITOS de verdade: participantes menos o bot e menos os números da
   * equipe (TEAM_NUMBERS).
   *
   * `meta.size` conta todos os participantes e o bot é um deles - relatar o
   * bruto fazia 10 grupos VAZIOS parecerem 10 inscritos. E quem opera também
   * costuma estar dentro do grupo, então some junto: com poucos membros, cada
   * número da equipe distorce a métrica em dezenas por cento.
   */
  people: number;
  /** Vagas até o limite operacional (com margem). */
  vacancies: number;
  full: boolean;
}

export interface GroupsFile {
  updatedAt: string;
  /** Limite operacional usado (com margem sobre o teto real do WhatsApp). */
  limit: number;
  /** Primeiro grupo com vaga - é pra cá que o botão do site aponta. */
  join: string | null;
  totalMembers: number;
  /** Soma de `people`: o número que vale pra saber se o funil está trazendo gente. */
  totalPeople: number;
  groups: GroupStatus[];
}

/**
 * Lê os grupos no WhatsApp e monta o status. `limit` é o teto OPERACIONAL:
 * usar folga (ex.: 1000 de 1024) evita a corrida de alguém tentar entrar num
 * grupo que lotou entre o carregamento da página e o clique.
 */
export async function buildGroupStatus(
  sock: WASocket,
  { limit = config.site.groupLimit, niche }: { limit?: number; niche?: string } = {}
): Promise<GroupsFile> {
  const niches = loadNiches();

  /**
   * Com `niche`, usa SÓ os grupos daquele nicho. Isso é obrigatório desde que
   * o site passou a ter uma página por nicho: sem o filtro, os grupos de todos
   * os nichos caem numa lista só e o botão da página de perfume pode mandar a
   * pessoa pro grupo de fitness.
   *
   * Sem `niche`, mantém o comportamento antigo (site de nicho único): perfume
   * se existir, senão todos.
   */
  const escolhidos = niche
    ? niches.filter((n) => n.name === niche)
    : (() => {
        const perfume = niches.filter((n) => /perfum|fragr/i.test(n.name));
        return perfume.length ? perfume : niches;
      })();

  if (niche && escolhidos.length === 0) {
    logger.warn({ niche }, '[grupos] Nicho não existe em config/niches.json - status vazio.');
  }

  const groupIds = [...new Set(escolhidos.flatMap((n) => n.groups))];
  /* Todos os identificadores que somos nós. O `lid` existe porque o WhatsApp
   * passou a usar LID na lista de participantes; sem ele o bot não se
   * reconhece dentro do próprio grupo. */
  const eu = sock.user as { id?: string; lid?: string } | undefined;
  const nossos = new Set([soDigitos(eu?.id ?? ''), soDigitos(eu?.lid ?? '')].filter(Boolean));

  const groups: GroupStatus[] = [];
  for (const id of groupIds) {
    let name = id;
    let members = 0;
    let people = 0;
    let link: string | null = null;
    try {
      const meta = await sock.groupMetadata(id);
      name = meta.subject ?? id;
      members = meta.size ?? meta.participants?.length ?? 0;
      // Preferimos contar a LISTA (dá pra excluir quem é nosso) e só caímos no
      // `size - 1` quando ela não vem.
      /* `groupMetadata` só responde pra grupo em que o bot ESTÁ, então ele é
       * sempre um dos participantes. Se o filtro não tirou ninguém, é porque
       * não conseguimos nos reconhecer na lista (formato de id novo) — nesse
       * caso descontamos 1 às cegas, que é a verdade que sabemos. Sem esse
       * fallback, grupo vazio volta a contar 1 pessoa. */
      const lista = meta.participants ?? [];
      const filtrados = lista.filter((p) => !ehDaCasa(p.id, nossos)).length;
      people = lista.length === 0
        ? Math.max(0, members - 1)
        : filtrados < lista.length
          ? filtrados
          : Math.max(0, members - 1);
    } catch (err) {
      logger.warn({ id, err: (err as Error).message }, '[grupos] Sem metadata.');
    }
    try {
      const code = await sock.groupInviteCode(id);
      if (code) link = `https://chat.whatsapp.com/${code}`;
    } catch (err) {
      logger.warn({ id, err: (err as Error).message }, '[grupos] Sem link de convite (o bot é admin?).');
    }
    const vacancies = Math.max(0, limit - members);
    groups.push({ name, link, members, people, vacancies, full: vacancies === 0 });
  }

  // Ordena por menos cheio... não: mantém a ordem configurada e pega o PRIMEIRO
  // com vaga - assim os grupos enchem em sequência (melhor pra moderação) em
  // vez de espalhar gente por todos ao mesmo tempo.
  const next = groups.find((g) => !g.full && g.link);

  return {
    updatedAt: new Date().toISOString(),
    limit,
    join: next?.link ?? null,
    totalMembers: groups.reduce((s, g) => s + g.members, 0),
    totalPeople: groups.reduce((s, g) => s + g.people, 0),
    groups,
  };
}

/**
 * Grava o JSON na pasta que o site serve (escrita atômica).
 *
 * Com `slug`, escreve em <site.dir>/<slug>/groups.json - a pasta da landing
 * daquele nicho. Sem slug, cai no caminho legado de site de nicho único.
 */
export function writeGroupStatus(data: GroupsFile, slug?: string): string {
  const file = slug
    ? path.resolve(config.site.dir, slug, 'groups.json')
    : path.resolve(config.site.groupsFile);
  writeFileAtomic(file, JSON.stringify(data, null, 2));
  return file;
}

/**
 * Atualiza o status de TODAS as landings configuradas (uma por nicho).
 *
 * Sem config/landings.json, mantém o comportamento antigo: um único
 * groups.json na raiz do site. Devolve o status do nicho padrão - ou null se
 * nada pôde ser atualizado.
 */
export async function refreshGroupStatus(sock: WASocket): Promise<GroupsFile | null> {
  let cfg: ReturnType<typeof loadLandings> = null;
  try {
    cfg = loadLandings();
  } catch (err) {
    // Config quebrada não pode derrubar o refresh: cai no modo antigo e avisa.
    logger.error({ err: (err as Error).message }, '[grupos] config/landings.json inválido.');
  }

  if (!cfg) {
    try {
      const data = await buildGroupStatus(sock);
      const file = writeGroupStatus(data);
      logger.info(
        { grupos: data.groups.length, pessoas: data.totalPeople, proximo: data.join ? 'ok' : 'NENHUM', file },
        '[grupos] Status atualizado pro site.'
      );
      return data;
    } catch (err) {
      logger.error({ err: (err as Error).message }, '[grupos] Falha ao atualizar status.');
      return null;
    }
  }

  let padrao: GroupsFile | null = null;
  for (const landing of cfg.landings) {
    try {
      const data = await buildGroupStatus(sock, { niche: landing.niche });
      const file = writeGroupStatus(data, landing.slug);
      logger.info(
        {
          slug: landing.slug,
          nicho: landing.niche,
          grupos: data.groups.length,
          pessoas: data.totalPeople,
          proximo: data.join ? 'ok' : 'NENHUM',
          file,
        },
        '[grupos] Status atualizado pro site.'
      );
      if (landing.slug === cfg.default) padrao = data;
    } catch (err) {
      // Um nicho com problema não pode impedir a atualização dos outros.
      logger.error(
        { slug: landing.slug, err: (err as Error).message },
        '[grupos] Falha ao atualizar status deste nicho.'
      );
    }
  }
  return padrao;
}

export { WHATSAPP_LIMIT };
