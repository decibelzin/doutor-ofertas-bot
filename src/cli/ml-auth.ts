/**
 * Autorização OAuth do Mercado Livre (uma vez só).
 *
 *   npm run ml-auth
 *
 * 1. Abre o link que aparecer no navegador (logado na conta do ML).
 * 2. Autorize o app. O ML vai te redirecionar para https://example.com/?code=XXXX
 *    (a página não carrega nada — é só pra o "code" aparecer na barra do navegador).
 * 3. Copie o valor do `code` (ou a URL inteira) e cole aqui.
 *
 * O token fica salvo e passa a se renovar sozinho (Refresh Token).
 */
import readline from 'node:readline';
import { config } from '../config';
import { logger } from '../logger';
import { buildAuthorizationUrl, exchangeCodeForToken } from '../providers/mercadolivre/oauth';

function ask(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(question, (answer) => {
    rl.close();
    resolve(answer);
  }));
}

/** Aceita tanto o `code` puro quanto a URL de redirect inteira. */
function extractCode(input: string): string {
  const trimmed = input.trim();
  const match = trimmed.match(/[?&]code=([^&\s]+)/);
  return match ? decodeURIComponent(match[1]!) : trimmed;
}

async function main(): Promise<void> {
  if (!config.mercadoLivre.clientId || !config.mercadoLivre.clientSecret) {
    logger.error('Preencha ML_CLIENT_ID e ML_CLIENT_SECRET no .env antes de autorizar.');
    process.exit(1);
  }

  process.stdout.write('\n1) Abra este link no navegador (logado na sua conta do Mercado Livre):\n\n');
  process.stdout.write(`   ${buildAuthorizationUrl()}\n\n`);
  process.stdout.write(
    '2) Autorize. Você será redirecionado para https://example.com/?code=...\n' +
      '   (a página fica em branco — normal).\n\n'
  );

  const input = await ask('3) Cole aqui o "code" (ou a URL inteira) e tecle Enter:\n> ');
  const code = extractCode(input);
  if (!code) {
    logger.error('Nenhum code informado.');
    process.exit(1);
  }

  try {
    await exchangeCodeForToken(code);
    process.stdout.write('\n✅ Autorizado! Token salvo. Agora rode: npm run fetch\n\n');
    process.exit(0);
  } catch (err) {
    const status = (err as { response?: { status?: number } })?.response?.status;
    logger.error({ err: (err as Error).message, status }, 'Falha ao trocar o code por token.');
    process.stdout.write(
      '\nDica: o code expira em minutos e é de uso único. Gere um novo abrindo o link de novo.\n\n'
    );
    process.exit(1);
  }
}

main();
