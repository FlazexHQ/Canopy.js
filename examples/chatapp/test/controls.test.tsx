import { cleanup, render, screen } from "@testing-library/react"
import { createAgent } from "@ui-sdk/react/agent"
import { afterEach, expect, test, vi } from "vitest"
import ChatPage from "../app/page"

vi.mock("canopy.js/auth", () => ({
  createAuth: () => ({ getToken: async () => null, onChange: () => () => {} }),
}))
vi.mock("canopy.js", () => ({ createClient: () => ({ close() {} }) }))
afterEach(cleanup)

test("the sign in controls can be found and operated by name", async () => {
  render(<ChatPage />)
  const agent = createAgent()
  await vi.waitFor(() =>
    expect((screen.getByRole("button", { name: "Sign in" }) as HTMLButtonElement).disabled).toBe(
      false,
    ),
  )
  const controls = agent.snapshot().filter((entry) => !entry.offPage && entry.component !== "more")
  expect(controls.map((entry) => entry.label)).toEqual(
    expect.arrayContaining(["Email address", "Password", "Sign in", "New here? Create an account"]),
  )
  const result = await agent.act({
    steps: [{ ref: "Email address", action: "setValue", args: ["someone@example.test"] }],
  })
  expect(result.ok).toBe(true)
  expect((screen.getByLabelText("Email address") as HTMLInputElement).value).toBe(
    "someone@example.test",
  )
})
