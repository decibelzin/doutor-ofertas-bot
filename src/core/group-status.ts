import path from 'node:path';
import type { WASocket } from '@whiskeysockets/baileys';
import { config } from '../config';
import { logger } from '../logger';
import { loadNiches } from './niches';
import { writeFileAtomic } from '../util/atomic';

/**
 * STATUS DOS GRUPOS pro site: quantos membros cada grupo tem e qual o link de
 * convite. O site lê esse JSON e aponta o botão pro primeiro grupo com vaga.
 *
 * Como o bot roda na MESMA VPS do site, ele escreve direto na pasta servida —
 * sem commit, sem rebuild, sem CORS (mesma origem).
 *
 * Requisitos: o bot precisa ser ADMIN do grupo pra obter o link de convite.
 */

/** Teto do WhatsApp por grupo. */
const WHATSAPP_LIMIT = 1024;

export interface GroupStatus {
  name: string;
  /** Link de convite (chat.whatsapp.com/…) ou null se não deu pra obter. */
  link: string | null;
  members: number;
  /** Vagas até o limite operacional (com margem). */
  vacancies: number;
  full: boolean;
}

export interface GroupsFile {
  updatedAt: string;
  /** Limite operacional usado (com margem sobre o teto real do WhatsApp). */
  limit: number;
  /** Primeiro grupo com vaga — é pra cá que o botão do site aponta. */
  join: string | null;
  totalMembers: number;
  groups: GroupStatus[];
}

/**
 * Lê os grupos no WhatsApp e monta o status. `limit` é o teto OPERACIONAL:
 * usar folga (ex.: 1000 de 1024) evita a corrida de alguém tentar entrar num
 * grupo que lotou entre o carregamento da página e o clique.
 */
export async function buildGroupStatus(
  sock: WASocket,
  { limit = config.site.groupLimit }: { limit?: number } = {}
): Promise<GroupsFile> {
  const niches = loadNiches();
  const perfume = niches.filter((n) => /perfum|fragr/i.test(n.name));
  const target = (perfume.length ? perfume : niches).flatMap((n) => n.groups);
  const groupIds = [...new Set(target)];

  const groups: GroupStatus[] = [];
  for (const id of groupIds) {
    let name = id;
    let members = 0;
    let link: string | null = null;
    try {
      const meta = await sock.groupMetadata(id);
      name = meta.subject ?? id;
      members = meta.size ?? meta.participants?.length ?? 0;
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
    groups.push({ name, link, members, vacancies, full: vacancies === 0 });
  }

  // Ordena por menos cheio... não: mantém a ordem configurada e pega o PRIMEIRO
  // com vaga — assim os grupos enchem em sequência (melhor pra moderação) em
  // vez de espalhar gente por todos ao mesmo tempo.
  const next = groups.find((g) => !g.full && g.link);

  return {
    updatedAt: new Date().toISOString(),
    limit,
    join: next?.link ?? null,
    totalMembers: groups.reduce((s, g) => s + g.members, 0),
    groups,
  };
}

/** Grava o JSON na pasta que o site serve (escrita atômica). */
export function writeGroupStatus(data: GroupsFile): string {
  const file = path.resolve(config.site.groupsFile);
  writeFileAtomic(file, JSON.stringify(data, null, 2));
  return file;
}

/** Lê os grupos e grava o arquivo. Devolve o resultado (ou null se falhar). */
export async function refreshGroupStatus(sock: WASocket): Promise<GroupsFile | null> {
  try {
    const data = await buildGroupStatus(sock);
    const file = writeGroupStatus(data);
    logger.info(
      { grupos: data.groups.length, membros: data.totalMembers, proximo: data.join ? 'ok' : 'NENHUM', file },
      '[grupos] Status atualizado pro site.'
    );
    return data;
  } catch (err) {
    logger.error({ err: (err as Error).message }, '[grupos] Falha ao atualizar status.');
    return null;
  }
}

export { WHATSAPP_LIMIT };
