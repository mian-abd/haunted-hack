import { expect, test } from "bun:test"
import { embedFor } from "./embed"

test("video files play in a <video>", () => {
  expect(embedFor("https://cdn.example.com/unc-demo.mp4")).toEqual({ kind: "video", src: "https://cdn.example.com/unc-demo.mp4" })
  expect(embedFor("https://cdn.example.com/a.WEBM?x=1")?.kind).toBe("video")
})

test("YouTube and Loom links become their players", () => {
  const yt = "https://www.youtube-nocookie.com/embed/abc_123-X"
  expect(embedFor("https://www.youtube.com/watch?v=abc_123-X")?.src).toBe(yt)
  expect(embedFor("https://youtu.be/abc_123-X")?.src).toBe(yt)
  expect(embedFor("https://youtube.com/shorts/abc_123-X")?.src).toBe(yt)
  expect(embedFor("https://www.loom.com/share/0f1e2d3c")?.src).toBe("https://www.loom.com/embed/0f1e2d3c")
})

test("anything else is not embedded", () => {
  expect(embedFor(undefined)).toBeNull()
  expect(embedFor("not a url")).toBeNull()
  expect(embedFor("javascript:alert(1)//.mp4")).toBeNull()
  expect(embedFor("https://example.com/page")).toBeNull()
  expect(embedFor("https://youtube.com/watch?v=<script>")).toBeNull()
})
