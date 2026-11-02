<script lang="ts">
  import { flushSync, onDestroy, onMount, tick, untrack } from 'svelte'
  import { uid } from '../lib/format'
  import fixWebmDuration from 'fix-webm-duration'
  import { fitView, panzoom, widgetsBox, type View } from '../lib/panzoom'
  import { app } from '../lib/store.svelte'
  import { parseBlocks, ROW, TEXT_SIZE } from '../lib/textBlocks'
  import type { CardSide, CropBox, MediaWidget, Rect, WidgetKind } from '../lib/types'
  import Icon from './Icon.svelte'
  import Widget from './Widget.svelte'

  type Props = {
    side: CardSide
    label: string
    which: 'front' | 'back'
    /** only the visible side is editable; the other one is turned away (flip effect) */
    active: boolean
    /** the sheet of a card made before text widgets (its text keeps that width); kept for the layout */
    rect: Rect
    /** pan + zoom of the board (the frame itself never changes size) */
    view: View
    recording: boolean
    seconds: number
    onchange: (s: CardSide) => void
    onlayout: () => void
    /** what review shows of this side: the frame around all widgets, kept up to date while editing */
    crop?: CropBox | null
    /** size and font of the selected text widget, or null when no text widget is selected */
    onselection?: (sel: { size: number; font: string } | null) => void
    /** whether this side has a step to take back / do again (its own history, the editor's buttons) */
    onhistory?: (h: { undo: boolean; redo: boolean }) => void
    /** a photo just taken: the editor lets it be cropped before it goes on the card */
    onphoto?: (blob: Blob) => void
    /** a fixed card: one page of this size, shown whole and standing still; everything stays on it (null: endless) */
    fixed?: { w: number; h: number } | null
    /** ruled lines on the page */
    lines?: boolean
  }
  let {
    side,
    label,
    which,
    active,
    rect = $bindable(),
    view = $bindable(),
    recording = $bindable(),
    seconds = $bindable(),
    onchange,
    onlayout,
    crop = $bindable(null),
    onselection,
    onhistory,
    onphoto,
    fixed = null,
    lines = true,
  }: Props = $props()

  const MIN_TEXT = 6
  const MAX_TEXT = 120

  let layer: HTMLDivElement // only used to measure the text of older cards while it is turned into widgets
  let wrap: HTMLDivElement // the world: widgets, moved and scaled by `view`
  let frame: HTMLDivElement
  let frameW = $state(0)
  let frameH = $state(0)
  let fitted = false
  let imgInput: HTMLInputElement
  let audioInput: HTMLInputElement
  let photoInput: HTMLInputElement

  let widgets = $state<MediaWidget[]>(untrack(() => side.widgets.map((w) => ({ ...w }))))
  let selectedId = $state<string | null>(null)
  /** the text widget being written in (keyboard up) */
  let editingId = $state<string | null>(null)
  /** the frame drawn around everything: what review will show of this side; follows every move and resize live */
  const outline = $derived(cropBox())
  /** direction of the next new text widget */
  let nextDir: 'rtl' | 'ltr' = 'rtl'
  let stopPan: (() => void) | undefined
  const refs: Record<string, Widget> = {}

  const selectedText = $derived(widgets.find((w) => w.id === selectedId && w.kind === 'text'))

  onMount(() => {
    adoptOldText()
    document.addEventListener('keydown', onDocKey)
    // a fixed card does not move: the page is always shown whole (see fit)
    if (untrack(() => fixed)) return
    stopPan = panzoom(frame, {
      get: () => view,
      set: (v) => (view = v),
      // the empty page, and in pan mode the widgets too
      canPan: (e) => !(e.target as Element).closest('.widget'),
    })
  })
  onDestroy(() => {
    stopPan?.()
    cancelAnimationFrame(measureFrame)
    document.removeEventListener('keydown', onDocKey)
    stopStreams()
  })

  function emit(typing?: string) {
    record(typing)
    // the text lives in the widgets; the old html text has been turned into widgets too
    onchange({ html: '', widgets: $state.snapshot(widgets) as MediaWidget[] })
    measureSoon()
  }

  // ---------- this side's own history: one step back / forward (the buttons beside "turn the card") ----------

  const snap = () => $state.snapshot(widgets) as MediaWidget[]
  let shown: MediaWidget[] = untrack(snap)
  const past: MediaWidget[][] = []
  let future: MediaWidget[][] = []
  /** typing in one text widget is one step, until a pause or another change */
  let lastTyping = { id: '', at: 0 }

  /** right after an undo / redo: the widgets settle (a text box fits its text again), which is no step of its own */
  let settling = 0
  function record(typing?: string) {
    const now = snap()
    if (JSON.stringify(now) === JSON.stringify(shown)) return
    if (settling) return void (shown = now)
    const t = performance.now()
    const same = !!typing && typing === lastTyping.id && t - lastTyping.at < 1500
    lastTyping = { id: typing ?? '', at: t }
    if (!same) {
      past.push(shown)
      if (past.length > 100) past.shift()
    }
    future = []
    shown = now
    tellHistory()
  }
  function tellHistory() {
    onhistory?.({ undo: past.length > 0, redo: future.length > 0 })
  }

  function restore(to: MediaWidget[]) {
    editingId = null
    selectedId = null
    ;(document.activeElement as HTMLElement | null)?.blur?.()
    widgets = to.map((w) => ({ ...w }))
    shown = to
    lastTyping = { id: '', at: 0 }
    tellHistory()
    onchange({ html: '', widgets: snap() })
    measureSoon()
    settling++
    void tick().then(() => requestAnimationFrame(() => settling--))
  }
  export function undo() {
    if (editingId) stopWriting()
    const to = past.pop()
    if (!to) return
    future.push(snap())
    restore(to)
  }
  export function redo() {
    const to = future.pop()
    if (!to) return
    past.push(snap())
    restore(to)
  }
  /** a picture or sound got its stored name: every step that holds it refers to that name too */
  function renameMedia(temp: string, stored: string) {
    for (const list of [...past, ...future, shown]) for (const w of list) if (w.mediaId === temp) w.mediaId = stored
  }

  /**
   * Text written before text widgets existed (ruled-line blocks, or one ruled sheet) becomes text widgets at the same
   * place, measured once on the page. It is saved with the next change.
   */
  function adoptOldText() {
    const blocks = parseBlocks(untrack(() => side.html), untrack(() => rect.w))
    if (!blocks.length) return
    for (const b of blocks) {
      const tb = document.createElement('div')
      tb.className = b.w ? 'tb fixed' : 'tb'
      tb.style.left = `${b.x}px`
      tb.style.top = `${b.y}px`
      if (b.w) tb.style.width = `${b.w}px`
      const t = document.createElement('div')
      t.className = 'tb-text'
      t.dir = b.dir
      t.innerHTML = b.html
      tb.append(t)
      layer.append(tb)
      // a sheet keeps its side margins; a free block is as wide as its text, plus the widget's own padding and some
      // room so nothing wraps anew; a right-to-left block keeps its right edge where it was
      const pad = 16
      const left = tb.offsetLeft + t.offsetLeft
      const x = b.w ? b.x + 14 - 4 : b.dir === 'rtl' ? left - pad : left - 4
      const w = b.w ? b.w - 20 : t.offsetWidth + pad + 4
      const dir = b.w ? ((t.firstElementChild as HTMLElement | null)?.dir === 'ltr' ? 'ltr' : 'rtl') : b.dir
      widgets.push({ id: uid(), kind: 'text', mediaId: '', x, y: b.y, w, h: t.offsetHeight, rot: 0, html: b.html, size: 14, dir, lh: ROW })
    }
    layer.innerHTML = ''
  }

  // ---------- selection and writing ----------

  function select(id: string) {
    if (editingId && editingId !== id) stopWriting()
    selectedId = id
  }

  /** a text widget left without text goes away when the writing ends */
  function stopWriting() {
    const w = widgets.find((x) => x.id === editingId)
    editingId = null
    if (w && !textOf(w.html)) removeWidget(w.id)
  }

  const textOf = (html = '') => {
    const d = document.createElement('div')
    d.innerHTML = html
    return d.textContent?.trim() ?? ''
  }

  export function deselect() {
    stopWriting()
    selectedId = null
  }

  /** a tap on the page itself (not a drag of the board) lets go of every widget */
  function onFrameClick(e: MouseEvent) {
    if (e.defaultPrevented || (e.target as Element).closest('.widget')) return
    deselect()
  }

  // the turned-away side lets go of its widgets
  $effect(() => {
    if (!active) untrack(deselect)
  })

  $effect(() => {
    const sel = selectedText ? { size: selectedText.size ?? TEXT_SIZE, font: selectedText.font ?? '' } : null
    if (active) onselection?.(sel)
  })

  /** A new text widget in the middle of what is visible, ready to write in (the keyboard comes up). */
  export function addText() {
    if (!frameW) return
    deselect()
    // just wide enough to tap into; it grows while writing and fits the text when the writing ends
    const w = Math.round(Math.min(110, frameW * 0.5) / view.z)
    const size = Math.max(MIN_TEXT, Math.round(TEXT_SIZE / Math.max(1, view.z)))
    const id = uid()
    const x = Math.round((frameW / 2 - view.x) / view.z - w / 2)
    const y = Math.round((frameH / 2 - view.y) / view.z - size * 0.8)
    flushSync(() => {
      widgets.push({ id, kind: 'text', mediaId: '', x, y, w, h: size * 2, rot: 0, html: '', size, dir: nextDir })
      selectedId = id
    })
    refs[id]?.startWriting() // still inside the tap, so the phone shows its keyboard
  }

  /** Text size of the selected text widget, one step at a time. Nothing gets the focus, so no keyboard comes up. */
  export function stepTextSize(delta: number) {
    const w = selectedText
    if (!w) return
    const size = Math.min(MAX_TEXT, Math.max(MIN_TEXT, (w.size ?? TEXT_SIZE) + delta))
    if (size === w.size) return
    w.size = size
    emit()
  }

  /** Font of the selected text widget ('' = the app's font). */
  export function setFont(font: string) {
    const w = selectedText
    if (!w || (w.font ?? '') === font) return
    if (font) w.font = font
    else delete w.font
    emit()
  }

  /** Writing direction of the selected text widget (or of the next new one). */
  export function toggleDirection() {
    const w = selectedText
    if (!w) {
      nextDir = nextDir === 'ltr' ? 'rtl' : 'ltr'
      app.toast(nextDir === 'ltr' ? 'متن بعدی: از چپ به راست' : 'متن بعدی: از راست به چپ')
      return
    }
    w.dir = w.dir === 'ltr' ? 'rtl' : 'ltr'
    nextDir = w.dir
    emit()
  }

  // ---------- the frame: fixed size, the board inside is panned and zoomed ----------

  /** shows every widget on this side from the top; used when the card opens */
  export function fit() {
    if (!frameW) return
    if (fixed) {
      // the whole page in the middle, below the buttons at the top of the card
      const v = fitView({ l: 0, t: 0, r: fixed.w, b: fixed.h }, frameW, frameH - 52, { both: true, maxZ: 1.6, pad: 14 })
      view = { ...v, y: v.y + 44 }
      return
    }
    const box = widgetsBox(widgets)
    // the margin leaves room for the review frame (20px around everything) and its label above it
    view = box ? fitView({ ...box, t: box.t - 40 }, frameW, frameH, { maxZ: 1, pad: 24 }) : { z: 1, x: 0, y: 0 }
  }

  // a fixed page follows the frame's size (phone turned, keyboard up) and stays whole
  $effect(() => {
    void frameW
    void frameH
    if (fixed && frameW > 0 && frameH > 0) untrack(fit)
  })

  $effect(() => {
    if (!fitted && frameW > 0 && frameH > 0) {
      fitted = true
      untrack(fit)
      untrack(measureSoon)
    }
  })

  /** The part of this side review shows: around every widget (text included), with a safe margin. */
  export function cropBox(margin = 20): CropBox | null {
    if (fixed) return { l: 0, t: 0, r: fixed.w, b: fixed.h } // review shows the whole page
    const b = widgetsBox(widgets)
    if (!b) return null
    return { l: Math.floor(b.l - margin), t: Math.floor(b.t - margin), r: Math.ceil(b.r + margin), b: Math.ceil(b.b + margin) }
  }

  /** after a change: keep the frame around everything as this side's cut-out for review */
  let measureFrame = 0
  function measureSoon() {
    cancelAnimationFrame(measureFrame)
    measureFrame = requestAnimationFrame(() => {
      const box = cropBox()
      const same = (a: CropBox | null, b: CropBox | null) => a === b || (!!a && !!b && a.l === b.l && a.t === b.t && a.r === b.r && a.b === b.b)
      if (same(box, crop)) return
      crop = box
      onlayout()
    })
  }

  // a text widget grows while it is written in: keep the frame around it
  $effect(() => {
    for (const w of widgets) void w.h
    untrack(measureSoon)
  })

  /**
   * The browser scrolls even an overflow:hidden box to bring the caret into view, which would shift the page away from
   * the taps. Any such scroll is turned into a pan of the board.
   */
  function onFrameScroll() {
    const { scrollLeft: sl, scrollTop: st } = frame
    if (!sl && !st) return
    frame.scrollLeft = 0
    frame.scrollTop = 0
    if (fixed) return // the page stays where it is
    view = { ...view, x: view.x - sl, y: view.y - st }
  }

  // ---------- widgets ----------

  function onDocKey(e: KeyboardEvent) {
    if (!active || !selectedId || editingId || (e.key !== 'Delete' && e.key !== 'Backspace')) return
    if ((document.activeElement as HTMLElement)?.isContentEditable || document.activeElement?.tagName === 'INPUT') return
    e.preventDefault()
    removeWidget(selectedId)
  }

  function addWidget(kind: WidgetKind, mediaId: string, w: number, h: number) {
    deselect()
    if (fixed) {
      // never bigger than the page
      const f = Math.min(1, (fixed.w - 16) / w, (fixed.h - 16) / h)
      w = Math.round(w * f)
      h = Math.round(h * f)
    }
    // in the middle of what is visible right now
    const n = widgets.length % 5
    let x = Math.round((frameW / 2 - view.x) / view.z - w / 2) + n * 16
    let y = Math.round((frameH / 2 - view.y) / view.z - h / 2) + n * 16
    if (fixed) {
      x = Math.min(fixed.w - w, Math.max(0, x))
      y = Math.min(fixed.h - h, Math.max(0, y))
    }
    const id = uid()
    widgets.push({ id, kind, mediaId, x, y, w, h, rot: 0 })
    selectedId = id
    emit()
    return id
  }

  function removeWidget(id: string) {
    widgets = widgets.filter((w) => w.id !== id)
    delete refs[id]
    if (selectedId === id) selectedId = null
    if (editingId === id) editingId = null
    emit()
  }

  // Pictures and sounds show up at once, from memory; making them smaller and storing them happens in the background.
  let alive = true
  const uploads = new Set<Promise<void>>()
  onDestroy(() => (alive = false))

  /** resolves once every picture / sound added here is stored (Done waits for it) */
  export async function settled() {
    await Promise.all([...uploads])
  }

  function placeMedia(kind: 'image' | 'audio', blob: Blob, w: number, h: number, prepare?: () => Promise<Blob>) {
    const url = URL.createObjectURL(blob)
    const temp = `local-${uid()}`
    app.showLocal(temp, url)
    const id = addWidget(kind, temp, w, h)
    const job = (async () => {
      try {
        const stored = await app.addMedia(prepare ? await prepare() : blob)
        app.showLocal(stored, url) // the same picture stays on screen, no reload
        renameMedia(temp, stored)
        const wd = widgets.find((x) => x.id === id)
        if (wd && alive) {
          wd.mediaId = stored
          shown = snap() // only the name changed: no step of its own
          onchange({ html: '', widgets: snap() })
        }
      } catch {
        if (alive) {
          app.toast('ذخیره‌ی فایل انجام نشد')
          removeWidget(id)
        }
      }
    })()
    uploads.add(job)
    void job.finally(() => uploads.delete(job))
  }

  /** a picture's size from its header (no full decoding) */
  function imageSize(blob: Blob): Promise<{ w: number; h: number }> {
    return new Promise((resolve, reject) => {
      const img = new Image()
      const url = URL.createObjectURL(blob)
      img.onload = () => {
        URL.revokeObjectURL(url)
        resolve({ w: img.naturalWidth, h: img.naturalHeight })
      }
      img.onerror = () => {
        URL.revokeObjectURL(url)
        reject(new Error('not an image'))
      }
      img.src = url
    })
  }

  /**
   * Big photos are scaled down to 1600 px (sharper than a phone screen shows a card) and stored as WebP, which keeps the
   * same look as JPEG at about two thirds of the size. The browser scales while decoding, which is much faster.
   */
  async function shrink(blob: Blob, w0: number, h0: number): Promise<Blob> {
    const k = Math.min(1, 1600 / Math.max(w0, h0))
    if (k === 1 && blob.size < 300_000) return blob // small already: never made worse
    const w = Math.max(1, Math.round(w0 * k))
    const h = Math.max(1, Math.round(h0 * k))
    const bmp = await createImageBitmap(blob, { resizeWidth: w, resizeHeight: h, resizeQuality: 'high' })
    const c = document.createElement('canvas')
    c.width = w
    c.height = h
    c.getContext('2d')!.drawImage(bmp, 0, 0)
    bmp.close()
    const webp = await new Promise<Blob | null>((r) => c.toBlob(r, 'image/webp', 0.88))
    // (a browser without WebP gives PNG back: JPEG then)
    const out = webp?.type === 'image/webp' ? webp : await new Promise<Blob | null>((r) => c.toBlob(r, 'image/jpeg', 0.86))
    if (!out) return blob
    return k === 1 && out.size >= blob.size ? blob : out
  }

  async function addImage(blob: Blob) {
    try {
      const { w: nw, h: nh } = await imageSize(blob)
      const w = Math.min(200, nw)
      const h = Math.max(30, Math.round((w * nh) / nw))
      placeMedia('image', blob, w, h, () => shrink(blob, nw, nh))
    } catch {
      app.toast('این تصویر قابل استفاده نیست')
    }
  }

  function addAudio(blob: Blob, prepare?: () => Promise<Blob>) {
    placeMedia('audio', blob, 240, 66, prepare)
  }

  async function onPick(e: Event, kind: 'image' | 'audio') {
    const input = e.target as HTMLInputElement
    const files = Array.from(input.files ?? [])
    input.value = ''
    if (kind === 'audio') return files[0] && addAudio(files[0])
    for (const f of files) await addImage(f) // several pictures at once: each a little apart from the one before
  }

  /** a photo from the camera (system camera app on phones) goes through the crop screen first */
  function onPhoto(e: Event) {
    const input = e.target as HTMLInputElement
    const file = input.files?.[0]
    input.value = ''
    if (file) (onphoto ? onphoto(file) : addImage(file))
  }

  /** the picture after the crop screen: on the card now */
  export const placeImage = (blob: Blob) => addImage(blob)

  export const pickImage = () => imgInput.click()
  export const pickAudio = () => audioInput.click()

  // ---------- microphone ----------

  let recorder: MediaRecorder | null = null
  let micStream: MediaStream | null = null
  let timer: ReturnType<typeof setInterval> | undefined

  /**
   * A recording as it is stored: the phone's own compressed voice (Opus in WebM, about 0.7 MB a minute; an uncompressed
   * WAV would be 5.8 MB). MediaRecorder leaves the length out of a WebM file, so players would show a wrong duration and
   * could not jump: the length is written into the file.
   */
  async function finalizeRecording(blob: Blob, ms: number): Promise<Blob> {
    if (!blob.type.includes('webm')) return blob // (ogg / mp4 carry their length themselves)
    try {
      return await fixWebmDuration(blob, ms, { logger: false })
    } catch {
      return blob
    }
  }

  /** resolves once a stopped recording is on the card (its storing then runs like any other sound) */
  let stopped: (() => void) | null = null
  let keepRecording = true
  export async function toggleRecord() {
    if (recording) {
      await stopRecording()
      return
    }
    try {
      // raw voice: the phone's echo cancelling / noise suppression make speech sound thin and muffled
      micStream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, sampleRate: 48000, echoCancellation: false, noiseSuppression: false, autoGainControl: true },
      })
      const chunks: Blob[] = []
      const mime = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/mp4'].find((m) => MediaRecorder.isTypeSupported(m))
      // 96 kb/s Opus: a voice sounds as recorded, at a fraction of the size
      const mr = new MediaRecorder(micStream, { ...(mime ? { mimeType: mime } : {}), audioBitsPerSecond: 96_000 })
      let began = 0
      mr.ondataavailable = (e) => e.data.size && chunks.push(e.data)
      mr.onstop = async () => {
        clearInterval(timer)
        recording = false
        const type = mr.mimeType || 'audio/webm'
        stopStreams()
        if (chunks.length && keepRecording) {
          const raw = new Blob(chunks, { type })
          const ms = performance.now() - began
          addAudio(raw, () => finalizeRecording(raw, ms)) // heard at once; stored with its length written in
        }
        stopped?.()
        stopped = null
      }
      keepRecording = true
      mr.start(250)
      began = performance.now()
      recorder = mr
      seconds = 0
      timer = setInterval(() => seconds++, 1000)
      recording = true
    } catch {
      app.toast('دسترسی به میکروفون ممکن نشد')
    }
  }

  /** Stops a recording and keeps it (Done, turning the card): resolves once the sound is on the card. */
  export function stopRecording(keep = true): Promise<void> {
    if (!recording || !recorder || recorder.state === 'inactive') return Promise.resolve()
    keepRecording = keep // Cancel: the recording is thrown away
    const done = new Promise<void>((r) => (stopped = r))
    recorder.stop()
    return done
  }

  // ---------- camera ----------

  let video: HTMLVideoElement | undefined = $state()
  let camStream: MediaStream | null = null
  let cameraOpen = $state(false)

  export async function openCamera() {
    if (!navigator.mediaDevices?.getUserMedia) {
      photoInput.click() // phones: the system camera app
      return
    }
    try {
      camStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } })
      cameraOpen = true
      queueMicrotask(() => {
        if (video) video.srcObject = camStream
      })
    } catch {
      photoInput.click()
    }
  }

  function capture() {
    if (!video || !camStream) return
    const c = document.createElement('canvas')
    c.width = video.videoWidth || 640
    c.height = video.videoHeight || 480
    c.getContext('2d')!.drawImage(video, 0, 0, c.width, c.height)
    c.toBlob(async (b) => {
      closeCamera()
      if (b) (onphoto ? onphoto(b) : await addImage(b))
    }, 'image/jpeg', 0.92)
  }

  function closeCamera() {
    camStream?.getTracks().forEach((t) => t.stop())
    camStream = null
    cameraOpen = false
  }

  function stopStreams() {
    micStream?.getTracks().forEach((t) => t.stop())
    micStream = null
    clearInterval(timer)
    closeCamera()
  }
