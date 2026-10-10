import { spawn, execFile } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { logger } from '../core/logger.ts';

export interface PlaybackSession {
  /** Резолвится, когда воспроизведение естественным образом завершилось. */
  finished: Promise<void>;
  /** Принудительно остановить (скип). */
  stop: () => void;
  /**
   * Резолвится, когда mpv открыл аудиовыход — то есть звук реально пошёл, а
   * не просто процесс запущен. Если mpv так и не заиграл (упал, остановлен),
   * не резолвится никогда — ждать его стоит вместе с finished. Есть только у
   * сессий mpv; нужен проверке перед стримом (scripts/music-check.ts).
   */
  audioStarted?: Promise<void>;
}

/**
 * Запускает произвольный процесс-плеер и оборачивает его в PlaybackSession.
 * Вынесено отдельно от playYoutubeUrl(), чтобы быть тестируемым без mpv —
 * в тестах сюда подставляется сам node с простым скриптом.
 */
const MAX_CAPTURED_OUTPUT = 4000;

// mpv пишет "AO: [wasapi] 48000Hz stereo 2ch float" в момент, когда открыл
// аудиоустройство и начал выводить звук.
const MPV_AUDIO_OUTPUT_LINE_RE = /(^|\n)AO: /;

/** См. PlaybackSession.audioStarted. */
function watchAudioStart(streams: (NodeJS.ReadableStream | null)[]): Promise<void> {
  return new Promise((resolve) => {
    for (const stream of streams) {
      // Хвост прошлого куска — на случай, если строка "AO:" разорвана между кусками.
      let tail = '';
      stream?.on('data', (chunk: Buffer) => {
        const text = tail + chunk.toString('utf8');
        if (MPV_AUDIO_OUTPUT_LINE_RE.test(text)) resolve();
        tail = text.slice(-16);
      });
    }
  });
}

export function spawnPlaybackProcess(command: string, args: string[]): PlaybackSession {
  // Раньше stdio был 'ignore' с флагом --really-quiet у mpv — в случае
  // ошибки (например, yt-dlp не смог разобрать ссылку) наружу летел только
  // голый код выхода, без единой подсказки, что именно пошло не так.
  // Теперь вывод процесса перехватывается (а не выводится в наш собственный
  // терминал) и при ненулевом коде выхода прикладывается к ошибке.
  const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let stopped = false;
  let capturedOutput = '';

  const captureChunk = (chunk: Buffer): void => {
    capturedOutput += chunk.toString('utf8');
    if (capturedOutput.length > MAX_CAPTURED_OUTPUT) {
      capturedOutput = capturedOutput.slice(capturedOutput.length - MAX_CAPTURED_OUTPUT);
    }
  };
  child.stdout?.on('data', captureChunk);
  child.stderr?.on('data', captureChunk);

  const finished = new Promise<void>((resolve, reject) => {
    child.on('exit', (code) => {
      if (stopped || code === 0 || code === null) {
        resolve();
      } else {
        const details = capturedOutput.trim();
        const suffix = details ? `\n--- вывод "${command}" ---\n${details}` : ' (без вывода в stdout/stderr)';
        reject(new Error(`Процесс плеера "${command}" завершился с кодом ${code}${suffix}`));
      }
    });
    child.on('error', (err) => reject(err));
  });

  return {
    finished,
    stop: () => {
      stopped = true;
      killProcess(child);
    },
    audioStarted: watchAudioStart([child.stdout, child.stderr]),
  };
}

