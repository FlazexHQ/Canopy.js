import "@ui-sdk/core/web.css"
import "./globals.css"
import type { ReactNode } from "react"

export const metadata = { title: "Canopy Chat", description: "A shared realtime conversation." }

export default function Layout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  )
}
