# Playwright Best Practices for Bober Projects

This reference document describes patterns and best practices for writing Playwright E2E tests within the bober agent workflow. The generator and evaluator agents should follow these patterns to produce robust, maintainable tests.

---

## Selector Strategy: `data-testid` First

When Playwright is an evaluation strategy, all UI components **must** include `data-testid` attributes on interactive elements and key content areas. This is non-negotiable.

### Why `data-testid`?

- **Stable across refactors.** CSS classes, tag names, and text content change frequently. `data-testid` attributes are explicitly for testing and survive refactors.
- **No coupling to styling.** Tests do not break when Tailwind classes change or when a component library is swapped.
- **Clear intent.** A `data-testid` attribute signals "this element is tested" to every developer on the team.
- **Framework-agnostic.** Works identically in React, Vue, Svelte, and plain HTML.

### Naming Convention

Use descriptive, kebab-case names that describe the element's purpose:

```html
<!-- Good -->
<form data-testid="login-form">
  <input data-testid="email-input" />
  <input data-testid="password-input" />
  <button data-testid="login-submit-button">Log In</button>
  <p data-testid="login-error-message">Invalid credentials</p>
</form>

<!-- Bad -->
<form data-testid="form1">
  <input data-testid="input1" />
  <button data-testid="btn">Log In</button>
</form>
```

### Where to Add `data-testid`

The generator must add `data-testid` to:
- Forms and form elements (inputs, buttons, selects, textareas)
- Navigation links and menu items
- Content containers that display dynamic data (cards, lists, tables)
- Error messages and status indicators
- Modal dialogs and their trigger buttons
- Loading indicators and empty state messages

---

## Test File Structure

### One File Per Feature or Sprint

```
e2e/
  auth.spec.ts           # Authentication flows (login, register, logout)
  dashboard.spec.ts      # Dashboard page tests
  settings.spec.ts       # Settings page tests
  auth.setup.ts          # Authentication setup (shared storage state)
```

### Standard Test Template

```typescript
import { test, expect } from '@playwright/test';

test.describe('Feature: Dashboard', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/dashboard');
    await page.waitForLoadState('networkidle');
  });

  test('displays the dashboard header', async ({ page }) => {
    const header = page.getByTestId('dashboard-header');
    await expect(header).toBeVisible();
    await expect(header).toHaveText(/Dashboard/);
  });

  test('shows data cards when data is loaded', async ({ page }) => {
    const cardContainer = page.getByTestId('dashboard-cards');
    await expect(cardContainer).toBeVisible();

    const cards = page.getByTestId('dashboard-card');
    await expect(cards.first()).toBeVisible();
  });

  test('handles empty state gracefully', async ({ page }) => {
    // If testing empty state, you may need to intercept the API
    await page.route('**/api/dashboard', (route) =>
      route.fulfill({ status: 200, json: { items: [] } }),
    );
    await page.reload();
    await page.waitForLoadState('networkidle');

    const emptyState = page.getByTestId('dashboard-empty-state');
    await expect(emptyState).toBeVisible();
  });
});
```

---

## Common Patterns

### Form Submission

```typescript
test('submits the registration form', async ({ page }) => {
  await page.goto('/register');

  await page.getByTestId('name-input').fill('Test User');
  await page.getByTestId('email-input').fill('test@example.com');
  await page.getByTestId('password-input').fill('SecurePass123!');
  await page.getByTestId('register-submit-button').click();

  // Wait for navigation after successful submission
  await expect(page).toHaveURL(/\/dashboard/);

  // Or wait for a success message
  await expect(page.getByTestId('success-message')).toBeVisible();
});
```

### Form Validation

```typescript
test('shows validation errors for invalid input', async ({ page }) => {
  await page.goto('/register');

  // Submit empty form
  await page.getByTestId('register-submit-button').click();

  // Check for validation messages
  await expect(page.getByTestId('name-error')).toBeVisible();
  await expect(page.getByTestId('email-error')).toBeVisible();
  await expect(page.getByTestId('password-error')).toBeVisible();
});
```

### Navigation

```typescript
test('navigates to the settings page', async ({ page }) => {
  await page.goto('/');

  await page.getByTestId('nav-settings-link').click();
  await expect(page).toHaveURL(/\/settings/);
  await expect(page.getByTestId('settings-page')).toBeVisible();
});
```

### SPA Route Changes

For single-page applications, use `waitForLoadState('networkidle')` after client-side navigation:

```typescript
test('client-side navigation works', async ({ page }) => {
  await page.goto('/');
  await page.waitForLoadState('networkidle');

  await page.getByTestId('nav-about-link').click();
  await page.waitForLoadState('networkidle');

  await expect(page).toHaveURL(/\/about/);
  await expect(page.getByTestId('about-page-content')).toBeVisible();
});
```

### API Mocking

Use Playwright's `page.route()` to mock API responses when testing specific UI states:

