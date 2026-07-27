import { lerFunil, formatarFunil, caminhoLogs } from '../core/funnel';

/**
 * Funil no terminal. Mesma lógica que o /funil do Discord usa - os dois
 * chamam `lerFunil`, então não existe versão que conserta de um lado só.
 *
 *   npm run funil          -> hoje
 *   npm run funil -- 7     -> últimos 7 dias
 */
const dias = Number(process.argv[2] ?? 1);

if (!Number.isFinite(dias) || dias < 1) {
  console.error(`\n✗ "dias" tem que ser um inteiro >= 1 (recebi: ${process.argv[2]})\n`);
  process.exit(1);
}

try {
  console.log(formatarFunil(lerFunil(dias)));
} catch (err) {
  const { acessos, cliques } = caminhoLogs();
  console.error(`\n✗ ${(err as Error).message}`);
  console.error(`  logs esperados em:\n    ${acessos}\n    ${cliques}\n`);
  process.exit(1);
}
