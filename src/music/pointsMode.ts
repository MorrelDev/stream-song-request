import { eventBus } from '../core/eventBus.ts';
import { logger } from '../core/logger.ts';
import { getSetting, setSetting } from '../db/settings.ts';
import {
  ensureReward,
  findManageableReward,
  getTokenInfo,
  isModeratorOrVip,
  listUnfulfilledRedemptions,
  PRIVILEGE_SCOPES,
  updateRedemptionStatus,
  updateReward,
  type ChannelPointsApiConfig,
  type RewardSettings,
} from '../integrations/twitch/channelPointsApi.ts';
import { TwitchEventSubClient } from '../integrations/twitch/eventSubClient.ts';
import { registerPointsRequestHandler } from './pointsRequestHandler.ts';
import type { RequestHandlerConfig } from './requestHandler.ts';
import { getRequestRedemption, pendingRedemptionIds } from '../db/musicQueue.ts';
import type { RewardRedeemedEvent, SongRequestFinishedEvent } from '../core/events.ts';

// id награды, созданной приложением, — по нему она находится при следующих
// запусках, даже если её переименовали в панели Twitch.
const REWARD_ID_SETTING = 'points.reward_id';

export interface PointsModeConfig {
  api: ChannelPointsApiConfig;
  /** Название/цена/подсказка — только для создания награды, существующую не меняют. */
  reward: RewardSettings;
  request: RequestHandlerConfig;
  /** Privilege-режим: заказы стримера, модераторов и VIP бесплатны (баллы возвращаются). */
  privilegeMode: boolean;
}

export interface PointsModeHandle {
  /** Актуальное название награды на Twitch — для подсказки в ответ на команду заказа. */
  getRewardTitle(): string;
  /** Отключиться от EventSub и поставить награду на паузу, пока приложение не запущено. */
  stop(): Promise<void>;
}

/**
 * Запуск режима "заказ музыки за баллы канала":
 *  1. проверяет, что токен выдан именно стримером (иначе Twitch отвечает 403
 *     на всё подряд, и понять причину по логу было бы сложно);
 *  2. находит награду приложения (по сохранённому id) или создаёт её (см. ensureReward);
 *  3. отклоняет с возвратом баллов активации, которые "зависли", пока
 *     приложение не работало (например, после падения) — обработать их
 *     задним числом уже нельзя, а без этого баллы зрителей пропали бы;
 *  4. подписывается на новые активации через EventSub.
 */
