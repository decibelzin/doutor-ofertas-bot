import fs from 'node:fs';
import path from 'node:path';
import axios from 'axios';
import { config } from '../../config';
import { logger } from '../../logger';

/**
 * Gerência do token OAuth do Mercado Livre.
 *
 * Fluxo (Authorization Code, com Refresh Token - que você habilitou no app):
 *  1. `ml-auth` abre a URL de autorização; você autoriza e o ML redireciona
 *     para o redirect_uri com `?code=...`.
 *  2. Troca o `code` por access_token + refresh_token (exchangeCodeForToken).
 *  3. O access_token vale ~6h; quando expira, renova sozinho com o
 *     refresh_token (refreshAccessToken). O ML devolve um refresh_token NOVO a
 *     cada renovação - por isso sempre regravamos o arquivo.
 *
 * Endpoints:
 *   Autorização: https://auth.mercadolivre.com.br/authorization
 *   Token:       https://api.mercadolibre.com/oauth/token
 */

const TOKEN_URL = 'https://api.mercadolibre.com/oauth/token';
const AUTH_URL = 'https://auth.mercadolivre.com.br/authorization';

interface StoredToken {
  access_token: string;
  refresh_token: string;
  user_id: number | null;
  expires_at: number; // epoch ms
}

interface TokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  user_id?: number;
}

function tokenPath(): string {
  return path.resolve(config.mercadoLivre.tokenFile);
}

function loadToken(): StoredToken | null {
  const p = tokenPath();
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8')) as StoredToken;
  } catch {
    return null;
  }
}

function saveToken(t: StoredToken): void {
  const p = tokenPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(t, null, 2));
}

function store(resp: TokenResponse): StoredToken {
  const token: StoredToken = {
    access_token: resp.access_token,
    refresh_token: resp.refresh_token,
    user_id: resp.user_id ?? null,
    // margem de 60s pra não usar um token prestes a expirar.
    expires_at: Date.now() + resp.expires_in * 1000 - 60_000,
  };
  saveToken(token);
  return token;
}

/** URL que o usuário abre no navegador para autorizar o app. */
export function buildAuthorizationUrl(): string {
  const { clientId, redirectUri } = config.mercadoLivre;
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: redirectUri,
  });
  return `${AUTH_URL}?${params.toString()}`;
}

/** Troca o `code` (da URL de redirect) por access + refresh token. */
export async function exchangeCodeForToken(code: string): Promise<StoredToken> {
  const { clientId, clientSecret, redirectUri } = config.mercadoLivre;
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: clientId,
    client_secret: clientSecret,
    code,
    redirect_uri: redirectUri,
  });

  const { data } = await axios.post<TokenResponse>(TOKEN_URL, body, {
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    timeout: 15000,
  });
  logger.info('[ML OAuth] Token obtido e salvo.');
  return store(data);
}

/** Renova o access_token usando o refresh_token salvo. */
async function refreshAccessToken(current: StoredToken): Promise<StoredToken> {
  const { clientId, clientSecret } = config.mercadoLivre;
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: current.refresh_token,
  });

  const { data } = await axios.post<TokenResponse>(TOKEN_URL, body, {
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    timeout: 15000,
  });
  logger.debug('[ML OAuth] Access token renovado.');
  return store(data);
}

/**
 * Retorna um access_token válido, renovando se necessário. Lança erro claro
 * se ainda não houve autorização (rode `npm run ml-auth`).
 */
export async function getValidAccessToken(): Promise<string> {
  let token = loadToken();
  if (!token) {
    throw new Error(
      'Sem token do Mercado Livre. Rode "npm run ml-auth" para autorizar o app uma vez.'
    );
  }
  if (Date.now() >= token.expires_at) {
    token = await refreshAccessToken(token);
  }
  return token.access_token;
}

export function hasToken(): boolean {
  return loadToken() !== null;
}
