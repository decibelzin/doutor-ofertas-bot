import fs from 'node:fs';
import path from 'node:path';
import { writeFileAtomic } from '../util/atomic';
import { logger } from '../logger';

/**
 * PAUSA DE POSTAGEM - freio de mão, acionável de fora do processo.
 *
 * O bot do WhatsApp e o bot do Discord são processos SEPARADOS, então não dá
 * pra pausar mexendo numa variável: o Discord escreve este arquivo e o
 * scheduler lê antes de cada ciclo. Arquivo em vez de socket/IPC porque
 * sobrevive a restart - pausar e o serviço reiniciar não pode voltar a postar
 * sozinho, que é justamente quando você quer o freio valendo.
 *
 * Sem arquivo = rodando. É o estado padrão e o mais seguro de assumir.
 */

const ARQUIVO = path.resolve('data/pausa.json');

export interface EstadoPausa {
  pausado: boolean;
  desde: string;
  por: string;
  motivo?: string;
  /** ISO. Quando passar, a pausa expira sozinha. Ausente = até mandar retomar. */
  ate?: string;
}

export function lerPausa(): EstadoPausa | null {
  try {
    const e = JSON.parse(fs.readFileSync(ARQUIVO, 'utf8')) as EstadoPausa;
    if (!e?.pausado) return null;
    // Pausa com prazo que já venceu não segura mais nada.
    if (e.ate && new Date(e.ate).getTime() <= Date.now()) {
      retomar('expiração automática');
      return null;
    }
    return e;
  } catch {
    return null;
  }
}

/** O scheduler chama isto antes de postar. */
export function estaPausado(): boolean {
  return lerPausa() !== null;
}

export function pausar(opts: { por: string; motivo?: string; minutos?: number }): EstadoPausa {
  const estado: EstadoPausa = {
    pausado: true,
    desde: new Date().toISOString(),
    por: opts.por,
    ...(opts.motivo ? { motivo: opts.motivo } : {}),
    ...(opts.minutos ? { ate: new Date(Date.now() + opts.minutos * 60_000).toISOString() } : {}),
  };
  writeFileAtomic(ARQUIVO, JSON.stringify(estado, null, 2));
  logger.warn({ ...estado }, '[Pausa] Postagem PAUSADA.');
  return estado;
}

export function retomar(por: string): void {
  try {
    fs.rmSync(ARQUIVO, { force: true });
  } catch {
    /* já não existia */
  }
  logger.info({ por }, '[Pausa] Postagem RETOMADA.');
}
