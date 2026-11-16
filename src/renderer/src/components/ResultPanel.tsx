import { Radio } from '@base-ui/react/radio'
import { RadioGroup } from '@base-ui/react/radio-group'
import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import { previewCandidates, previewUrl } from '@shared/preview'
import { loginLabel, PLATFORM_NAMES, type ImageItem, type MediaResult, type VideoItem, type VideoVariant } from '@shared/types'
import { attachDash, type DashTrack } from '../lib/dash'
import { formatBytes, formatDuration, frameNumber, hangsLeft } from '../lib/format'
import { CloseIcon, DownloadIcon } from './icons'
import { ImageViewer } from './ImageViewer'
import styles from './ResultPanel.module.css'

/** 一项数据：名称和取值。取值为空的不显示 */
type Spec = [label: string, value: ReactNode]

function Specs({ items }: { items: Spec[] }) {
  return (
    <dl className={styles.specs}>
      {items.map(([label, value]) =>
        value ? (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ) : null
      )}
    </dl>
  )
}

interface Props {
  result: MediaResult
  onLogin: () => void
  onClose: () => void
  onShowDownloads: () => void
}

export function ResultPanel({ result, onLogin, onClose, onShowDownloads }: Props) {
  const video = result.items.find((i): i is VideoItem => i.kind === 'video')
  const [variantId, setVariantId] = useState(video?.variants[0]?.id)
  const variant = video?.variants.find((v) => v.id === variantId)
  const [viewing, setViewing] = useState<number | null>(null)
  const [queued, setQueued] = useState(0)
  // 这台电脑播不了的版本（比如没有 HEVC 解码器），预览时跳过
  const [unplayable, setUnplayable] = useState<string[]>([])
  const player = useRef<HTMLVideoElement>(null)
  const resume = useRef<Resume | null>(null)

  // 换清晰度后预览换了来源会重新加载，先记下播放位置，加载后从这里接着放。
  // 上一次切换的还没加载出来时（readyState 是 0）读不到位置，仍以那一次记下的为准
  function selectVariant(id: string) {
    const el = player.current
    const next = previewCandidates(video?.variants ?? [], id).find((v) => !unplayable.includes(v.id))
    if (el && el.readyState > 0 && next?.id !== preview?.id) resume.current = { time: el.currentTime, playing: !el.paused }
    setVariantId(id)
  }

  const images = result.items.filter((i): i is ImageItem => i.kind === 'image')
  const liveCount = images.filter((i) => i.liveVideo).length
  const base = { platform: result.platform, title: result.title, cover: result.cover, headers: result.headers }

  function download() {
    if (variant)
      void window.api.downloads.start({
        ...base,
        label: variant.label,
        fileName: result.title,
        ext: 'mp4',
        source: variant.video,
        audio: variant.audio,
        expectedSize: variant.size,
        hls: variant.hls,
        duration: video?.duration
      })
    images.forEach((_, index) => downloadImage(index))
    if (variant) setQueued((n) => n + 1)
  }

  // 图片保存到以标题命名的文件夹里，按顺序编号；实况图的视频与图片同名
  function downloadImage(index: number) {
    const img = images[index]
    if (!img) return
    const label = `图 ${index + 1}/${images.length}`
    // 下载列表里每张图显示它自己的缩略图
    const shared = { ...base, cover: img.preview ?? img.image.url, subDir: result.title, fileName: frameNumber(index) }
    void window.api.downloads.start({ ...shared, label, ext: img.ext, source: img.image })
    if (img.liveVideo) void window.api.downloads.start({ ...shared, label: `${label} 实况`, ext: 'mp4', source: img.liveVideo })
    setQueued((n) => n + 1)
  }

  const first = images[0]
  const specs: Spec[] = variant
    ? [
        ['时长', video?.duration && formatDuration(video.duration)],
        ['尺寸', variant.width && variant.height && `${variant.width}×${variant.height}`],
        ['编码', variant.codec],
        ['大小', variant.size && `${variant.sizeIsEstimate ? '约 ' : ''}${formatBytes(variant.size)}`],
        ['格式', 'MP4']
      ]
    : first
      ? [
          ['图片', `${images.length} 张`],
          ['实况', liveCount > 0 && `${liveCount} 张`],
          ['尺寸', first.width && first.height && `${first.width}×${first.height}`],
          ['格式', first.ext.toUpperCase()]
        ]
      : []
  const saveNote = variant
    ? variant.hls
      ? 'M3U8 视频流，下载后保存为 MP4'
      : variant.audio && '下载后自动合并音视频'
    : first && '保存到以标题命名的文件夹'

  const preview = previewCandidates(video?.variants ?? [], variantId).find((v) => !unplayable.includes(v.id))
  // 竖屏视频左右排版，播放器才能用上整页的高度。不是每个版本都带尺寸，取带了的那个，换清晰度时排版才不会变
  const sized = video?.variants.find((v) => v.width && v.height)
  const portrait = !!sized?.width && !!sized.height && sized.height > sized.width

  return (
    <section className={styles.panel} data-layout={portrait ? 'side' : undefined} aria-label="解析结果">
      <header className={styles.head}>
        <div className={styles.info}>
          <h1 className={styles.title} data-hang={hangsLeft(result.title) || undefined}>
            {result.title}
          </h1>
          <p className={styles.byline}>{[PLATFORM_NAMES[result.platform], result.author].filter(Boolean).join(' · ')}</p>
        </div>
        <button className={`icon-btn ${styles.close}`} onClick={onClose} aria-label="关闭解析结果" title="关闭解析结果">
          <CloseIcon />
        </button>
        <div className={styles.choose}>
          {video && video.variants.length > 1 && (
            <RadioGroup
              className={styles.segments}
              value={variantId}
              onValueChange={(value) => selectVariant(value as string)}
              aria-label="清晰度"
            >
              {video.variants.map((v) => (
                <Radio.Root key={v.id} value={v.id} className={styles.segment}>
                  {v.label}
                </Radio.Root>
              ))}
            </RadioGroup>
          )}
          <Specs items={specs} />
        </div>
        <div className={styles.action}>
          <button className="btn btn-primary" onClick={download} disabled={!variant && images.length === 0}>
            <DownloadIcon />
            {images.length > 1 ? '下载全部' : '下载'}
          </button>
          {queued > 0 && (
            <p className={styles.queued} role="status">
              已加入下载 ·{' '}
              <button className={styles.link} onClick={onShowDownloads}>
                查看
              </button>
            </p>
          )}
        </div>
        {(saveNote || result.notice) && (
          <div className={styles.notes}>
            {saveNote && <p>{saveNote}</p>}
            {result.notice && (
              <p>
                {result.notice}
                {result.loginHint && (
                  <>
                    {' '}
                    <button className={styles.link} onClick={onLogin}>
                      {loginLabel(result.platform)}
                    </button>
                  </>
                )}
              </p>
            )}
          </div>
        )}
      </header>

      {images.length > 0 ? (
        <ul className={styles.sheet} aria-label="图片列表">
          {images.map((img, index) => (
            <li key={img.id}>
              <button
                className={styles.tile}
                style={{ aspectRatio: img.width && img.height ? `${img.width} / ${img.height}` : undefined }}
                onClick={() => setViewing(index)}
                aria-label={`放大查看第 ${index + 1} 张`}
                title="点击放大查看"
              >
                <img src={img.preview ?? img.image.url} alt="" loading="lazy" referrerPolicy="no-referrer" />
              </button>
              <p className={styles.frameNumber}>
                {frameNumber(index)}
                {img.liveVideo && <span>实况</span>}
              </p>
            </li>
          ))}
        </ul>
      ) : (
        <VideoStage
          source={preview && previewSource(preview, result.headers)}
          cover={result.cover}
          note={preview && variant && preview.id !== variant.id ? `预览画质 ${preview.label}，下载的是所选的 ${variant.label}` : undefined}
          player={player}
          resume={resume}
          onUnplayable={() => preview && setUnplayable((ids) => [...ids, preview.id])}
        />
      )}
      <ImageViewer images={images} index={viewing} onIndexChange={setViewing} onDownload={downloadImage} />
    </section>
  )
}

