import path from 'node:path';
import { Boom } from '@hapi/boom';
import makeWASocket, {
  DisconnectReason,
  fetchLatestBaileysVersion,
  useMultiFileAuthState,
  type WASocket,
} from '@whiskeysockets/baileys';
import qrcode from 'qrcode-terminal';
import { config } from '../config';
import { logger } from '../logger';

let sock: WASocket | null = null;
let connected = false;
let readyResolvers: Array<(s: WASocket) => void> = [];

function notifyReady(s: WASocket): void {
  connected = true;
  const resolvers = readyResolvers;
  readyResolvers = [];
  resolvers.forEach((resolve) => resolve(s));
}

/**
 * Conecta ao WhatsApp via Baileys. Na primeira execução, um QR code é impresso
 * no terminal — escaneie com WhatsApp > Aparelhos conectados. As credenciais
 * ficam salvas em SESSION_DIR, então nas próximas vezes não é necessário
 * escanear de novo (a menos que a sessão seja revogada).
 *
 * Reconecta sozinho em quedas de conexão (exceto logout).
 */
export async function connectWhatsApp(): Promise<WASocket> {
  const authDir = path.resolve(config.whatsapp.sessionDir);
  const { state, saveCreds } = await useMultiFileAuthState(authDir);
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    markOnlineOnConnect: false,
    // Baileys usa um logger pino-compatível; passamos o nosso em nível 'warn'
    // pra não poluir o terminal com o ruído interno da lib.
    logger: logger.child({ module: 'baileys' }, { level: 'warn' }) as never,
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      logger.info('[WhatsApp] Escaneie o QR abaixo (WhatsApp > Aparelhos conectados):');
      qrcode.generate(qr, { small: true });
    }

    if (connection === 'open') {
      logger.info('[WhatsApp] Conectado com sucesso!');
      if (sock) notifyReady(sock);
    }

    if (connection === 'close') {
      connected = false;
      const statusCode = (lastDisconnect?.error as Boom | undefined)?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      logger.warn({ statusCode }, '[WhatsApp] Conexão fechada.');

      if (shouldReconnect) {
        logger.info('[WhatsApp] Tentando reconectar em 5s...');
        setTimeout(() => {
          connectWhatsApp().catch((err) =>
            logger.error({ err: (err as Error).message }, '[WhatsApp] Falha ao reconectar.')
          );
        }, 5000);
      } else {
        logger.error(
          '[WhatsApp] Sessão desconectada (logout). Apague a pasta de sessão e escaneie o QR novamente.'
        );
      }
    }
  });

  return sock;
}

/** Resolve quando a conexão estiver pronta (útil antes de enviar mensagens). */
export function whenReady(): Promise<WASocket> {
  if (connected && sock) return Promise.resolve(sock);
  return new Promise((resolve) => readyResolvers.push(resolve));
}

/** Retorna o socket atual (ou null se ainda não conectou). */
export function getSocket(): WASocket | null {
  return sock;
}