```typescript
test('displays error when API fails', async ({ page }) => {
  // Intercept the API call and return an error
  await page.route('**/api/users', (route) =>
    route.fulfill({
      status: 500,
      json: { error: 'Internal Server Error' },
    }),
  );

  await page.goto('/users');
  await page.waitForLoadState('networkidle');

  await expect(page.getByTestId('error-message')).toBeVisible();
  await expect(page.getByTestId('error-message')).toContainText(/error/i);
});
```

### Waiting for API Responses

```typescript
test('loads user data from API', async ({ page }) => {
  await page.goto('/users');

  // Wait for the specific API response
  const response = await page.waitForResponse('**/api/users');
  expect(response.status()).toBe(200);

  // Then assert on the rendered data
  await expect(page.getByTestId('user-list')).toBeVisible();
});
```

---

## Authentication Handling

### Shared Auth State with `storageState`

For projects requiring authenticated users, create a setup file that logs in once and saves the browser state:

**`e2e/auth.setup.ts`:**
```typescript
import { test as setup, expect } from '@playwright/test';

const authFile = 'e2e/.auth/user.json';

setup('authenticate', async ({ page }) => {
  await page.goto('/login');

  await page.getByTestId('email-input').fill('test@example.com');
  await page.getByTestId('password-input').fill('testpassword');
  await page.getByTestId('login-submit-button').click();

  // Wait for successful login (redirect to dashboard or similar)
  await expect(page).toHaveURL(/\/dashboard/);

  // Save the authentication state
  await page.context().storageState({ path: authFile });
});
```

**`playwright.config.ts` additions:**
```typescript
projects: [
  {
    name: 'setup',
    testMatch: /auth\.setup\.ts/,
  },
  {
    name: 'chromium',
    use: {
      ...devices['Desktop Chrome'],
      storageState: 'e2e/.auth/user.json',
    },
    dependencies: ['setup'],
  },
],
```

Add `e2e/.auth/` to `.gitignore`.

---

## Visual Verification Without Flakiness

Avoid pixel-comparison screenshot tests. They are extremely flaky across different environments (font rendering, anti-aliasing, OS differences). Instead:

### Check Structural Presence

```typescript
// Good: Check that elements exist and have the right content
await expect(page.getByTestId('hero-title')).toHaveText('Welcome');
await expect(page.getByTestId('hero-image')).toBeVisible();

// Bad: Screenshot comparison
// expect(await page.screenshot()).toMatchSnapshot();
```

### Check CSS Properties When Needed

```typescript
// Check that an element has a specific visual state
const button = page.getByTestId('submit-button');
await expect(button).toHaveCSS('background-color', 'rgb(37, 99, 235)');
await expect(button).toBeEnabled();
```

### Use Failure Screenshots for Debugging Only

The `playwright.config.ts` is configured with `screenshot: 'only-on-failure'`. This captures screenshots when tests fail, which is useful for debugging but does not introduce flaky assertions.

---

## Error Handling in Tests

### Capture Console Errors

```typescript
test('page has no JavaScript errors', async ({ page }) => {
  const errors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      errors.push(msg.text());
    }
  });

  await page.goto('/dashboard');
  await page.waitForLoadState('networkidle');

  // Filter out known acceptable errors if needed
  const criticalErrors = errors.filter(
    (e) => !e.includes('favicon.ico'),
  );
  expect(criticalErrors).toEqual([]);
});
```

### Handle Network Failures Gracefully

```typescript
test('shows offline message when network fails', async ({ page }) => {
  await page.goto('/dashboard');
  await page.waitForLoadState('networkidle');

  // Simulate network failure
  await page.route('**/*', (route) => route.abort());

  // Trigger an action that requires network
  await page.getByTestId('refresh-button').click();

  await expect(page.getByTestId('network-error-message')).toBeVisible();
});
```

---

## Debugging Tips

### Interactive Mode

```bash
npx playwright test --ui
```
Opens a browser-based UI for running and debugging tests interactively.

### Headed Mode

```bash
npx playwright test --headed
```
Runs tests in a visible browser window.

### Trace Viewer

When a test fails with `trace: 'on-first-retry'` configured:
```bash
npx playwright show-trace test-results/<test-folder>/trace.zip
```

### Specific Test Execution

```bash
npx playwright test e2e/auth.spec.ts                    # specific file
npx playwright test -g "submits the login form"          # specific test by name
npx playwright test e2e/auth.spec.ts:15                  # specific line
```

---

## Things to Avoid

1. **Never use `page.waitForTimeout()`**. It is a hardcoded delay that introduces flakiness. Use auto-waiting assertions or event-based waits.

2. **Never use CSS class selectors** (`.btn-primary`, `.card`). Classes change during refactors and are not stable test anchors.

3. **Never use XPath selectors**. They are fragile and hard to maintain. Use `data-testid` attributes.

4. **Never test implementation details**. Do not assert on Redux store state, internal component state, or private API responses. Test what the user sees.

5. **Never rely on test execution order**. Each test must be independently runnable. Use `test.beforeEach` for setup.

6. **Never hardcode wait times**. If you find yourself adding `waitForTimeout(2000)`, there is a better way to wait (usually an assertion or `waitForResponse`).

7. **Never commit `e2e-results/` or `test-results/`**. These are ephemeral outputs. They belong in `.gitignore`.
