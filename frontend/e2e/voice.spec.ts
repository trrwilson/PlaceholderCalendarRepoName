import { expect, test } from '@playwright/test'

const emptyCalendar = { calendars: [], events: [] }

test.beforeEach(async ({ page }) => {
  await page.route('**/api/calendar**', (route) =>
    route.fulfill({ contentType: 'application/json', body: JSON.stringify(emptyCalendar) }),
  )
  // Voice provider config — the kiosk fetches this for the Settings picker.
  await page.route('**/api/voice/config', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        enabled: true,
        provider: 'gemini',
        providers: [
          { id: 'gemini', label: 'Gemini Live', implemented: true, configured: true },
          { id: 'azure_voice_live', label: 'Azure Voice Live', implemented: false, configured: false },
        ],
      }),
    }),
  )
  // Wake word off by default — the kiosk asks for this on load.
  await page.route('**/api/voice/wake-config', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        enabled: false,
        phrase: 'Mission Control',
        threshold: 0.5,
        cooldown_ms: 2000,
        model_path: '/models/wake/mission_control.onnx',
        models_base_url: '/models/wake',
      }),
    }),
  )
})

test('the Ask button is available and starts a voice turn on tap', async ({ page }) => {
  await page.route('**/api/voice/token', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ token: 'auth_tokens/x', model: 'test-model', expires_at: '2099-01-01T00:00:00' }),
    }),
  )
  await page.goto('/')
  const ask = page.getByRole('button', { name: 'Ask Mission Control' })
  await expect(ask).toBeEnabled()
  // The Live session / mic will not actually open in a headless browser, but the
  // overlay must appear as the turn is attempted.
  await ask.click()
  await expect(page.locator('.voice-overlay')).toBeVisible()
})

test('the Ask button reports when voice support is switched off', async ({ page }) => {
  await page.route('**/api/voice/token', (route) =>
    route.fulfill({
      status: 409,
      contentType: 'application/json',
      body: JSON.stringify({ detail: 'voice support is disabled' }),
    }),
  )
  await page.goto('/')
  const ask = page.getByRole('button', { name: 'Ask Mission Control' })
  await ask.click()
  await expect(ask).toBeDisabled()
  await expect(ask).toHaveText(/Voice off/)
  // A transient toast announces why, with no retry for a hard "disabled" result.
  const toast = page.getByRole('alert')
  await expect(toast).toContainText('Voice is turned off')
  await expect(toast.getByRole('button', { name: 'Try again' })).toHaveCount(0)
})

test('Settings shows the voice provider picker with the active provider selected', async ({ page }) => {
  await page.route('**/api/voice/token', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ provider: 'gemini', token: 'auth_tokens/x', model: 'test-model', expires_at: '2099-01-01T00:00:00' }),
    }),
  )
  await page.goto('/')
  await page.getByRole('button', { name: 'Open settings' }).click()
  const dialog = page.getByRole('dialog', { name: 'Settings' })
  // The bake-off pickers live under Voice & sound → Advanced (collapsed by default).
  await dialog.getByRole('button', { name: 'Voice & sound' }).click()
  await dialog.getByRole('button', { name: 'Advanced (bake-off)' }).click()
  await expect(dialog.getByText('Voice provider')).toBeVisible()
  await expect(dialog.getByRole('button', { name: 'Gemini Live' })).toHaveAttribute('aria-pressed', 'true')
  // An unimplemented contestant is listed but disabled.
  await expect(dialog.getByRole('button', { name: /Azure Voice Live/ })).toBeDisabled()
})

test('wake word shows a Settings control and degrades safely without a model', async ({ page }) => {
  await page.route('**/api/voice/wake-config', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        enabled: true,
        phrase: 'Mission Control',
        threshold: 0.5,
        cooldown_ms: 2000,
        model_path: '/models/wake/mission_control.onnx',
        models_base_url: '/models/wake',
      }),
    }),
  )
  await page.route('**/api/voice/token', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ token: 'auth_tokens/x', model: 'test-model', expires_at: '2099-01-01T00:00:00' }),
    }),
  )
  await page.goto('/')
  await page.getByRole('button', { name: 'Open settings' }).click()
  const dialog = page.getByRole('dialog', { name: 'Settings' })
  await dialog.getByRole('button', { name: 'Voice & sound' }).click()
  await expect(dialog.getByText('Wake word')).toBeVisible()
  // No onnxruntime-web / model asset in the test build: the detector reports
  // unavailable and the note says push-to-talk still works.
  await expect(dialog.getByText(/push-to-talk still works/)).toBeVisible()
  // And push-to-talk genuinely still works.
  await page.getByRole('button', { name: 'Close settings' }).click()
  await page.getByRole('button', { name: 'Ask Mission Control' }).click()
  await expect(page.locator('.voice-overlay')).toBeVisible()
})

test('Speaker output picker appears only when an Invoke host is configured', async ({ page }) => {
  await page.route('**/api/voice/config', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        enabled: true,
        provider: 'gemini',
        providers: [{ id: 'gemini', label: 'Gemini Live', implemented: true, configured: true }],
        mic_input_gain_db: 0,
        invoke_speaker_configured: true,
        invoke_speaker_host: '192.168.50.67',
        invoke_speaker_audio_port: 5006,
      }),
    }),
  )
  await page.goto('/')
  await page.getByRole('button', { name: 'Open settings' }).click()
  const dialog = page.getByRole('dialog', { name: 'Settings' })
  await dialog.getByRole('button', { name: 'Voice & sound' }).click()
  await dialog.getByRole('button', { name: 'Advanced (bake-off)' }).click()
  await expect(dialog.getByText('Speaker output')).toBeVisible()
  await expect(dialog.getByRole('button', { name: 'This screen' })).toHaveAttribute('aria-pressed', 'true')
  await dialog.getByRole('button', { name: 'Invoke (Wi-Fi)' }).click()
  await expect(dialog.getByRole('button', { name: 'Invoke (Wi-Fi)' })).toHaveAttribute('aria-pressed', 'true')
  await expect(dialog.getByText(/Connecting to the Invoke|Streaming to the Invoke/)).toBeVisible()
})
