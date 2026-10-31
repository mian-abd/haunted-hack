export type Embed = { kind: "video" | "iframe"; src: string }

/** VITE_DEMO_VIDEO_URL as something the page can play: an mp4/webm file, or a YouTube or Loom player. Anything else: null. */
export function embedFor(raw: string | undefined): Embed | null {
  if (!raw) return null
  let u: URL
  try { u = new URL(raw) } catch { return null }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null
  if (/\.(mp4|webm)$/i.test(u.pathname)) return { kind: "video", src: u.href }
  const host = u.hostname.replace(/^www\./, "")
  const yt = host === "youtu.be" ? u.pathname.slice(1)
    : host === "youtube.com" || host === "m.youtube.com" ? u.searchParams.get("v") ?? u.pathname.match(/^\/(?:embed|shorts|live)\/([\w-]+)/)?.[1]
    : null
  if (yt && /^[\w-]+$/.test(yt)) return { kind: "iframe", src: `https://www.youtube-nocookie.com/embed/${yt}` }
  const loom = host === "loom.com" ? u.pathname.match(/^\/(?:share|embed)\/([\w-]+)/)?.[1] : null
  if (loom) return { kind: "iframe", src: `https://www.loom.com/embed/${loom}` }
  return null
}
