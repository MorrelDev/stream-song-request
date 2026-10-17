#!/usr/bin/env node
/**
 * Одноразовая авторизация Spotify (Authorization Code Flow).
 * Запуск: npm run auth:spotify
 * Требует, чтобы SPOTIFY_CLIENT_ID/SECRET уже были заполнены в .env, и
 * чтобы redirect URI (по умолчанию http://127.0.0.1:8888/callback) был
 * добавлен в настройках приложения на https://developer.spotify.com/dashboard
 */
import { randomBytes } from 'node:crypto';
import { TokenStore } from '../src/core/tokenStore.ts';
import { runAuthorizationCodeFlow } from './lib/runAuthorizationCodeFlow.ts';

try {
  process.loadEnvFile();
} catch {
  // .env необязателен, если переменные заданы окружением
}

const clientId = process.env.SPOTIFY_CLIENT_ID;
const clientSecret = process.env.SPOTIFY_CLIENT_SECRET;
const redirectUri = process.env.SPOTIFY_REDIRECT_URI ?? 'http://127.0.0.1:8888/callback';
const tokenFilePath = process.env.SPOTIFY_TOKEN_FILE ?? './data/spotify-token.json';

if (!clientId || !clientSecret) {
  console.error('Заполни SPOTIFY_CLIENT_ID и SPOTIFY_CLIENT_SECRET в .env перед авторизацией.');
  process.exit(1);
}

const scopes = [
  'user-read-playback-state',
  'user-modify-playback-state',
  'user-read-currently-playing',
  'playlist-read-private',
  // для SPOTIFY_DEFAULT_PLAYLIST_URI=TOP (топ-треки вместо плейлиста)
  'user-top-read',
].join(' ');

const state = randomBytes(8).toString('hex');
const authorizeUrl = new URL('https://accounts.spotify.com/authorize');
authorizeUrl.searchParams.set('client_id', clientId);
authorizeUrl.searchParams.set('response_type', 'code');
authorizeUrl.searchParams.set('redirect_uri', redirectUri);
authorizeUrl.searchParams.set('scope', scopes);
authorizeUrl.searchParams.set('state', state);

runAuthorizationCodeFlow({
  authorizeUrl,
  redirectUri,
  exchangeCode: async (code) => {
    const res = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri,
      }).toString(),
    });
    if (!res.ok) {
      throw new Error(`Spotify вернул HTTP ${res.status}: ${await res.text()}`);
    }
    const data = (await res.json()) as { access_token: string; refresh_token: string; expires_in: number };
    return { accessToken: data.access_token, refreshToken: data.refresh_token, expiresInSec: data.expires_in };
  },
  onSuccess: (tokens) => {
    const store = new TokenStore(tokenFilePath, () => {
      throw new Error('refresh не должен вызываться во время первичной авторизации');
    });
    store.saveInitial(tokens.accessToken, tokens.refreshToken, tokens.expiresInSec);
    console.log(`Готово! Токен сохранён в ${tokenFilePath}`);
  },
});
