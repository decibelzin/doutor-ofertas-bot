/** Cores e formatação de tempo compartilhadas pelas ações do painel. */

export const OURO = 0xe8b84b;
export const VERDE = 0x25d366;
export const VERMELHO = 0xe5484d;
export const CINZA = 0x4f545c;

/** Timestamp relativo do Discord: "há 5 minutos", já no fuso de quem lê. */
export const minutosAtras = (ms: number): string => `<t:${Math.floor(ms / 1000)}:R>`;

/** Timestamp absoluto curto do Discord ("hoje às 14:32"). */
export const agora = (ms: number): string => `<t:${Math.floor(ms / 1000)}:f>`;