/**
 * Останавливает процесс плеера (используется для скипа). На всех ОС, кроме
 * Windows, обычный child.kill('SIGTERM') работает нормально.
 *
 * На Windows — нет: Node.js там лишь эмулирует POSIX-сигналы, а
 * child.kill() под капотом сводится к TerminateProcess только для САМОГО
 * процесса (но не для его дочерних процессов, если они у него есть). На
 * практике это плохо ловится тестами (нужна реальная Windows-машина), но
 * именно это — известная и частая причина, почему "скип" визуально
 * срабатывает (следующий трек в очереди стартует), а прошлый процесс
 * из-за этого не завершается и продолжает играть параллельно с новым (два
 * трека одновременно). taskkill с /T (дерево процессов, то есть и сам
 * процесс, и все его потомки) и /F (принудительно) останавливает его
 * гарантированно.
 */
function killProcess(child: ReturnType<typeof spawn>): void {
  if (process.platform === 'win32' && child.pid) {
    execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], () => {
      // Ошибку игнорируем: например, если процесс уже успел завершиться
      // сам между вызовом stop() и запуском taskkill (гонка) — taskkill
      // вернёт "process not found", это не проблема, а не сбой скипа.
    });
    return;
  }
  child.kill('SIGTERM');
}

export interface YoutubePlaybackOptions {
  /**
   * Какого "клиента" YouTube изображает yt-dlp при запросе видео — например
   * "tv" или "android_vr". YouTube в 2025 постепенно требует т.н. PO Token
   * почти для всех клиентов, кроме нескольких — запрос от их имени сейчас
   * работает и без токена/кук ("Sign in to confirm you're not a bot").
   * Пусто/undefined — --extractor-args не передаётся вообще.
   */
  playerClient?: string;
  /** Имя браузера для --cookies-from-browser (firefox/chrome/edge/...). */
  cookiesFromBrowser?: string;
  /** Путь к cookies.txt в формате Netscape — альтернатива cookiesFromBrowser. */
  cookiesFile?: string;
  /**
   * Явный путь к исполняемому файлу yt-dlp, который мы сами запускаем для
   * скачивания аудио (см. playYoutubeUrl). Полезно, если на машине несколько
   * установок yt-dlp (например, winget поставил один, а рядом вручную
   * положен более свежий .exe) — без этой опции используется первый yt-dlp,
   * который найдётся в PATH, а это не всегда тот, который реально обновлялся.
   */
  ytdlPath?: string;
  /**
   * Заставляет yt-dlp резолвить и скачивать видео только по IPv4
   * (yt-dlp --force-ipv4). Раньше (когда прямую ссылку на googlevideo.com
   * получал yt-dlp, а скачивал её сам mpv отдельным HTTP-запросом) это было
   * попыткой обойти "HTTP error 403 Forbidden" из-за IP-привязки ссылки —
   * ссылка привязывается к IP, с которого её запросил yt-dlp, и если сам
   * mpv стучится с другого IP (типично на dual-stack сетях), YouTube отвечал
   * 403. Теперь skачивание тоже делает yt-dlp (см. playYoutubeUrl) — тот же
   * процесс, тот же IP что для резолва, что для скачивания, так что эта
   * проблема больше не актуальна сама по себе, но флаг всё равно оставлен —
   * иногда IPv4 просто стабильнее IPv6 на конкретной сети.
   */
  forceIpv4?: boolean;
  /**
   * Громкость плеера при старте (0-100 согласно масштабу громкости mpv по
   * умолчанию — --volume-max=100 из коробки). Раньше mpv стартовал со своей
   * собственной громкостью по умолчанию (обычно 100), из-за чего YouTube-
   * заказы часто включались заметно громче, чем играл до этого Spotify.
   * undefined — флаг --volume вообще не передаётся (используется дефолт mpv).
   */
  volume?: number;
  /**
   * Имя аудио-устройства, на которое mpv должен выводить звук — например
   * "wasapi/{GUID-устройства}" или просто часть названия вроде "CABLE Input"
   * (см. MPV_AUDIO_DEVICE в .env.example для инструкции, как узнать точное
   * значение). Нужно, чтобы в OBS можно было захватить звук именно
   * YouTube-заказов отдельно от остального звука системы — например, через
   * виртуальный аудио-кабель (VB-CABLE и т.п.). undefined — флаг
   * --audio-device вообще не передаётся, используется устройство по
   * умолчанию (то же, что и у остальной системы).
   */
  audioDevice?: string;
}

