// Live ElderActor state: server hands out a Terse WebSocket grant, the socket sends `state` then `state_update`s
// (plus our `call_due` broadcast). Reconnects with backoff and polls GET /api/state every 2 s while the socket is down.
import { useEffect, useReducer, useState } from "react"
import { ELDER, MOCK, getJSON } from "./api"
import { playMock } from "./mock"
import { EMPTY, reduce, type ActorMessage, type ElderState } from "./state"

export type Conn = "connecting" | "live" | "polling" | "offline" | "mock"

export function useActor(): [ElderState, Conn] {
  const [state, dispatch] = useReducer(reduce, EMPTY)
  const [conn, setConn] = useState<Conn>(MOCK ? "mock" : "connecting")

  useEffect(() => {
    if (MOCK) return playMock(dispatch)
    let ws: WebSocket | undefined
    let stopped = false
    let attempt = 0
    let retry: ReturnType<typeof setTimeout> | undefined
    let poll: ReturnType<typeof setInterval> | undefined

    const pollOnce = async () => {
      try {
        const state = await getJSON(`/api/state?elderId=${ELDER}`)
        if (poll) {
          dispatch({ type: "state", state })
          setConn("polling")
        }
      } catch {
        if (poll) setConn("offline")
      }
    }
    const reconnect = () => {
      if (stopped) return
      if (!poll) {
        poll = setInterval(pollOnce, 2000)
        void pollOnce()
      }
      retry = setTimeout(connect, Math.min(10_000, 1000 * 2 ** attempt++))
    }
    const connect = async () => {
      try {
        // A grant is single-use and short-lived (Terse connectByMs), so every attempt asks for a fresh one.
        const { websocketUrl } = await getJSON(`/api/actor-ws?elderId=${ELDER}`)
        if (stopped) return
        const sock = new WebSocket(websocketUrl)
        ws = sock
        sock.onmessage = ev => {
          let m: ActorMessage
          try {
            m = JSON.parse(ev.data)
          } catch {
            return // e.g. a raw "pong"
          }
          if (m.type === "state") {
            attempt = 0
            clearInterval(poll)
            poll = undefined
            setConn("live")
          }
          dispatch(m)
        }
        sock.onclose = () => {
          if (ws !== sock) return
          ws = undefined
          reconnect()
        }
      } catch {
        reconnect()
      }
    }

    void connect()
    return () => {
      stopped = true
      clearTimeout(retry)
      clearInterval(poll)
      ws?.close()
    }
  }, [])

  return [state, conn]
}
