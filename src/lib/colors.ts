// Banner colors for hook systemMessages, using the statusline's palette.
// NO_COLOR (https://no-color.org) disables them.
const enabled = !process.env.NO_COLOR
const wrap = (code: string) => (s: string): string => (enabled ? `\x1b[${code}m${s}\x1b[0m` : s)

// Mid-luminance tint of the brand blue (#3B35F3): terminals can't report
// their theme, so the glyph must clear both dark and light backgrounds.
export const blue = wrap('38;2;124;120;250')
export const bold = wrap('1')
export const gray = wrap('38;5;245')
export const red = wrap('31')

export const MARK = blue(bold('◪'))
export const BRAND = `${MARK} ${bold('supermemory')}`
