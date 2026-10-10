/**
 * Twitch Helix API для наград за баллы канала (Channel Points).
 *
 * Два ограничения Twitch, из-за которых всё устроено именно так:
 *  - все запросы — только с User Access Token самого стримера (не бота, даже
 *    если бот модератор) со скоупом channel:manage:redemptions;
 *  - менять статус активации (выполнить / отклонить с возвратом баллов) можно
 *    только у награды, созданной тем же Client ID, что и запрос. Награду,
 *    созданную вручную в панели Twitch, приложение обработать не сможет —
 *    поэтому оно создаёт её само (см. ensureReward).
 */

export interface ChannelPointsApiConfig {
  clientId: string;
  broadcasterId: string;
  /** Токен стримера со скоупом channel:manage:redemptions. */
  getAccessToken: () => Promise<string>;
}

export interface RewardSettings {
  title: string;
  cost: number;
  /** Подсказка зрителю при активации награды. */
  prompt: string;
}

export type RedemptionStatus = 'FULFILLED' | 'CANCELED';

export interface PendingRedemption {
  id: string;
  userName: string;
  userInput: string;
}

const HELIX = 'https://api.twitch.tv/helix';
// Лимит Twitch на число id в одном PATCH активаций и на размер страницы списка.
const MAX_IDS_PER_REQUEST = 50;

