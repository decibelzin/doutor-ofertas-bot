import fs from 'node:fs';
import path from 'node:path';

/**
 * Escrita ATÔMICA: grava num `.tmp` e faz rename por cima (operação atômica no
 * SO). Um leitor concorrente nunca vê arquivo truncado, e um crash no meio da
 * escrita não corrompe o arquivo final — no pior caso sobra um `.tmp` órfão.
 */
export function writeFileAtomic(file: string, data: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}