interface Resume {
  time: number
  playing: boolean
}

/** 预览的来源：单个文件直接播放；音视频分流的两路流交给 MSE */
type PreviewSource = { id: string; src: string } | { id: string; tracks: DashTrack[] }

function previewSource(variant: VideoVariant, headers: Record<string, string>): PreviewSource {
  const { id, video, audio } = variant
  const src = previewUrl(video, headers)
  return audio && video.mime && audio.mime
    ? { id, tracks: [{ url: src, mime: video.mime }, { url: previewUrl(audio, headers), mime: audio.mime }] }
    : { id, src }
}

interface VideoStageProps {
  /** 没有能播放的版本时为空，显示封面 */
  source?: PreviewSource
  cover?: string
  note?: string
  player: RefObject<HTMLVideoElement | null>
  resume: RefObject<Resume | null>
  /** 当前的来源播不了，换下一个版本 */
  onUnplayable: () => void
}

function VideoStage({ source, cover, note, player, resume, onUnplayable }: VideoStageProps) {
  const caption = source ? note : '这个视频无法在应用内预览，不影响下载'

  // 来源由这里交给播放器，不写在 <video> 的 src 上：同一个播放器要在两种来源之间切换，音量等设置才能留住
  useEffect(() => {
    const el = player.current
    if (!el || !source) return
    if ('tracks' in source) return attachDash(el, source.tracks, fallBack)
    el.src = source.src
  }, [source?.id])

  // 播到一半出错时，换的版本从出错的位置接着放
  function fallBack() {
    const el = player.current
    if (el && el.currentTime > 0) resume.current ??= { time: el.currentTime, playing: !el.paused }
    onUnplayable()
  }

  function onLoadedMetadata() {
    const el = player.current
    if (!el) return
    // 解不了视频轨时 Chromium 不报错，只播声音，这时画面尺寸是 0
    if (el.videoWidth === 0) return fallBack()
    const at = resume.current
    resume.current = null
    if (!at) return
    if (at.time > 0 && at.time < el.duration) el.currentTime = at.time
    if (at.playing) void el.play().catch(() => {})
  }

  return (
    <div className={styles.stage} data-caption={caption ? '' : undefined}>
      <div className={styles.frame}>
        {source ? (
          // nodownload：隐藏浏览器自带的下载项，它保存的是预览画质，容易和上方的下载按钮混淆
          <video
            ref={player}
            className={styles.player}
            controls
            controlsList="nodownload"
            playsInline
            preload="auto"
            onLoadedMetadata={onLoadedMetadata}
            onError={fallBack}
          />
        ) : (
          cover && <img className={styles.player} src={cover} alt="视频封面" referrerPolicy="no-referrer" />
        )}
      </div>
      {caption && <p className={styles.caption}>{caption}</p>}
    </div>
  )
}

