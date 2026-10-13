export interface SkipVoteTrackerConfig {
  /** Процент от числа зрителей стрима, необходимый для скипа (например 30). */
  thresholdPercent: number;
}

export type VoteResult =
  /** Голос учтён, порог ещё не достигнут. */
  | 'counted'
  /** Этим голосом порог достигнут — трек пора скипать. */
  | 'passed'
  /** Порог уже был достигнут раньше — голос ни на что не влияет. */
  | 'closed';

/**
 * Голоса за скип текущего трека. Порог — округлённый вверх процент от числа
 * зрителей стрима (Math.ceil, чтобы, например, при 3 зрителях и пороге 30%
 * требовался хотя бы 1 голос, а не 0 — 30% от 3 это 0.9).
 *
 * Порог задаётся один раз на трек (lockThreshold — при первом голосе) и
 * дальше не меняется до resetVotes(): число зрителей за время трека плавает,
 * и без фиксации планка двигалась бы посреди голосования.
 */
export class SkipVoteTracker {
  private readonly cfg: SkipVoteTrackerConfig;
  private readonly votes = new Set<string>();
  /** Порог для текущего трека; null — ещё не зафиксирован. */
  private required: number | null = null;

  constructor(cfg: SkipVoteTrackerConfig) {
    this.cfg = cfg;
  }

  /** Сколько голосов нужно при данном числе зрителей (не меньше 1). */
  computeRequired(viewerCount: number): number {
    return Math.max(1, Math.ceil((viewerCount * this.cfg.thresholdPercent) / 100));
  }

  /** Фиксирует порог текущего трека по числу зрителей; повторные вызовы игнорируются. */
  lockThreshold(viewerCount: number): void {
    this.required ??= this.computeRequired(viewerCount);
  }

  /** Зафиксированный порог текущего трека или null, если голосование ещё не начиналось. */
  requiredVotes(): number | null {
    return this.required;
  }

  /**
   * Регистрирует голос пользователя за скип (повторный голос того же
   * пользователя не учитывается дважды). 'passed' возвращается ровно один
   * раз за трек — чтобы почти одновременные голоса не скипнули два трека.
   * Порог должен быть зафиксирован заранее (lockThreshold).
   */
  vote(userId: string): VoteResult {
    if (this.required === null) throw new Error('Порог скипа не зафиксирован');
    if (this.votes.size >= this.required) return 'closed';
    this.votes.add(userId);
    return this.votes.size >= this.required ? 'passed' : 'counted';
  }

  get voteCount(): number {
    return this.votes.size;
  }

  /** Сбрасывает голоса и порог (вызывается при смене трека). */
  resetVotes(): void {
    this.votes.clear();
    this.required = null;
  }
}
