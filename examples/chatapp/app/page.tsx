"use client"

import { createClient, type Doc } from "canopy.js"
import { createAuth } from "canopy.js/auth"
import { indexedDbPersister } from "canopy.js/persist"
import { Button } from "@ui-sdk/react/button"
import { Input } from "@ui-sdk/react/input"
import {
  PasswordInput,
  PasswordInputControl,
  PasswordInputToggle,
} from "@ui-sdk/react/password-input"
import { type FormEvent, useEffect, useRef, useState } from "react"
import { schema } from "./schema"

function connect() {
  const url = "http://localhost:8080"
  const auth = createAuth({ url, storage: indexedDbPersister({ name: "canopy-chat" }) })
  return { auth, client: createClient({ url, auth, publishableKey: "pk_chat_local", schema }) }
}

type Connection = ReturnType<typeof connect>
const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error))

export default function ChatPage() {
  const [connection, setConnection] = useState<Connection>()
  const [user, setUser] = useState<Connection["auth"]["user"]>()
  const [register, setRegister] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  useEffect(() => {
    const next = connect()
    let active = true
    const update = () => setUser(next.auth.user)
    const unsubscribe = next.auth.onChange(update)
    next.auth
      .getToken()
      .catch((reason) => {
        if (active) setError(errorMessage(reason))
      })
      .finally(() => {
        if (active) {
          update()
          setConnection(next)
        }
      })
    return () => {
      active = false
      unsubscribe()
      next.client.close()
    }
  }, [])

  async function authenticate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!connection || busy) return
    const values = new FormData(event.currentTarget)
    const credentials = {
      email: String(values.get("email")).trim(),
      password: String(values.get("password")),
    }
    setBusy(true)
    setError("")
    try {
      if (register) await connection.auth.signUp(credentials)
      else await connection.auth.signInWithPassword(credentials)
    } catch (reason) {
      setError(errorMessage(reason))
    } finally {
      setBusy(false)
    }
  }

  return (
    <main>
      <header>
        <div className="brand">
          <span aria-hidden="true" className="mark">
            ✳
          </span>{" "}
          Canopy Chat
        </div>
        {user && (
          <Button
            onClick={async () => {
              try {
                await connection?.auth.signOut()
                setError("")
                setRegister(false)
              } catch (reason) {
                setError(errorMessage(reason))
              }
            }}
          >
            Sign out
          </Button>
        )}
      </header>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {user && connection ? (
        <Room key={user.id} connection={connection} user={user} />
      ) : (
        <section className="auth">
          <div className="room-art" aria-hidden="true">
            <span>✳</span>
          </div>
          <div className="panel">
            <p className="eyebrow">General room</p>
            <h1>{register ? "Join the conversation." : "Welcome back."}</h1>
            <p>
              {register
                ? "Create an account to chat with the room."
                : "Sign in to catch up with the room."}
            </p>
            <form onSubmit={authenticate}>
              <label htmlFor="email">Email address</label>
              <Input id="email" type="email" name="email" autoComplete="email" required />
              <label htmlFor="password">Password</label>
              <PasswordInput
                name="password"
                required
                autoComplete={register ? "new-password" : "current-password"}
              >
                <PasswordInputControl id="password" minLength={register ? 10 : undefined} />
                <PasswordInputToggle aria-label="Toggle password visibility" />
              </PasswordInput>
              {register && <small>Use at least 10 characters.</small>}
              <Button className="primary" type="submit" disabled={busy || !connection}>
                {register ? "Create account" : "Sign in"}
              </Button>
            </form>
            <Button
              className="plain"
              disabled={busy}
              onClick={() => {
                setRegister(!register)
                setError("")
              }}
            >
              {register ? "Already registered? Sign in" : "New here? Create an account"}
            </Button>
          </div>
        </section>
      )}
    </main>
  )
}

function Room({
  connection,
  user,
}: {
  connection: Connection
  user: NonNullable<Connection["auth"]["user"]>
}) {
  const [messages, setMessages] = useState<readonly Doc<"messages">[]>([])
  const [status, setStatus] = useState("connecting")
  const [draft, setDraft] = useState("")
  const [pending, setPending] = useState(false)
  const [error, setError] = useState("")
  const end = useRef<HTMLDivElement>(null)
  useEffect(
    () =>
      connection.client
        .from("messages")
        .find({})
        .sort({ createdAt: -1, _id: -1 })
        .limit(100)
        .subscribe((snapshot) => {
          setMessages([...snapshot.data].reverse())
          setStatus(snapshot.status)
        }),
    [connection],
  )
  const latest = messages.at(-1)?._id.toString()
  useEffect(() => {
    if (latest) end.current?.scrollIntoView({ block: "nearest" })
  }, [latest])
  async function send(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const body = draft.trim()
    if (!body || pending) return
    setPending(true)
    setError("")
    try {
      await connection.client
        .from("messages")
        .insert({ body, authorId: user.id, createdAt: new Date() })
      setDraft("")
    } catch (reason) {
      setError(errorMessage(reason))
    } finally {
      setPending(false)
    }
  }
  return (
    <section className="room">
      <div className="room-head">
        <div>
          <p className="eyebrow">Shared conversation</p>
          <h1>General room</h1>
        </div>
        <small role="status">{status === "ready" ? "Live" : status}</small>
      </div>
      <div className="history" role="log" aria-label="Messages">
        {!messages.length && status === "ready" && (
          <p className="empty">No messages yet. Say hello!</p>
        )}
        {messages.map((message) => (
          <article
            key={message._id.toString()}
            className={message.authorId === user.id ? "mine" : ""}
          >
            <small>
              {message.authorId === user.id ? "You" : `Member · ${message.authorId.slice(-8)}`}{" "}
              <time>
                {message.createdAt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
              </time>
            </small>
            <p>{message.body}</p>
          </article>
        ))}
        <div ref={end} />
      </div>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      <form className="composer" onSubmit={send}>
        <Input
          aria-label="Message"
          placeholder="Message the room…"
          value={draft}
          onValueChange={setDraft}
          maxLength={4000}
          disabled={pending}
        />
        <Button className="primary" type="submit" disabled={pending || !draft.trim()}>
          Send
        </Button>
      </form>
      <small className="identity">Signed in as {user.email ?? user.id}</small>
    </section>
  )
}
