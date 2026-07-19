/** Pausa a execução por `ms` milissegundos. */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Inteiro aleatório em [minMs, maxMs]. Usado para espaçar envios (anti-ban). */
export function randomDelay(minMs: number, maxMs: number): number {
  const lo = Math.min(minMs, maxMs);
  const hi = Math.max(minMs, maxMs);
  return Math.floor(lo + Math.random() * (hi - lo));
}