const YTDLP_CONCURRENT_FRAGMENTS = 4;

/**
 * Собирает аргументы командной строки yt-dlp для скачивания только аудио
 * заданного видео и вывода его сырых байт в stdout (playYoutubeUrl пускает
 * этот stdout прямо во stdin mpv, см. там подробное объяснение зачем).
 * infoJsonPath — данные о видео, заранее полученные preloadYoutubeInfo:
 * тогда yt-dlp не разбирает страницу заново, а сразу начинает качать.
 * Экспортировано отдельно ради юнит-тестов.
 */
export function buildYtdlpAudioArgs(videoUrl: string, options: YoutubePlaybackOptions, infoJsonPath?: string): string[] {
  // "/best" — запасной вариант: если YouTube отдал только HLS (m3u8) с
  // аудио+видео в одном потоке (SABR-эксперимент, отдельных аудиодорожек
  // нет), "bestaudio" падает с "Requested format is not available", а так
  // yt-dlp скачает совмещённый поток, и mpv с --no-video сыграет из него звук.
  //
  // --abort-on-unavailable-fragments: иначе при 403 на HLS-фрагментах yt-dlp
  // перебирает по 10 попыток на КАЖДЫЙ фрагмент и пропускает их — на стриме
  // это долгая тишина, которая всё равно кончается "downloaded file is empty".
  // Лучше упасть сразу и дать playYoutubeUrl перезапустить загрузку.
  //
  // best[height<=480]: видео mpv всё равно выбрасывает, а качаем и держим в
  // кэше mpv (см. buildMpvStdinArgs) мы его целиком. В HLS YouTube звук у
  // 480p такой же, как у 360p (AAC 128k), а весит поток в разы меньше 1080p.
  //
  // -N: HLS-фрагменты качаются по несколько параллельно (в stdout они всё
  // равно пишутся по порядку) — один медленный фрагмент не тормозит остальные.
  const args: string[] = [
    '-f',
    'bestaudio/best[height<=480]/best',
    '--no-playlist',
    '--concurrent-fragments',
    String(YTDLP_CONCURRENT_FRAGMENTS),
    '--fragment-retries',
    '3',
    '--abort-on-unavailable-fragments',
    '-o',
    '-',
    ...buildYtdlpAccessArgs(options),
  ];
  if (infoJsonPath) {
    args.push('--load-info-json', infoJsonPath);
  } else {
    args.push(videoUrl);
  }
  return args;
}

/**
 * Аргументы yt-dlp для preloadYoutubeInfo: только разобрать видео и вывести
 * данные о нём (вместе с готовыми ссылками на форматы) в stdout как JSON.
 * Экспортировано отдельно ради юнит-тестов.
 */
export function buildYtdlpInfoArgs(videoUrl: string, options: YoutubePlaybackOptions): string[] {
  return ['--dump-json', '--no-playlist', ...buildYtdlpAccessArgs(options), videoUrl];
}

/** Как yt-dlp заходит на YouTube: клиент, куки, IPv4 — общее для разбора и скачивания. */
function buildYtdlpAccessArgs(options: YoutubePlaybackOptions): string[] {
  const args: string[] = [];
  if (options.playerClient) {
    args.push('--extractor-args', `youtube:player_client=${options.playerClient}`);
  }
  if (options.cookiesFromBrowser) {
    args.push('--cookies-from-browser', options.cookiesFromBrowser);
  } else if (options.cookiesFile) {
    args.push('--cookies', options.cookiesFile);
  }
  if (options.forceIpv4) {
    args.push('--force-ipv4');
  }
  return args;
}

