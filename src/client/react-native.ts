import type { LifecycleSource } from "./client-types.ts"

/** The part of React Native's `AppState` the lifecycle uses. */
export interface AppStateLike {
  readonly currentState?: string | null
  addEventListener(type: "change", listener: (state: string) => void): { remove(): void }
}

/** The part of `@react-native-community/netinfo` the lifecycle uses. */
export interface NetInfoLike {
  addEventListener(
    listener: (state: {
      readonly isConnected: boolean | null
      readonly isInternetReachable?: boolean | null
    }) => void,
  ): () => void
}

/** Options of {@link reactNativeLifecycle}. */
export interface ReactNativeLifecycleOptions {
  readonly AppState: AppStateLike
  /** Reports connectivity; without it the client finds out from failed connections. */
  readonly NetInfo?: NetInfoLike
}

/**
 * Drives reconnection from React Native's app state, since React Native has no `online` or
 * `visibilitychange` events: the client reconnects as soon as the app comes back to the foreground, and
 * stops trying while NetInfo reports no connection.
 *
 * ```ts
 * import { AppState } from "react-native"
 * import NetInfo from "@react-native-community/netinfo"
 * const canopy = createClient({ url, publishableKey, lifecycle: reactNativeLifecycle({ AppState, NetInfo }) })
 * ```
 */
export function reactNativeLifecycle(options: ReactNativeLifecycleOptions): LifecycleSource {
  return (events) => {
    let previous = options.AppState.currentState ?? "active"
    const app = options.AppState.addEventListener("change", (state) => {
      if (state === "active" && previous !== "active") {
        events.online()
        events.wake()
      }
      previous = state
    })
    let connected: boolean | undefined
    const stopNet = options.NetInfo?.addEventListener((state) => {
      const now = state.isConnected !== false && state.isInternetReachable !== false
      if (now === connected) return
      connected = now
      if (now) events.online()
      else events.offline()
    })
    return () => {
      app.remove()
      stopNet?.()
    }
  }
}