const SOURCES: Spec[] = [
  [PLATFORM_NAMES.bilibili, '视频'],
  [PLATFORM_NAMES.xiaohongshu, '图文、实况图、视频'],
  [PLATFORM_NAMES.douyin, '视频、图文、实况图'],
  [PLATFORM_NAMES.web, 'm3u8 地址，或网页里的视频流']
]

/** 还没有解析结果时的页面：和结果页同一个骨架，看片区里是一个空片格 */
export function ParseIntro({ onPaste }: { onPaste: () => void }) {
  return (
    <section className={styles.panel} aria-label="使用说明">
      <header className={styles.head}>
        <div className={styles.info}>
          <h1 className={styles.title}>粘贴分享链接，保存无水印的视频和图片</h1>
        </div>
        <div className={styles.choose}>
          <Specs items={SOURCES} />
        </div>
      </header>
      <div className={styles.stage}>
        <div className={styles.frame}>
          <div className={styles.blank}>
            <button className="btn btn-primary" onClick={onPaste}>
              粘贴剪贴板里的链接
            </button>
          </div>
        </div>
      </div>
    </section>
  )
}

export function ResultSkeleton() {
  return (
    <div className={styles.panel} role="status" aria-busy="true" aria-label="正在解析">
      <div className={styles.head}>
        <div className={styles.info}>
          <div className={`${styles.bar} ${styles.pulse}`} style={{ width: '56%', height: 20 }} />
          <div className={`${styles.bar} ${styles.pulse}`} style={{ width: '24%' }} />
        </div>
        <div className={styles.choose}>
          <div className={`${styles.bar} ${styles.pulse}`} style={{ width: '44%' }} />
        </div>
      </div>
      <div className={styles.stage}>
        <div className={styles.frame}>
          <div className={`${styles.blank} ${styles.loading} ${styles.pulse}`} />
        </div>
      </div>
    </div>
  )
}