/** Экспортировано отдельно ради юнит-тестов, как и buildYtdlpAudioArgs. */
export function buildVolumeArg(options: YoutubePlaybackOptions): string[] {
  return options.volume === undefined ? [] : [`--volume=${options.volume}`];
}

/** Экспортировано отдельно ради юнит-тестов, как и buildYtdlpAudioArgs. */
export function buildAudioDeviceArg(options: YoutubePlaybackOptions): string[] {
  return options.audioDevice ? [`--audio-device=${options.audioDevice}`] : [];
}

/**
 * Собирает аргументы командной строки mpv для проигрывания аудио, которое
 * приходит через stdin (см. playYoutubeUrl) — "-" в качестве имени файла
 * означает для mpv именно stdin. Экспортировано отдельно ради юнит-тестов.
 *
 * --cache=yes: для stdin mpv по умолчанию кэш не включает (только для сетевых
 * потоков) и читает ровно столько, сколько нужно играть прямо сейчас. Тогда
 * через переполненный pipe тормозится и yt-dlp — он качает фрагменты "впритык",
 * и любой медленный фрагмент сразу превращается в заикание звука. С кэшем mpv
 * вычитывает stdin наперёд (до --demuxer-max-bytes), yt-dlp качает трек на
 * полной скорости, и запас копится с первых секунд.
 */
export function buildMpvStdinArgs(options: YoutubePlaybackOptions): string[] {
  return [
    ...buildVolumeArg(options),
    ...buildAudioDeviceArg(options),
    '--cache=yes',
    `--demuxer-max-bytes=${MPV_CACHE_MAX_BYTES}`,
    '--no-video',
    '-',
  ];
}

// С запасом на 10-минутный трек в 480p HLS (~1 Мбит/с ≈ 75 МиБ).
const MPV_CACHE_MAX_BYTES = '200MiB';

/**
 * Воспроизводит YouTube-видео локально: yt-dlp сам скачивает аудио и
 * стримит его сырые байты напрямую в stdin mpv, который просто их
 * проигрывает — mpv никогда не делает собственный сетевой запрос к
 * googlevideo.com.
 *
 * Так было не всегда — раньше mpv (через встроенный ytdl_hook) сам
 * резолвил и мгновенно "не мытьём, так катаньем" уже сам, а не yt-dlp
 * докачивал итоговую ссылку на googlevideo.com. Оказалось, что YouTube
 * сейчас (2026) в некоторых случаях блокирует именно сетевой запрос
 * ffmpeg/mpv к этой ссылке (HTTP 403), даже когда та же самая ссылка
 * секунду назад успешно скачивалась через сам yt-dlp (или даже banal curl) —
 * то есть ссылка валидна, но именно клиент mpv/ffmpeg под подозрением у
 * анти-бот защиты YouTube. Никакие --extractor-args/куки/IPv4 этого не
 * лечат, потому что все они влияют только на то, как РЕЗОЛВИТСЯ ссылка, а
 * не на то, кто её СКАЧИВАЕТ. Раз yt-dlp скачивать умеет надёжно (в
 * отличие от mpv) — пусть он и скачивает, а mpv остаётся только плеером.
 *
 * options управляет обходом YouTube-проверки "Sign in to confirm you're
 * not a bot" (и связанных ошибок вроде "The page needs to be reloaded") —
 * см. YOUTUBE_PLAYER_CLIENT / YOUTUBE_COOKIES_FROM_BROWSER /
 * YOUTUBE_COOKIES_FILE / YTDLP_PATH в .env.example.
 *
 * preloaded — результат preloadYoutubeInfo для этого же видео. Им пользуется
 * только первая попытка; если она упала (например, 403 на фрагментах),
 * повторы разбирают видео заново и получают свежие ссылки. Файл с данными
 * удаляется, когда воспроизведение закончилось.
 */
