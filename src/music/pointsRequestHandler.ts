import { eventBus } from '../core/eventBus.ts';
import { logger } from '../core/logger.ts';
import { processSongRequest, describeLinkSources, type RequestHandlerConfig, type SongRequestOutcome } from './requestHandler.ts';
import { detachRedemption } from '../db/musicQueue.ts';
import type { RewardRedeemedEvent } from '../core/events.ts';
import type { RedemptionStatus } from '../integrations/twitch/channelPointsApi.ts';

export interface PointsRequestHandlerConfig {
  request: RequestHandlerConfig;
  /** Выполнить (FULFILLED) или отклонить с возвратом баллов (CANCELED) активацию в Twitch. */
  setRedemptionStatus: (redemption: RewardRedeemedEvent, status: RedemptionStatus) => Promise<void>;
  /**
   * Privilege-режим (MUSIC_PRIVILEGE_MODE): true — пользователь модератор
   * или VIP, и его заказ принимается бесплатно. Не задано — режим выключен.
   */
  isPrivileged?: (userId: string) => Promise<boolean>;
}

function reply(text: string): void {
  eventBus.emit('chat.reply', { text });
}

/** Подписывает обработчик заказов за баллы канала на активации награды. */
export function registerPointsRequestHandler(cfg: PointsRequestHandlerConfig, fetchImpl: typeof fetch = fetch): () => void {
  const onRedeemed = (redemption: RewardRedeemedEvent): void => {
    void handleRedemption(redemption, cfg, fetchImpl);
  };
  eventBus.on('channel_points.redeemed', onRedeemed);
  return () => eventBus.off('channel_points.redeemed', onRedeemed);
}

/**
 * Одна активация награды "заказ музыки": те же правила, что и у команды
 * заказа (см. processSongRequest), кроме проверки фолловинга — за баллы
 * может заказывать любой зритель. Трек встал в очередь — активация ждёт,
 * пока трек зазвучит (тогда её выполняют; не запустился — отклоняют, см.
 * pointsMode.ts); не встал по любой причине (включая непредвиденную ошибку)
 * — активация отклоняется сразу, и Twitch сам возвращает зрителю баллы.
 *
 * В Privilege-режиме заказ стримера, модератора или VIP, вставший в очередь,
 * отклоняется сразу — трек остаётся в очереди, а баллы возвращаются.
 */
export async function handleRedemption(
  redemption: RewardRedeemedEvent,
  cfg: PointsRequestHandlerConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const requester = {
    userId: redemption.userId,
    login: redemption.userLogin,
    displayName: redemption.userName,
    isBroadcaster: redemption.userId === cfg.request.twitchBroadcasterId,
    redemption: { redemptionId: redemption.redemptionId, rewardId: redemption.rewardId },
  };

  let outcome: SongRequestOutcome;
  try {
    outcome = await processSongRequest(
      requester,
      redemption.userInput,
      cfg.request,
      {
        emptyArgHint: `укажи ссылку на ${describeLinkSources(cfg.request, 'или')} в тексте награды "${redemption.rewardTitle}"`,
        requireFollower: false,
      },
      fetchImpl,
    );
  } catch (err) {
    logger.error('music', 'Ошибка обработки заказа музыки за баллы канала', err);
    outcome = {
      queued: false,
      replyText: `@${redemption.userName} не получилось обработать заказ, попробуй ещё раз чуть позже`,
    };
  }

  const free = outcome.queued && (await isFreeRequest(redemption, requester.isBroadcaster, cfg));

  // Платный заказ встал в очередь — активация остаётся "в ожидании": её
  // выполнят, когда трек зазвучит, или отклонят с возвратом баллов, если он
  // не запустится (см. pointsMode.ts, событие song.request_finished).
  if (outcome.queued && !free) {
    reply(outcome.replyText);
    return;
  }
  // Бесплатный заказ (Privilege-режим) встал в очередь — активацию отклоняем
  // сразу и отвязываем от заказа, чтобы её больше не трогали. Заказ не
  // принят — активация отклоняется сразу. В обоих случаях баллы возвращаются.
  if (free && outcome.requestId !== undefined) detachRedemption(outcome.requestId);
  const status: RedemptionStatus = 'CANCELED';
  let statusUpdated = true;
  try {
    await cfg.setRedemptionStatus(redemption, status);
  } catch (err) {
    statusUpdated = false;
    logger.error(
      'music',
      `Не удалось отметить активацию награды ${redemption.redemptionId} (${redemption.userName}) как ${status} — ` +
        'её можно обработать вручную в очереди запросов наград на Twitch',
      err,
    );
  }

  if (statusUpdated) {
    reply(outcome.replyText);
  } else {
    reply(`${outcome.replyText} (баллы не удалось вернуть автоматически — стример вернёт их вручную)`);
  }
}

/**
 * Privilege-режим: заказ бесплатный для стримера, модераторов и VIP. Если
 * роль узнать не удалось — заказ платный, как у обычного зрителя (трек уже в
 * очереди, а вернуть баллы стример может и вручную).
 */
async function isFreeRequest(
  redemption: RewardRedeemedEvent,
  isBroadcaster: boolean,
  cfg: PointsRequestHandlerConfig,
): Promise<boolean> {
  if (!cfg.isPrivileged) return false;
  if (isBroadcaster) return true;
  try {
    return await cfg.isPrivileged(redemption.userId);
  } catch (err) {
    logger.error(
      'music',
      `Не удалось проверить, модератор или VIP ли ${redemption.userName}, — баллы за заказ списаны как у обычного зрителя`,
      err,
    );
    return false;
  }
}