</script>

<!-- The two sides are turned like a card: the leaving side swings edge-on, then the other one swings in. -->
<div
  class="note-card"
  class:active
  style:transform="perspective(1600px) rotateY({active ? 0 : which === 'front' ? -90 : 90}deg)"
  style:transition-delay={active ? '0.32s, 0s' : '0s, 0.32s'}
  style:visibility={active ? 'visible' : 'hidden'}
  aria-hidden={!active}
  aria-label={label}
>
  <!-- the frame never changes size; the board (widgets) inside is panned and zoomed over the endless ruled page -->
  <!-- (a fixed card: one page of its own size, standing still in the middle of the frame) -->
  <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
  <div
    class="frame"
    class:fixed={!!fixed}
    role="presentation"
    onclick={onFrameClick}
    onscroll={onFrameScroll}
    bind:this={frame}
    bind:clientWidth={frameW}
    bind:clientHeight={frameH}
  >
    <!-- the ruled lines are a layer of their own: a widget moving over them never leaves stray lines behind -->
    {#if lines && !fixed}
      <div class="rules" style:background-size="100% {ROW * view.z}px" style:background-position-y="{view.y}px"></div>
    {/if}
    <div class="world" bind:this={wrap} style:transform="translate({view.x}px, {view.y}px) scale({view.z})">
      {#if fixed}
        <!-- the card's page: everything stays on it, and review shows exactly this -->
        <div class="page" class:lined={lines} style:width="{fixed.w}px" style:height="{fixed.h}px" style:background-size="100% {ROW}px"></div>
      {:else if outline}
        <!-- what review will show: every widget, with a margin; the rest is cut off -->
        <div
          class="outline"
          style:left="{outline.l}px"
          style:top="{outline.t}px"
          style:width="{outline.r - outline.l}px"
          style:height="{outline.b - outline.t}px"
          style:border-width="{1.5 / view.z}px"
          style:border-radius="{12 / view.z}px"
        >
          <span style:transform="scale({1 / view.z}) translateY(-100%)">کادر مرور</span>
        </div>
      {/if}
      <div class="layer" bind:this={layer}></div>
      {#each widgets as w, i (w.id)}
        <Widget
          bind:this={refs[w.id]}
          bind:widget={widgets[i]}
          selected={selectedId === w.id}
          editing={editingId === w.id}
          scale={() => view.z}
          onselect={() => select(w.id)}
          onedit={() => (editingId = w.id)}
          onchange={(typing) => emit(typing)}
          onremove={() => removeWidget(w.id)}
          bounds={fixed}
        />
      {/each}
    </div>
    {#if !widgets.length}
      <p class="hint">برای نوشتن، دکمه‌ی «متن» را بزن</p>
    {/if}
  </div>

  <input bind:this={imgInput} type="file" accept="image/*" multiple hidden onchange={(e) => onPick(e, 'image')} />
  <input bind:this={audioInput} type="file" accept="audio/*" hidden onchange={(e) => onPick(e, 'audio')} />
  <input bind:this={photoInput} type="file" accept="image/*" capture="environment" hidden onchange={onPhoto} />
</div>

{#if cameraOpen}
  <div class="camera-overlay">
    <div class="camera-box">
      <!-- svelte-ignore a11y_media_has_caption -->
      <video bind:this={video} autoplay playsinline muted></video>
      <div class="camera-actions">
        <button class="btn btn-primary" onclick={capture}><Icon name="camera" size={17} />عکس بگیر</button>
        <button class="btn btn-soft" onclick={closeCamera}>انصراف</button>
      </div>
    </div>
  </div>
{/if}

<style>
  .note-card {
    direction: rtl;
    position: absolute;
    inset: 0;
    background: var(--paper);
    border: 1px solid var(--line-2);
    border-radius: 18px;
    overflow: hidden;
    box-shadow: var(--shadow-md);
    transition:
      transform 0.32s ease-in,
      visibility 0s linear;
  }
  .note-card.active {
    transition:
      transform 0.32s ease-out,
      visibility 0s linear;
  }
  .note-card.active:focus-within {
    border-color: color-mix(in srgb, var(--primary) 60%, transparent);
    box-shadow:
      0 0 0 3px var(--primary-soft),
      var(--shadow-md);
  }

  /* the fixed frame: dots show it can be moved; the world inside is positioned by `view` */
  .frame {
    position: absolute;
    inset: 0;
    overflow: hidden;
    touch-action: none;
    cursor: grab;
    background-color: var(--paper);
  }
  /* a fixed card: the page stands on the desk; no hand cursor, nothing to drag */
  .frame.fixed {
    cursor: default;
    background-color: var(--surface-2);
    background-image: radial-gradient(var(--line-2) 1px, transparent 1px);
    background-size: 22px 22px;
  }
  .page {
    position: absolute;
    left: 0;
    top: 0;
    background-color: var(--paper);
    border: 1px solid var(--line-2);
    border-radius: 12px;
    box-shadow: var(--shadow-md);
  }
  .page.lined {
    background-image: linear-gradient(to bottom, transparent calc(100% - 1px), var(--rule) calc(100% - 1px));
  }
  .rules {
    position: absolute;
    inset: 0;
    pointer-events: none;
    background-image: linear-gradient(to bottom, transparent calc(100% - 1px), var(--rule) calc(100% - 1px));
    will-change: transform;
    transform: translateZ(0);
  }
  .world {
    position: absolute;
    left: 0;
    top: 0;
    width: 0;
    height: 0;
    transform-origin: 0 0;
    direction: rtl;
  }
  .layer {
    position: absolute;
    left: 0;
    top: 0;
  }
  .outline {
    position: absolute;
    border: 1.5px dashed color-mix(in srgb, var(--primary) 55%, transparent);
    pointer-events: none;
  }
  .outline span {
    position: absolute;
    top: 0;
    left: 0;
    transform-origin: 0 0;
    padding: 0 6px 2px;
    font-size: 10px;
    font-weight: 700;
    white-space: nowrap;
    color: color-mix(in srgb, var(--primary-text) 80%, transparent);
  }
  .hint {
    position: absolute;
    inset: auto 0 18px;
    text-align: center;
    font-size: 12.5px;
    color: var(--muted);
    pointer-events: none;
  }

  .camera-overlay {
    position: fixed;
    inset: 0;
    background: rgba(5, 7, 14, 0.9);
    display: grid;
    place-items: center;
    z-index: 400;
    padding: 20px;
    backdrop-filter: blur(8px);
  }
  .camera-box {
    background: var(--surface);
    border: 1px solid var(--line-2);
    border-radius: 22px;
    padding: 16px;
    width: min(560px, 100%);
    box-shadow: var(--shadow-lg);
    display: flex;
    flex-direction: column;
    gap: 14px;
  }
  video {
    width: 100%;
    border-radius: 14px;
    background: #000;
    max-height: 60vh;
    object-fit: cover;
  }
  .camera-actions {
    display: flex;
    gap: 10px;
  }
  .camera-actions .btn {
    flex: 1;
  }
</style>
