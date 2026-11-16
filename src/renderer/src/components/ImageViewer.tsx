import { Dialog } from '@base-ui/react/dialog'
import { useRef, useState, type KeyboardEvent, type PointerEvent } from 'react'
import type { ImageItem } from '@shared/types'
import { frameNumber } from '../lib/format'
import { ChevronLeftIcon, ChevronRightIcon, CloseIcon, DownloadIcon } from './icons'
import styles from './ImageViewer.module.css'

interface Props {
  images: ImageItem[]
  /** 当前查看第几张；null 表示关闭 */
  index: number | null
  onIndexChange: (index: number | null) => void
  onDownload: (index: number) => void
}

export function ImageViewer({ images, index, onIndexChange, onDownload }: Props) {
  const image = index === null ? undefined : images[index]
  const popup = useRef<HTMLDivElement>(null)
  const go = (delta: number) => {
    if (index === null) return
    const next = index + delta
    if (next >= 0 && next < images.length) onIndexChange(next)
  }
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'ArrowLeft') go(-1)
    if (e.key === 'ArrowRight') go(1)
  }

  return (
    <Dialog.Root open={image !== undefined} onOpenChange={(open) => !open && onIndexChange(null)}>
      <Dialog.Portal>
        <Dialog.Popup ref={popup} initialFocus={popup} tabIndex={-1} className={styles.viewer} onKeyDown={onKeyDown}>
          {image && index !== null && (
            <>
              <header className={`${styles.bar} drag`}>
                <Dialog.Title className={styles.title}>
                  {frameNumber(index)} / {frameNumber(images.length - 1)}
                  {image.width && image.height && <span>{`${image.width}×${image.height}`}</span>}
                </Dialog.Title>
                <button className={`${styles.barButton} no-drag`} onClick={() => onDownload(index)}>
                  <DownloadIcon />
                  下载这张
                </button>
                <Dialog.Close className={`${styles.iconButton} no-drag`} aria-label="关闭查看器" title="关闭（Esc）">
                  <CloseIcon />
                </Dialog.Close>
              </header>
              <Stage key={image.id} image={image} />
              {index > 0 && (
                <button className={`${styles.nav} ${styles.prev}`} onClick={() => go(-1)} aria-label="上一张" title="上一张（←）">
                  <ChevronLeftIcon />
                </button>
              )}
              {index < images.length - 1 && (
                <button className={`${styles.nav} ${styles.next}`} onClick={() => go(1)} aria-label="下一张" title="下一张（→）">
                  <ChevronRightIcon />
                </button>
              )}
            </>
          )}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

const DRAG_THRESHOLD = 4

/** 点击在「适应窗口」和「实际大小」之间切换；实际大小下可拖动平移 */
function Stage({ image }: { image: ImageItem }) {
  const [actual, setActual] = useState(false)
  const [natural, setNatural] = useState<{ width: number; height: number } | null>(null)
  const scroller = useRef<HTMLDivElement>(null)
  const drag = useRef<{ x: number; y: number; left: number; top: number; moved: boolean } | null>(null)

  function onPointerDown(e: PointerEvent<HTMLDivElement>) {
    if (e.button !== 0 || !scroller.current) return
    drag.current = { x: e.clientX, y: e.clientY, left: scroller.current.scrollLeft, top: scroller.current.scrollTop, moved: false }
    e.currentTarget.setPointerCapture(e.pointerId)
  }
  function onPointerMove(e: PointerEvent) {
    const d = drag.current
    if (!d || !scroller.current) return
    const dx = e.clientX - d.x
    const dy = e.clientY - d.y
    if (Math.abs(dx) + Math.abs(dy) > DRAG_THRESHOLD) d.moved = true
    if (actual && d.moved) scroller.current.scrollTo(d.left - dx, d.top - dy)
  }
  function onPointerUp(e: PointerEvent) {
    const d = drag.current
    drag.current = null
    if (!d || d.moved || !scroller.current || !natural) return
    if (actual) return setActual(false)
    // 放大后让点击的位置留在指针下
    const img = scroller.current.querySelector('img')!.getBoundingClientRect()
    const fx = (e.clientX - img.left) / img.width
    const fy = (e.clientY - img.top) / img.height
    const box = scroller.current.getBoundingClientRect()
    setActual(true)
    requestAnimationFrame(() =>
      scroller.current?.scrollTo(
        (fx * natural.width) / devicePixelRatio - (e.clientX - box.left),
        (fy * natural.height) / devicePixelRatio - (e.clientY - box.top)
      )
    )
  }

  return (
    <div
      ref={scroller}
      className={styles.stage}
      data-actual={actual || undefined}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={() => (drag.current = null)}
      title={actual ? '点击恢复适应窗口，拖动查看其他位置' : '点击查看实际大小'}
    >
      <img
        src={image.image.url}
        alt={`第 ${image.id} 张图片`}
        referrerPolicy="no-referrer"
        draggable={false}
        onLoad={(e) => setNatural({ width: e.currentTarget.naturalWidth, height: e.currentTarget.naturalHeight })}
        // 实际大小：一个图片像素对应一个屏幕物理像素
        style={actual && natural ? { width: natural.width / devicePixelRatio, height: natural.height / devicePixelRatio } : undefined}
      />
    </div>
  )
}