export function playYoutubeUrl(
  videoUrl: string,
  mpvPath = 'mpv',
  options: YoutubePlaybackOptions = {},
  preloaded?: YoutubeInfoPreload,
): PlaybackSession {
  const ytdlpPath = resolveYtdlpPath(options);
  const ytdlpOptions = withAbsoluteCookiesFile(options);
  mkdirSync(YTDLP_WORK_DIR, { recursive: true });
  const spawnAttempt = (infoJsonPath: string | null): PlaybackSession =>
    spawnYtdlpMpvPipeline(
      ytdlpPath,
      buildYtdlpAudioArgs(videoUrl, ytdlpOptions, infoJsonPath ?? undefined),
      mpvPath,
      buildMpvStdinArgs(options),
      YTDLP_WORK_DIR,
    );
  if (!preloaded) {
    return withRetryBeforeAudio(() => spawnAttempt(null), YOUTUBE_PLAYBACK_ATTEMPTS);
  }
  const session = startWhenReady(preloaded.infoJsonPath, (infoJsonPath) =>
    withRetryBeforeAudio((attempt) => spawnAttempt(attempt === 1 ? infoJsonPath : null), YOUTUBE_PLAYBACK_ATTEMPTS),
  );
  void session.finished.catch(() => {}).finally(() => preloaded.cancel());
  return session;
}

/** Заранее запущенный разбор видео (см. preloadYoutubeInfo). */
export interface YoutubeInfoPreload {
  /** Путь к JSON с данными о видео; null — разбор не удался или отменён. */
  infoJsonPath: Promise<string | null>;
  /** Остановить разбор, если он ещё идёт, и удалить файл с данными. */
  cancel: () => void;
}

/**
 * Заранее, пока играет предыдущий трек, разбирает YouTube-видео: yt-dlp
 * читает куки, страницу, несколько клиентов, решает JS-челлендж — это и есть
 * основная часть задержки в несколько секунд перед началом трека. Результат
 * сохраняется в JSON-файл, и playYoutubeUrl с ним сразу начинает качать.
 *
 * Ничего не скачивает и не занимает канал: только запросы к YouTube, которые
 * всё равно были бы сделаны при старте трека. Ссылки внутри живут несколько
 * часов, так что за 15 секунд не протухнут.
 */
