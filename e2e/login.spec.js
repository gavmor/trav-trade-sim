import { test, expect } from '@playwright/test'

// ── Static page tests (no Supabase required) ───────────────────────────────────
// These tests verify the login page renders correctly and form logic works
// without requiring a live Supabase connection.

test.describe('Login page — static rendering', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
  })

  test('shows the app title', async ({ page }) => {
    await expect(page.locator('h1')).toContainText('Traveller Trade Simulator')
  })

  test('shows four mode tabs', async ({ page }) => {
    const tabs = page.locator('.tab')
    await expect(tabs).toHaveCount(4)
    await expect(tabs.nth(0)).toContainText('Sign In')
    await expect(tabs.nth(1)).toContainText('Join Campaign')
    await expect(tabs.nth(2)).toContainText('New Campaign')
    await expect(tabs.nth(3)).toContainText('Reset PIN')
  })

  test('Sign In is the active tab on load', async ({ page }) => {
    await expect(page.locator('.tab.active')).toContainText('Sign In')
  })

  test('Sign In form has Campaign Code, Character Name, and PIN fields', async ({ page }) => {
    await expect(page.locator('input[placeholder*="SPINWARD"]')).toBeVisible()
    await expect(page.locator('input[placeholder*="character"]')).toBeVisible()
    await expect(page.locator('input[type="password"]')).toBeVisible()
  })

  test('switching to New Campaign tab reveals the Starting Date fields', async ({ page }) => {
    await page.locator('.tab').nth(2).click()
    await expect(page.locator('.date-pair')).toBeVisible()
    await expect(page.locator('.derived-value')).toBeVisible()
  })

  test('derived week updates when starting day changes', async ({ page }) => {
    await page.locator('.tab').nth(2).click()

    const dayInput = page.locator('input[type="number"][min="1"][max="365"]')
    const weekDisplay = page.locator('.derived-value')

    await expect(weekDisplay).toHaveText('1')

    await dayInput.fill('8')
    await expect(weekDisplay).toHaveText('2')

    await dayInput.fill('336')
    await expect(weekDisplay).toHaveText('48')

    await dayInput.fill('365')
    await expect(weekDisplay).toHaveText('48')
  })

  test('Join Campaign shows PIN confirmation field', async ({ page }) => {
    await page.locator('.tab').nth(1).click()
    const pins = page.locator('input[type="password"]')
    await expect(pins).toHaveCount(2)
  })

  test('New Campaign shows two PIN fields', async ({ page }) => {
    await page.locator('.tab').nth(2).click()
    const pins = page.locator('input[type="password"]')
    await expect(pins).toHaveCount(2)
  })

  test('footer contains non-commercial notice', async ({ page }) => {
    await expect(page.locator('.login-footer')).toContainText('Non-commercial')
  })
})

// ── Form validation tests (no Supabase required) ──────────────────────────────

test.describe('Login page — client-side validation', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
  })

  test('mismatched PINs on New Campaign show error banner', async ({ page }) => {
    await page.locator('.tab').nth(2).click()

    await page.fill('input[placeholder*="Spinward Marches"]', 'TEST CAMPAIGN')
    await page.fill('input[placeholder*="SPINWARD"]', 'TEST-99')
    await page.fill('input[placeholder*="Referee"]', 'Cmdr Test')

    const pins = page.locator('input[type="password"]')
    await pins.nth(0).fill('1234')
    await pins.nth(1).fill('9999')

    await page.locator('button[type="submit"]').click()
    await expect(page.locator('.auth-error')).toContainText('do not match')
  })

  test('campaign code is uppercased automatically', async ({ page }) => {
    await page.locator('.tab').nth(2).click()
    const codeInput = page.locator('input[placeholder*="SPINWARD"]')
    await codeInput.fill('spinward-42')
    await expect(codeInput).toHaveValue('SPINWARD-42')
  })
})

// ── Full-stack campaign creation (p2p CRDT backend, no server) ────────────────
// Exercises the real in-browser stack: PBKDF2 PIN hashing, the op-log CRDT
// document, IndexedDB persistence, and crdtbus (which tolerates the signaling
// server being unreachable by falling back to local-only operation).

test.describe('Campaign creation — local p2p stack', () => {
  test('creates a campaign and shows the recovery code, then lands on the map', async ({ page }) => {
    await page.goto('/')
    await page.locator('.tab').nth(2).click()

    await page.fill('input[placeholder*="Spinward Marches"]', 'E2E CAMPAIGN')
    await page.fill('input[placeholder*="SPINWARD"]', `E2E-${Date.now()}`)
    await page.fill('input[placeholder*="Referee"]', 'Cmdr E2E')

    const pins = page.locator('input[type="password"]')
    await pins.nth(0).fill('1234')
    await pins.nth(1).fill('1234')

    await page.locator('button[type="submit"]').click()

    // Creation waits briefly for peers (duplicate-code check) before writing.
    const dialog = page.locator('[role="alertdialog"]')
    await expect(dialog).toBeVisible({ timeout: 15000 })
    await expect(dialog.locator('.code-text')).not.toBeEmpty()

    await dialog.locator('.ack-check').check()
    await dialog.locator('.continue-btn').click()
    await expect(page).toHaveURL(/\/$|#\/$/, { timeout: 10000 })
    await expect(page.locator('[role="alertdialog"]')).toHaveCount(0)
  })
})