export async function startPointsRequestMode(cfg: PointsModeConfig, fetchImpl: typeof fetch = fetch): Promise<PointsModeHandle> {
  const token = await getTokenInfo(await cfg.api.getAccessToken(), fetchImpl);
  if (token.userId !== cfg.api.broadcasterId) {
    throw new Error(
      `Токен для баллов канала выдан не стримером (id ${token.userId}, а нужен TWITCH_BROADCASTER_ID=${cfg.api.broadcasterId}). ` +
        'Twitch даёт управлять наградами только самому стримеру — пройди "npm run auth:twitch-points" ещё раз, ' +
        'залогинившись в браузере аккаунтом канала.',
    );
  }

  // Без скоупов на списки модераторов/VIP Privilege-режим не работает — но
  // это не повод отключать заказы за баллы целиком: просто все платят.
  let privilegeMode = cfg.privilegeMode;
  const missingScopes = PRIVILEGE_SCOPES.filter((s) => !token.scopes.includes(s));
  if (privilegeMode && missingScopes.length > 0) {
    privilegeMode = false;
    logger.error(
      'music',
      `MUSIC_PRIVILEGE_MODE включён, но у токена стримера нет скоупов ${missingScopes.join(', ')} — ` +
        'Privilege-режим выключен, модераторы и VIP платят баллами, как все. Пройди "npm run auth:twitch-points" ' +
        'ещё раз (аккаунтом канала) и перезапусти приложение.',
    );
  } else if (privilegeMode) {
    logger.info('music', 'Privilege-режим: заказы стримера, модераторов и VIP бесплатны — баллы возвращаются');
  }

  const reward = await ensureReward(cfg.api, cfg.reward, getSetting(REWARD_ID_SETTING), fetchImpl);
  const rewardId = reward.id;
  setSetting(REWARD_ID_SETTING, rewardId);
  logger.info(
    'music',
    reward.created
      ? `Создана награда за баллы канала "${reward.title}" (${cfg.reward.cost} баллов) — дальше её можно настраивать в панели Twitch`
      : `Награда за баллы канала "${reward.title}" готова к заказам`,
  );

  // Награду могут переименовать в панели прямо во время стрима — берём
  // актуальное название из каждой активации.
  let rewardTitle = reward.title;
  const onRedeemed = (e: RewardRedeemedEvent): void => {
    if (e.rewardTitle) rewardTitle = e.rewardTitle;
  };
  eventBus.on('channel_points.redeemed', onRedeemed);

  try {
    // Заказы, которые ещё ждут очереди, тоже "в ожидании" — их не трогаем:
    // выполнятся или вернутся, когда до них дойдёт очередь.
    const waiting = new Set(pendingRedemptionIds());
    const stale = (await listUnfulfilledRedemptions(cfg.api, rewardId, fetchImpl)).filter((r) => !waiting.has(r.id));
    if (stale.length > 0) {
      await updateRedemptionStatus(
        cfg.api,
        rewardId,
        stale.map((r) => r.id),
        'CANCELED',
        fetchImpl,
      );
      logger.warn(
        'music',
        `Отклонено с возвратом баллов ${stale.length} необработанных заказов, сделанных, пока приложение не работало: ` +
          stale.map((r) => `${r.userName} ("${r.userInput}")`).join(', '),
      );
    }
  } catch (err) {
    logger.error('music', 'Не удалось вернуть баллы за заказы, сделанные, пока приложение не работало', err);
  }

  const unregister = registerPointsRequestHandler(
    {
      request: cfg.request,
      setRedemptionStatus: (redemption, status) =>
        updateRedemptionStatus(cfg.api, redemption.rewardId, [redemption.redemptionId], status, fetchImpl),
      isPrivileged: privilegeMode ? (userId) => isModeratorOrVip(cfg.api, userId, fetchImpl) : undefined,
    },
    fetchImpl,
  );

  // Заказ доигран, скипнут или не запустился: звук пошёл — активация
  // выполнена; не пошёл (yt-dlp не скачал, Spotify не заиграл, скипнули до
  // начала) — отклонена, и Twitch возвращает зрителю баллы.
  const onRequestFinished = (e: SongRequestFinishedEvent): void => {
    // Активацию берём из базы, а не из события: заказ мог стать бесплатным
    // (Privilege-режим), и тогда она уже отклонена и отвязана.
    const current = getRequestRedemption(e.requestId);
    const settled = { ...e, redemptionId: current?.redemptionId ?? null, rewardId: current?.rewardId ?? null };
    void settleRequestRedemption(settled, (rewardId, redemptionId, status) =>
      updateRedemptionStatus(cfg.api, rewardId, [redemptionId], status, fetchImpl),
    );
  };
  eventBus.on('song.request_finished', onRequestFinished);

  const client = new TwitchEventSubClient(
    {
      clientId: cfg.api.clientId,
      broadcasterId: cfg.api.broadcasterId,
      rewardId,
      getAccessToken: cfg.api.getAccessToken,
    },
    fetchImpl,
  );
  client.connect();

  return {
    getRewardTitle: () => rewardTitle,
    async stop() {
      client.disconnect();
      unregister();
      eventBus.off('channel_points.redeemed', onRedeemed);
      eventBus.off('song.request_finished', onRequestFinished);
      // Пауза, а не выключение: награда остаётся видна зрителям, но
      // активировать её, пока заказы некому обрабатывать, нельзя.
      await updateReward(cfg.api, rewardId, { is_paused: true }, fetchImpl);
    },
  };
}

/**
 * Режим заказа командой: если награда приложения осталась с прошлого запуска
 * в режиме баллов — выключает её, чтобы зрители не тратили баллы впустую.
 * Возвращает название выключенной награды или null, если её нет.
 */
export async function disablePointsReward(
  api: ChannelPointsApiConfig,
  rewardTitle: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string | null> {
  const reward = await findManageableReward(api, { id: getSetting(REWARD_ID_SETTING), title: rewardTitle }, fetchImpl);
  if (!reward) return null;
  await updateReward(api, reward.id, { is_enabled: false }, fetchImpl);
  return reward.title;
}

/**
 * Заказ за баллы закончился: звук пошёл — активация выполнена; не пошёл —
 * отклонена (Twitch возвращает баллы), и в чат уходит объяснение. Заказ не
 * за баллы (команда !sr) — ничего не делает.
 */
export async function settleRequestRedemption(
  e: SongRequestFinishedEvent,
  setStatus: (rewardId: string, redemptionId: string, status: 'FULFILLED' | 'CANCELED') => Promise<void>,
): Promise<void> {
  if (!e.redemptionId || !e.rewardId) return;
  const status = e.audioStarted ? 'FULFILLED' : 'CANCELED';
  try {
    await setStatus(e.rewardId, e.redemptionId, status);
  } catch (err) {
    logger.error(
      'music',
      `Не удалось отметить заказ "${e.title}" (${e.requestedByLogin}) как ${status} — его можно обработать вручную в очереди запросов наград на Twitch`,
      err,
    );
    return;
  }
  if (status === 'CANCELED') {
    logger.warn('music', `Заказ "${e.title}" (${e.requestedByLogin}) не запустился — баллы возвращены`);
    eventBus.emit('chat.reply', { text: `@${e.requestedByLogin} не получилось включить "${e.title}" — баллы вернул` });
  }
}