export function preloadYoutubeInfo(videoUrl: string, options: YoutubePlaybackOptions = {}): YoutubeInfoPreload {
  mkdirSync(YTDLP_WORK_DIR, { recursive: true });
  const filePath = path.join(YTDLP_WORK_DIR, `info-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  const child = spawn(resolveYtdlpPath(options), buildYtdlpInfoArgs(videoUrl, withAbsoluteCookiesFile(options)), {
    stdio: ['ignore', 'pipe', 'pipe'],
    cwd: YTDLP_WORK_DIR,
  });
  let cancelled = false;
  const stdout: Buffer[] = [];
  let stderr = '';
  child.stdout?.on('data', (chunk: Buffer) => stdout.push(chunk));
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr = (stderr + chunk.toString('utf8')).slice(-MAX_CAPTURED_OUTPUT);
  });

  const infoJsonPath = new Promise<string | null>((resolve) => {
    child.on('error', (err) => {
      logger.warn('playback', `Не удалось заранее разобрать ${videoUrl} — трек запустится как обычно: ${err.message}`);
      resolve(null);
    });
    child.on('exit', (code) => {
      if (cancelled) return resolve(null);
      if (code !== 0) {
        logger.warn(
          'playback',
          `Не удалось заранее разобрать ${videoUrl} (код ${code}) — трек запустится как обычно\n${stderr.trim()}`,
        );
        return resolve(null);
      }
      try {
        writeFileSync(filePath, Buffer.concat(stdout));
        resolve(filePath);
      } catch (err) {
        logger.warn('playback', `Не удалось сохранить данные о ${videoUrl}: ${String(err)}`);
        resolve(null);
      }
    });
  });

  return {
    infoJsonPath,
    cancel: () => {
      cancelled = true;
      if (child.exitCode === null) killProcess(child);
      void infoJsonPath.then((p) => {
        if (p) rmSync(p, { force: true });
      });
    },
  };
}

/**
 * Сессия, которая запускается, когда готов ready: до этого stop() просто
 * отменяет запуск, а audioStarted ждёт сессию, которую вернёт start.
 */
function startWhenReady<T>(ready: Promise<T>, start: (value: T) => PlaybackSession): PlaybackSession {
  let stopped = false;
  let inner: PlaybackSession | undefined;
  let resolveAudioStarted!: () => void;
  const audioStarted = new Promise<void>((resolve) => {
    resolveAudioStarted = resolve;
  });
  const finished = ready.then((value) => {
    if (stopped) return;
    inner = start(value);
    void inner.audioStarted?.then(resolveAudioStarted);
    return inner.finished;
  });
  return {
    finished,
    stop: () => {
      stopped = true;
      inner?.stop();
    },
    audioStarted,
  };
}

/**
 * yt-dlp запускается из временной папки (см. YTDLP_WORK_DIR), поэтому
 * относительные пути из .env заранее делаются абсолютными. Голое имя
 * ("yt-dlp") не трогаем — его ищут по PATH.
 */
function resolveYtdlpPath(options: YoutubePlaybackOptions): string {
  return options.ytdlPath ? resolveIfRelativePath(options.ytdlPath) : 'yt-dlp';
}

function withAbsoluteCookiesFile(options: YoutubePlaybackOptions): YoutubePlaybackOptions {
  return options.cookiesFile ? { ...options, cookiesFile: path.resolve(options.cookiesFile) } : options;
}

/**
 * Рабочая папка процесса yt-dlp. При выводе в stdout он кладёт HLS-фрагменты
 * в ТЕКУЩУЮ папку (файлы вида "--Frag12", --paths temp: на них не влияет), и
 * если загрузку оборвать (скип, ошибка фрагмента), они там и остаются —
 * раньше это был корень проекта.
 */
const YTDLP_WORK_DIR = path.join(os.tmpdir(), 'stream-companion-ytdlp');

function resolveIfRelativePath(command: string): string {
  return command.includes('/') || command.includes('\\') ? path.resolve(command) : command;
}

const YOUTUBE_PLAYBACK_ATTEMPTS = 3;

/**
 * Перезапускает сессию, если она упала, так и не начав играть звук.
 * YouTube периодически отдаёт ссылки, на которых все фрагменты отвечают
 * 403, а повторный запрос того же видео через секунду проходит. Если звук
 * уже пошёл (audioStarted), повтор не делается — иначе трек начался бы
 * заново с начала. Сессии без audioStarted не повторяются вообще.
 * Экспортировано отдельно ради юнит-тестов.
 */
export function withRetryBeforeAudio(start: (attempt: number) => PlaybackSession, attempts: number): PlaybackSession {
  let stopped = false;
  let current: PlaybackSession;
  let resolveAudioStarted!: () => void;
  const audioStarted = new Promise<void>((resolve) => {
    resolveAudioStarted = resolve;
  });

  const run = async (attempt: number): Promise<void> => {
    current = start(attempt);
    let started = false;
    void current.audioStarted?.then(() => {
      started = true;
      resolveAudioStarted();
    });
    try {
      await current.finished;
    } catch (err) {
      if (stopped || started || !current.audioStarted || attempt >= attempts) throw err;
      return run(attempt + 1);
    }
  };

  // run() синхронно вызывает start() до первого await, так что current
  // гарантированно задан к моменту, когда кто-то сможет вызвать stop().
  const finished = run(1);
  return {
    finished,
    stop: () => {
      stopped = true;
      current.stop();
    },
    audioStarted,
  };
}

/**
 * Соединяет процесс yt-dlp (скачивает аудио, пишет сырые байты в stdout) с
 * процессом mpv (читает их из stdin и проигрывает) — см. playYoutubeUrl,
 * где объясняется, почему именно так. Вынесено отдельно от playYoutubeUrl
 * ради юнит-тестов: сюда можно подставить node с простыми скриптами вместо
 * реальных yt-dlp/mpv, не трогая сборку аргументов командной строки.
 */
export function spawnYtdlpMpvPipeline(
  ytdlpPath: string,
  ytdlpArgs: string[],
  mpvPath: string,
  mpvArgs: string[],
  ytdlpCwd?: string,
): PlaybackSession {
  const ytdlp = spawn(ytdlpPath, ytdlpArgs, { stdio: ['ignore', 'pipe', 'pipe'], cwd: ytdlpCwd });
  const mpv = spawn(mpvPath, mpvArgs, { stdio: [ytdlp.stdout, 'pipe', 'pipe'] });

  let stopped = false;
  let ytdlpStderr = '';
  let mpvOutput = '';

  const capture = (target: 'ytdlp' | 'mpv') =>
    (chunk: Buffer): void => {
      if (target === 'ytdlp') {
        ytdlpStderr += chunk.toString('utf8');
        if (ytdlpStderr.length > MAX_CAPTURED_OUTPUT) {
          ytdlpStderr = ytdlpStderr.slice(ytdlpStderr.length - MAX_CAPTURED_OUTPUT);
        }
      } else {
        mpvOutput += chunk.toString('utf8');
        if (mpvOutput.length > MAX_CAPTURED_OUTPUT) {
          mpvOutput = mpvOutput.slice(mpvOutput.length - MAX_CAPTURED_OUTPUT);
        }
      }
    };
  ytdlp.stderr?.on('data', capture('ytdlp'));
  mpv.stdout?.on('data', capture('mpv'));
  mpv.stderr?.on('data', capture('mpv'));

  // yt-dlp может либо не найти видео/упереться в бан (см. буллеты про
  // "Sign in to confirm..." в README), либо честно докачать всё до конца —
  // в обоих случаях он завершается сам, до того как закончит играть mpv
  // (mpv просто получит EOF на stdin, когда yt-dlp закроет stdout). Только
  // ошибка самого yt-dlp (ненулевой код) означает реальный сбой — если он
  // вышел с 0, это значит "аудио полностью докачано", а не "воспроизведение
  // не удалось".
  let ytdlpFailed = false;
  const ytdlpDone = new Promise<void>((resolve) => {
    ytdlp.on('exit', (code) => {
      if (!stopped && code !== 0 && code !== null) {
        ytdlpFailed = true;
      }
      resolve();
    });
    ytdlp.on('error', () => {
      ytdlpFailed = true;
      resolve();
    });
  });

  const finished = new Promise<void>((resolve, reject) => {
    mpv.on('exit', (code) => {
      void ytdlpDone.then(() => {
        if (stopped) {
          resolve();
          return;
        }
        if (ytdlpFailed) {
          const details = ytdlpStderr.trim();
          const suffix = details ? `\n--- вывод "${ytdlpPath}" ---\n${details}` : ' (без вывода в stdout/stderr)';
          reject(new Error(`Процесс "${ytdlpPath}" не смог скачать аудио${suffix}`));
          return;
        }
        if (code === 0 || code === null) {
          resolve();
          return;
        }
        const details = mpvOutput.trim();
        const suffix = details ? `\n--- вывод "${mpvPath}" ---\n${details}` : ' (без вывода в stdout/stderr)';
        reject(new Error(`Процесс плеера "${mpvPath}" завершился с кодом ${code}${suffix}`));
      });
    });
    mpv.on('error', (err) => reject(err));
  });

  return {
    finished,
    stop: () => {
      stopped = true;
      killProcess(mpv);
      killProcess(ytdlp);
    },
    audioStarted: watchAudioStart([mpv.stdout, mpv.stderr]),
  };
}
