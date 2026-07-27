/**
 * Gera/atualiza o banco local de perfumes (data/perfumes.json) a partir do
 * dataset público doevent/perfume (dump do Fragrantica), já com as notas
 * traduzidas pro português (data/notes-pt.json) e simplificadas.
 *
 * Roda OFFLINE, fora do caminho de postagem - as notas não mudam, então é
 * raro precisar rodar. Notas ausentes do mapa PT ficam de fora.
 *
 *   npm run update-perfumes
 */
import fs from 'node:fs';
import path from 'node:path';
import { logger } from '../logger';

const SOURCE_URL = 'https://huggingface.co/datasets/doevent/perfume/resolve/main/perfumes.jsonl';
const SRC_CACHE = path.resolve('data/perfumes-source.jsonl'); // cache do dump cru (gitignored)
const NOTES_PT_FILE = path.resolve('data/notes-pt.json'); // mapa EN->PT
const OUT_FILE = path.resolve('data/perfumes.json'); // banco final (versionado)
const MAX_NOTAS_STORE = 8;

interface SourceRec {
  brand?: string;
  name_perfume?: string;
  ingredients?: string[];
}

async function loadSource(): Promise<string> {
  if (fs.existsSync(SRC_CACHE)) {
    logger.info({ arquivo: SRC_CACHE }, '[perfumes] Usando dump em cache.');
    return fs.readFileSync(SRC_CACHE, 'utf8');
  }
  logger.info({ url: SOURCE_URL }, '[perfumes] Baixando dump do dataset (~16MB)...');
  const res = await fetch(SOURCE_URL);
  if (!res.ok) throw new Error(`download falhou: HTTP ${res.status}`);
  const text = await res.text();
  fs.mkdirSync(path.dirname(SRC_CACHE), { recursive: true });
  fs.writeFileSync(SRC_CACHE, text);
  return text;
}

async function main(): Promise<void> {
  const notesPt = JSON.parse(fs.readFileSync(NOTES_PT_FILE, 'utf8')) as Record<string, string>;
  const text = await loadSource();
  const lines = text.split('\n').filter(Boolean);

  const out: Array<{ marca: string; nome: string; notas: string[] }> = [];
  const semTraducao = new Set<string>();

  for (const line of lines) {
    let j: SourceRec;
    try {
      j = JSON.parse(line) as SourceRec;
    } catch {
      continue;
    }
    const marca = (j.brand ?? '').trim();
    const nome = (j.name_perfume ?? '').trim();
    const ings = Array.isArray(j.ingredients) ? j.ingredients : [];
    if (!marca || !nome || ings.length === 0) continue;

    const notas: string[] = [];
    const seen = new Set<string>();
    for (const en of ings) {
      const pt = notesPt[en];
      if (!pt) {
        semTraducao.add(en);
        continue;
      }
      if (!seen.has(pt)) {
        seen.add(pt);
        notas.push(pt);
      }
    }
    if (notas.length === 0) continue;
    out.push({ marca, nome, notas: notas.slice(0, MAX_NOTAS_STORE) });
  }

  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
  fs.writeFileSync(OUT_FILE, JSON.stringify(out));
  logger.info(
    { perfumes: out.length, arquivo: OUT_FILE, notasSemTraducao: semTraducao.size },
    '[perfumes] Banco local atualizado.'
  );
  if (semTraducao.size > 0) {
    logger.warn(
      { exemplos: [...semTraducao].slice(0, 20) },
      '[perfumes] Notas sem tradução no mapa (ficaram de fora) - adicione ao data/notes-pt.json se relevantes.'
    );
  }
}

main().catch((err) => {
  logger.error({ err: (err as Error).message }, '[perfumes] Falha ao atualizar o banco.');
  process.exit(1);
});
