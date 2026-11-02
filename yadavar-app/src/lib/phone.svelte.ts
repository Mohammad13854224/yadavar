// true while the window is phone-sized (same breakpoint as the bottom navigation in app.css)
const mq = matchMedia('(max-width: 860px)')
export const phone = $state({ on: mq.matches })
mq.addEventListener('change', (e) => (phone.on = e.matches))
