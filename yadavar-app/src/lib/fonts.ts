// Fonts a text widget can use. All of them ship inside the app (no internet needed); a font file is only read once
// some text uses it. The B fonts are the user's own copies (see src/assets/fonts), the others come from Fontsource.
import '../assets/fonts/fonts.css'
import '@fontsource/noto-nastaliq-urdu/400.css'
import '@fontsource/gulzar/400.css'
import '@fontsource/aref-ruqaa/400.css'
import '@fontsource/lalezar/400.css'
import '@fontsource/amiri/400.css'
import '@fontsource/mirza/400.css'
import '@fontsource/katibeh/400.css'
import '@fontsource-variable/reem-kufi'
import '@fontsource/great-vibes/400.css'
import '@fontsource-variable/dancing-script'
import '@fontsource/pacifico/400.css'
import '@fontsource/parisienne/400.css'
import '@fontsource/allura/400.css'
import '@fontsource/sacramento/400.css'
import '@fontsource/alex-brush/400.css'
import '@fontsource/pinyon-script/400.css'
import '@fontsource/kaushan-script/400.css'
import '@fontsource/satisfy/400.css'

export type FontGroup = 'fa' | 'fa-art' | 'en-art'
/** `id` is stored on the widget and is the CSS font family; '' = the app's own font (Vazirmatn) */
export interface FontInfo {
  id: string
  name: string
  group: FontGroup
  /** line height (× size) where the font's letters reach higher / lower than the usual 1.6 */
  lh?: number
  /** room kept on each side (× size) for letters that swing past their own width */
  pad?: number
}

export const DEFAULT_FONT = ''

export const FONTS: FontInfo[] = [
  { id: '', name: 'وزیر (پیش‌فرض)', group: 'fa' },
  { id: 'B Nazanin', name: 'B Nazanin (نازنین)', group: 'fa' },
  { id: 'B Titr', name: 'B Titr (تیتر)', group: 'fa' },
  { id: 'B Zar', name: 'B Zar (زر)', group: 'fa' },
  { id: 'Amiri', name: 'Amiri (امیری، نسخ)', group: 'fa' },
  { id: 'Lalezar', name: 'Lalezar (لاله‌زار)', group: 'fa' },
  { id: 'Noto Nastaliq Urdu', name: 'نستعلیق نوتو', group: 'fa-art', lh: 2.6 },
  { id: 'Gulzar', name: 'نستعلیق گلزار', group: 'fa-art', lh: 2.8 },
  { id: 'Aref Ruqaa', name: 'رقعه (عارف)', group: 'fa-art' },
  { id: 'Mirza', name: 'میرزا', group: 'fa-art' },
  { id: 'Reem Kufi Variable', name: 'کوفی (ریم)', group: 'fa-art' },
  { id: 'Katibeh', name: 'کتیبه', group: 'fa-art' },
  { id: 'Great Vibes', name: 'Great Vibes', group: 'en-art', pad: 0.18 },
  { id: 'Dancing Script Variable', name: 'Dancing Script', group: 'en-art', pad: 0.15 },
  { id: 'Pacifico', name: 'Pacifico', group: 'en-art', pad: 0.1 },
  { id: 'Parisienne', name: 'Parisienne', group: 'en-art', pad: 0.17 },
  { id: 'Allura', name: 'Allura', group: 'en-art', pad: 0.25 },
  { id: 'Sacramento', name: 'Sacramento', group: 'en-art', pad: 0.1 },
  { id: 'Alex Brush', name: 'Alex Brush', group: 'en-art', pad: 0.1 },
  { id: 'Pinyon Script', name: 'Pinyon Script', group: 'en-art', pad: 0.36 },
  { id: 'Kaushan Script', name: 'Kaushan Script', group: 'en-art', pad: 0.32 },
  { id: 'Satisfy', name: 'Satisfy', group: 'en-art' },
]

export const GROUP_NAMES: Record<FontGroup, string> = {
  fa: 'فارسی',
  'fa-art': 'خوشنویسی فارسی',
  'en-art': 'خوشنویسی انگلیسی',
}

export const fontInfo = (id: string | undefined) => FONTS.find((f) => f.id === (id ?? '')) ?? FONTS[0]

/** Line height and side padding a font needs so its letters stay inside the text box (sizes are in em). */
export const fontBox = (id: string | undefined) => {
  const f = fontInfo(id)
  // above the first line and below the last one, the room the line height adds is mostly taken off again: the box
  // hugs its text with a small, even gap (fonts whose letters reach far up or down keep all of theirs)
  return { lh: f.lh ?? 1.6, pad: f.pad ? `${f.pad}em` : undefined, trim: f.lh ? undefined : '-0.175em' }
}

/** The CSS font-family of a text widget (undefined = the app's font). */
export const fontCss = (id: string | undefined) => (id ? `'${id}', 'Vazirmatn Variable', sans-serif` : undefined)
