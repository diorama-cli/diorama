import { expect, test } from '@playwright/test'
import { fixture, startDiorama } from './support.ts'

/**
 * A link inside a rendered Markdown file (docs/m12/spec.md, contract.md §5.1).
 *
 * Reported as "clicking a relative link in a rendered Markdown file reloads
 * the page and every other tab is gone": the link was a plain `href`, so the
 * browser navigated. The page's URL carries only the active file
 * (contract.md §3.8), so a navigation restores exactly one tab.
 *
 * The rule now: a link of this mount opens a tab, `#fragment` scrolls, another
 * origin opens a browser tab, and a path that leaves the mount does nothing.
 */

const README = [
  '# Readme',
  '',
  'A [notes page](docs/notes.md) and a [section](#second-part).',
  '',
  'Also [an external site](https://example.com/docs) and',
  '[a way out](../../etc/passwd).',
  '',
  '## Second part',
  '',
  'text',
  '',
].join('\n')

const NOTES = ['# Notes', '', '## Target section', '', 'body', ''].join('\n')

/** A directory whose README links to a file, an anchor, a site and an escape. */
function linkFixture() {
  return fixture({ 'README.md': README, 'docs/notes.md': NOTES })
}

test('markdown links: a relative link opens a tab instead of reloading the page', async ({ page }) => {
  const directory = linkFixture()
  const server = await startDiorama(directory.root)
  try {
    await page.goto(server.url)
    // A marker on the page's own global: a navigation would throw it away.
    await page.evaluate(() => {
      ;(window as unknown as { __noReload?: boolean }).__noReload = true
    })
    await page.getByTestId('file-tree').locator('[data-path="README.md"]').click()
    await page.getByTestId('markdown').waitFor()
    // A second tab first: losing it is exactly the reported bug.
    await page.getByTestId('file-tree').locator('[data-path="LICENSE"]').click()
    await expect(page.locator('.diorama-tabs__strip [role="tab"]')).toHaveCount(2)
    await page.locator('.diorama-tabs__strip [role="tab"] .diorama-tabs__label', { hasText: 'README.md' }).click()

    await page.locator('.diorama-markdown a', { hasText: 'notes page' }).click()

    // The link opened a third tab, and both earlier tabs survived.
    await expect(page.locator('.diorama-tabs__strip [role="tab"]')).toHaveCount(3)
    await expect(page.getByTestId('active-tab').locator('.diorama-tabs__label')).toHaveText('notes.md')
    await expect(page.getByTestId('tabs-content').filter({ visible: true }).locator('.diorama-markdown h1')).toHaveText('Notes')
    expect(new URL(page.url()).pathname).toBe('/~/docs/notes.md')
    expect(await page.evaluate(() => (window as unknown as { __noReload?: boolean }).__noReload)).toBe(true)
  } finally {
    await server.stop()
    directory.dispose()
  }
})

test('markdown links: a #fragment scrolls to that heading and changes no tab', async ({ page }) => {
  const directory = fixture({
    'README.md': ['# Readme', '', ...Array.from({ length: 80 }, (_, index) => `line ${index + 1}`), '', '## Second part', '', 'tail', ''].join('\n'),
  })
  const server = await startDiorama(directory.root)
  try {
    await page.goto(`${server.url}~/README.md`)
    await page.getByTestId('markdown').waitFor()
    const heading = page.locator('.diorama-markdown h2', { hasText: 'Second part' })
    await expect(heading).toHaveAttribute('id', 'second-part')

    // A link to the heading, at the bottom of the document.
    await page.evaluate(() => {
      const article = document.querySelector('.diorama-markdown')
      if (article === null) throw new Error('no article')
      const link = document.createElement('a')
      link.href = '#second-part'
      link.textContent = 'jump'
      article.append(link)
    })
    const pane = page.getByTestId('tabs-content').filter({ visible: true })
    await page.evaluate(() => {
      const scroller = document.querySelector('.diorama-tabs__content')
      if (scroller !== null) scroller.scrollTop = 0
    })
    await page.locator('.diorama-markdown a', { hasText: 'jump' }).click()

    await expect
      .poll(async () => (await pane.evaluate(node => node.parentElement?.scrollTop ?? 0)) > 0 || (await heading.isVisible()))
      .toBe(true)
    // One tab, same URL: a fragment is not a navigation.
    await expect(page.locator('.diorama-tabs__strip [role="tab"]')).toHaveCount(1)
    expect(new URL(page.url()).pathname).toBe('/~/README.md')
  } finally {
    await server.stop()
    directory.dispose()
  }
})

test('markdown links: another origin opens a new browser tab, an escape does nothing', async ({ page, context }) => {
  const directory = linkFixture()
  const server = await startDiorama(directory.root)
  try {
    await page.goto(`${server.url}~/README.md`)
    await page.getByTestId('markdown').waitFor()
    await page.evaluate(() => {
      ;(window as unknown as { __noReload?: boolean }).__noReload = true
    })

    // The escape is swallowed: no tab, no navigation, no new page.
    const before = context.pages().length
    await page.locator('.diorama-markdown a', { hasText: 'a way out' }).click()
    await expect(page.locator('.diorama-tabs__strip [role="tab"]')).toHaveCount(1)
    expect(context.pages().length).toBe(before)
    expect(new URL(page.url()).pathname).toBe('/~/README.md')

    // An external link leaves this page alone (the popup is another page).
    const [popup] = await Promise.all([
      context.waitForEvent('page'),
      page.locator('.diorama-markdown a', { hasText: 'an external site' }).click(),
    ])
    expect(popup.url()).toContain('example.com')
    await popup.close()
    await expect(page.locator('.diorama-tabs__strip [role="tab"]')).toHaveCount(1)
    expect(await page.evaluate(() => (window as unknown as { __noReload?: boolean }).__noReload)).toBe(true)
  } finally {
    await server.stop()
    directory.dispose()
  }
})

test('markdown links: a link to a directory opens its README, or does nothing', async ({ page }) => {
  const directory = fixture({
    'README.md': '# Readme\n\n[with an index](with-index) and [without one](docs)\n',
    'with-index/README.md': '# Index\n\nbody\n',
  })
  const server = await startDiorama(directory.root)
  try {
    await page.goto(`${server.url}~/README.md`)
    await page.getByTestId('markdown').waitFor()

    // A directory with a README: that document, in a tab.
    await page.locator('.diorama-markdown a', { hasText: 'with an index' }).click()
    // Both documents are called README.md, so the URL is the assertion that
    // says *which* one opened (the label alone cannot tell them apart).
    await expect(page).toHaveURL(/\/~\/with-index\/README\.md$/)
    await expect(page.getByTestId('tabs-content').filter({ visible: true }).locator('.diorama-markdown h1')).toHaveText('Index')

    // A directory with none: nothing opens, and nothing navigates either.
    await page.locator('.diorama-tabs__strip [role="tab"] .diorama-tabs__label').first().click()
    await expect(page.locator('.diorama-tabs__strip [role="tab"]')).toHaveCount(2)
    await page.locator('.diorama-markdown a', { hasText: 'without one' }).click()
    await expect(page.locator('.diorama-tabs__strip [role="tab"]')).toHaveCount(2)
    expect(new URL(page.url()).pathname).toBe('/~/README.md')
  } finally {
    await server.stop()
    directory.dispose()
  }
})
