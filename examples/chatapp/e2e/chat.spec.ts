import { randomUUID } from "node:crypto"
import { expect, type Page, test } from "@playwright/test"

test("two accounts chat live and can sign back in", async ({ page, browser }) => {
  const email = `chat-${randomUUID()}@example.test`
  const password = randomUUID()
  const message = `Hello from the browser ${randomUUID()}`
  async function register(tab: Page, address: string) {
    await tab.goto("http://localhost:3000")
    await tab.getByRole("button", { name: "New here? Create an account" }).click()
    await tab.getByLabel("Email address").fill(address)
    await tab.getByLabel("Password", { exact: true }).fill(password)
    await tab.getByRole("button", { name: "Create account", exact: true }).click()
    await expect(tab.getByRole("status").filter({ hasText: /^Live$/ })).toBeVisible()
  }
  await register(page, email)
  const other = await browser.newContext()
  try {
    const peer = await other.newPage()
    await register(peer, `peer-${randomUUID()}@example.test`)
    await page.getByLabel("Message", { exact: true }).fill(message)
    await page.getByRole("button", { name: "Send", exact: true }).click()
    await expect(peer.getByRole("log")).toContainText(message)
    await page.getByRole("button", { name: "Sign out" }).click()
    await expect(page.getByRole("log")).toHaveCount(0)
    await page.getByLabel("Email address").fill(email)
    await page.getByLabel("Password", { exact: true }).fill(password)
    await page.getByRole("button", { name: "Sign in", exact: true }).click()
    await expect(page.getByRole("log")).toContainText(message)
    await page.reload()
    await expect(page.getByRole("log")).toContainText(message)
  } finally {
    await other.close()
  }
})