async function helixRequest(
  cfg: ChannelPointsApiConfig,
  method: string,
  url: URL,
  body: unknown,
  fetchImpl: typeof fetch,
): Promise<Response> {
  const token = await cfg.getAccessToken();
  return fetchImpl(url, {
    method,
    headers: {
      'Client-Id': cfg.clientId,
      Authorization: `Bearer ${token}`,
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

async function describeError(res: Response): Promise<string> {
  let details = '';
  try {
    details = await res.text();
  } catch {
    // тело ответа не обязательно
  }
  return `HTTP ${res.status}${details ? `: ${details}` : ''}`;
}

export interface TokenInfo {
  /** id пользователя, которому принадлежит токен. */
  userId: string;
  scopes: string[];
}

/**
 * Возвращает владельца токена и его скоупы (GET oauth2/validate) — чтобы при
 * старте сразу поймать частые ошибки "авторизовался не тем аккаунтом"
 * (ботом вместо стримера) и "токен выдан до появления нужного скоупа", а не
 * получать 403 на каждом запросе.
 */
export async function getTokenInfo(accessToken: string, fetchImpl: typeof fetch = fetch): Promise<TokenInfo> {
  const res = await fetchImpl('https://id.twitch.tv/oauth2/validate', {
    headers: { Authorization: `OAuth ${accessToken}` },
  });
  if (!res.ok) {
    throw new Error(`Twitch не принял токен стримера (oauth2/validate): ${await describeError(res)}`);
  }
  const data = (await res.json()) as { user_id: string; scopes?: string[] };
  return { userId: data.user_id, scopes: data.scopes ?? [] };
}

/** Скоупы токена стримера, нужные для isModeratorOrVip (Privilege-режим). */
export const PRIVILEGE_SCOPES = ['moderation:read', 'channel:read:vips'];

/**
 * true — пользователь модератор или VIP канала. В событии активации награды
 * Twitch значков зрителя не присылает, поэтому спрашиваем у Helix (оба
 * запроса — только с токеном стримера, см. PRIVILEGE_SCOPES).
 */
export async function isModeratorOrVip(
  cfg: ChannelPointsApiConfig,
  userId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  for (const [path, what] of [
    ['moderation/moderators', 'модераторов'],
    ['channels/vips', 'VIP'],
  ] as const) {
    const url = new URL(`${HELIX}/${path}`);
    url.searchParams.set('broadcaster_id', cfg.broadcasterId);
    url.searchParams.set('user_id', userId);
    const res = await helixRequest(cfg, 'GET', url, undefined, fetchImpl);
    if (!res.ok) {
      throw new Error(`Не удалось получить список ${what} канала: ${await describeError(res)}`);
    }
    const data = (await res.json()) as { data: unknown[] };
    if (data.data.length > 0) return true;
  }
  return false;
}

export interface ManagedReward {
  id: string;
  /** Текущее название на Twitch — могли переименовать в панели. */
  title: string;
}

/**
 * Ищет среди наград, созданных этим приложением (ручные награды Twitch сюда
 * не отдаёт вовсе): сначала по id, если он известен, иначе — по названию
 * без учёта регистра.
 */
export async function findManageableReward(
  cfg: ChannelPointsApiConfig,
  lookup: { id?: string; title: string },
  fetchImpl: typeof fetch = fetch,
): Promise<ManagedReward | null> {
  const url = new URL(`${HELIX}/channel_points/custom_rewards`);
  url.searchParams.set('broadcaster_id', cfg.broadcasterId);
  url.searchParams.set('only_manageable_rewards', 'true');

  const res = await helixRequest(cfg, 'GET', url, undefined, fetchImpl);
  if (!res.ok) {
    throw new Error(`Не удалось получить список наград канала: ${await describeError(res)}`);
  }
  const data = (await res.json()) as { data: Array<{ id: string; title: string }> };
  const byId = lookup.id ? data.data.find((r) => r.id === lookup.id) : undefined;
  const wanted = lookup.title.trim().toLowerCase();
  const found = byId ?? data.data.find((r) => r.title.trim().toLowerCase() === wanted);
  return found ? { id: found.id, title: found.title } : null;
}

/** Меняет настройки награды (только тех полей, что переданы). */
export async function updateReward(
  cfg: ChannelPointsApiConfig,
  rewardId: string,
  patch: Record<string, unknown>,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const url = new URL(`${HELIX}/channel_points/custom_rewards`);
  url.searchParams.set('broadcaster_id', cfg.broadcasterId);
  url.searchParams.set('id', rewardId);

  const res = await helixRequest(cfg, 'PATCH', url, patch, fetchImpl);
  if (!res.ok) {
    throw new Error(`Не удалось обновить награду за баллы канала: ${await describeError(res)}`);
  }
}

/**
 * Находит награду этого приложения (по сохранённому id, иначе по названию)
 * или создаёт новую.
 *
 * Название, цена и подсказка из settings используются только при создании —
 * дальше награду можно настраивать в панели Twitch, приложение эти поля не
 * перезаписывает. У найденной награды выставляется только то, без чего
 * режим не работает: включена, не на паузе, требует текст от зрителя и НЕ
 * помечает активации выполненными автоматически (иначе вернуть баллы при
 * отказе будет уже нельзя).
 */
export async function ensureReward(
  cfg: ChannelPointsApiConfig,
  settings: RewardSettings,
  knownRewardId: string | undefined,
  fetchImpl: typeof fetch = fetch,
): Promise<ManagedReward & { created: boolean }> {
  const requiredFields = {
    is_enabled: true,
    is_paused: false,
    is_user_input_required: true,
    should_redemptions_skip_request_queue: false,
  };

  const existing = await findManageableReward(cfg, { id: knownRewardId, title: settings.title }, fetchImpl);
  if (existing) {
    await updateReward(cfg, existing.id, requiredFields, fetchImpl);
    return { ...existing, created: false };
  }

  const url = new URL(`${HELIX}/channel_points/custom_rewards`);
  url.searchParams.set('broadcaster_id', cfg.broadcasterId);
  const res = await helixRequest(
    cfg,
    'POST',
    url,
    { title: settings.title, cost: settings.cost, prompt: settings.prompt, ...requiredFields },
    fetchImpl,
  );
  if (!res.ok) {
    const error = await describeError(res);
    if (error.includes('DUPLICATE_REWARD')) {
      throw new Error(
        `На канале уже есть награда "${settings.title}", но она создана вручную в панели Twitch — ` +
          'Twitch не даёт приложению выполнять или отклонять активации таких наград. ' +
          'Удали её в панели Twitch (приложение создаст свою с тем же названием) или задай другое MUSIC_REWARD_TITLE.',
      );
    }
    throw new Error(`Не удалось создать награду за баллы канала: ${error}`);
  }
  const data = (await res.json()) as { data: Array<{ id: string; title: string }> };
  const created = data.data[0];
  if (!created) throw new Error('Twitch не вернул id созданной награды');
  return { id: created.id, title: created.title, created: true };
}

/** Активации награды, которые ещё никто не выполнил и не отклонил. */
export async function listUnfulfilledRedemptions(
  cfg: ChannelPointsApiConfig,
  rewardId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<PendingRedemption[]> {
  const result: PendingRedemption[] = [];
  let cursor: string | undefined;
  do {
    const url = new URL(`${HELIX}/channel_points/custom_rewards/redemptions`);
    url.searchParams.set('broadcaster_id', cfg.broadcasterId);
    url.searchParams.set('reward_id', rewardId);
    url.searchParams.set('status', 'UNFULFILLED');
    url.searchParams.set('first', String(MAX_IDS_PER_REQUEST));
    if (cursor) url.searchParams.set('after', cursor);

    const res = await helixRequest(cfg, 'GET', url, undefined, fetchImpl);
    if (!res.ok) {
      throw new Error(`Не удалось получить список активаций награды: ${await describeError(res)}`);
    }
    const data = (await res.json()) as {
      data: Array<{ id: string; user_name: string; user_input: string }>;
      pagination?: { cursor?: string };
    };
    for (const r of data.data) result.push({ id: r.id, userName: r.user_name, userInput: r.user_input });
    cursor = data.data.length > 0 ? data.pagination?.cursor : undefined;
  } while (cursor);
  return result;
}

/**
 * Выполняет (FULFILLED) или отклоняет (CANCELED — Twitch сам возвращает
 * зрителю баллы) активации награды.
 */
export async function updateRedemptionStatus(
  cfg: ChannelPointsApiConfig,
  rewardId: string,
  redemptionIds: string[],
  status: RedemptionStatus,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  for (let i = 0; i < redemptionIds.length; i += MAX_IDS_PER_REQUEST) {
    const url = new URL(`${HELIX}/channel_points/custom_rewards/redemptions`);
    url.searchParams.set('broadcaster_id', cfg.broadcasterId);
    url.searchParams.set('reward_id', rewardId);
    for (const id of redemptionIds.slice(i, i + MAX_IDS_PER_REQUEST)) url.searchParams.append('id', id);

    const res = await helixRequest(cfg, 'PATCH', url, { status }, fetchImpl);
    if (!res.ok) {
      throw new Error(`Не удалось сменить статус активации награды на ${status}: ${await describeError(res)}`);
    }
  }
}
