/**
 * ElementMapper — client-side incremental screen map builder.
 *
 * Runs in the browser during session recording. Extracts rich element
 * metadata from the live DOM as the user navigates and interacts.
 *
 * Each screen gets a rich `state` descriptor (URL parts, title, headings,
 * breadcrumb, landmarks, open modals, active tabs, etc.) so the AI can
 * reason about *which* screen a selector belongs to. A MurmurHash3
 * fingerprint deduplicates screens that share the same visual state.
 */

const MAX_LABEL_LENGTH = 120
const MAX_TEXT_LENGTH = 50
const SCAN_INTERVAL_MS = 5000
const SKELETON_MAX_DEPTH = 4

const INTERACTIVE_SELECTOR = [
  'button',
  'a[href]',
  'input:not([type="hidden"])',
  'select',
  'textarea',
  '[role="button"]',
  '[role="link"]',
  '[role="tab"]',
  '[role="combobox"]',
  '[role="menuitem"]',
  '[data-testid]',
  '[data-test-id]',
].join(', ')

const LANDMARK_TAGS = new Set(['nav', 'main', 'aside', 'footer', 'header', 'form', 'dialog'])
const LANDMARK_ROLES = new Set(['navigation', 'main', 'complementary', 'contentinfo', 'banner', 'form', 'dialog'])

const IMPLICIT_ROLES = {
  a: 'link',
  button: 'button',
  input: 'textbox',
  select: 'combobox',
  textarea: 'textbox',
  nav: 'navigation',
  main: 'main',
  aside: 'complementary',
  footer: 'contentinfo',
  header: 'banner',
  table: 'table',
  dialog: 'dialog',
  img: 'img',
}

const INPUT_ROLE_MAP = {
  checkbox: 'checkbox',
  radio: 'radio',
  number: 'spinbutton',
  range: 'slider',
  search: 'searchbox',
}

const ROLE_ACTION_MAP = {
  button: 'click',
  link: 'click',
  tab: 'click',
  menuitem: 'click',
  checkbox: 'toggle',
  combobox: 'select',
  textbox: 'fill',
  searchbox: 'fill',
  spinbutton: 'fill',
  slider: 'fill',
  radio: 'toggle',
}

// ─── MurmurHash3 (32-bit, inline) ────────────────────────────────
// Lightweight non-cryptographic hash — no external deps needed.

function murmurhash3(str) {
  let h = 0x811c9dc5
  for (let i = 0; i < str.length; i++) {
    const k = Math.imul(str.charCodeAt(i), 0xcc9e2d51)
    h ^= (k << 15) | (k >>> 17)
    h = Math.imul(h, 0x1b873593)
    h ^= h >>> 13
    h = Math.imul(h, 0xc2b2ae35)
    h ^= h >>> 16
  }
  return (h >>> 0).toString(16).padStart(8, '0')
}

export class ElementMapper {
  constructor() {
    /** @type {Map<string, { name: string, url: string, fingerprint: string, state: object, elements: Map<string, object> }>} */
    this.screens = new Map()
    this.currentUrl = null
    this.currentTitle = null
    this._scanTimer = null
    this._dirty = false
  }

  isDirty() {
    return this._dirty
  }

  clearDirty() {
    this._dirty = false
  }

  // ─── Lifecycle ──────────────────────────────────────────────────

  start() {
    this.onPageView(window.location.href, document.title)
    this._scanTimer = setInterval(() => this.scan(), SCAN_INTERVAL_MS)
  }

  stop() {
    if (this._scanTimer) {
      clearInterval(this._scanTimer)
      this._scanTimer = null
    }
  }

  // ─── Hooks (called by collector listeners) ──────────────────────

  onPageView(url, title) {
    this.currentUrl = normalizeUrl(url)
    this.currentTitle = title || document.title || ''

    if (!this.screens.has(this.currentUrl)) {
      this.screens.set(this.currentUrl, {
        name: this.currentTitle,
        url: this.currentUrl,
        fingerprint: null,
        state: null,
        elements: new Map(),
      })
      this._dirty = true
    }

    // Scan immediately on new page
    setTimeout(() => this.scan(), 500)
  }

  onInteraction(element, interactionType) {
    if (!element || !this.currentUrl) return
    try {
      const descriptor = this.describeElement(element)
      if (!descriptor) return
      descriptor.interacted = true
      descriptor.lastInteraction = interactionType
      descriptor.uniqueness = this.computeUniqueness(descriptor)
      this._addToCurrentScreen(descriptor)
    } catch {
      // Never throw — we're in a user event handler
    }
  }

  // ─── Periodic scan ──────────────────────────────────────────────

  scan() {
    if (!this.currentUrl) return
    try {
      // 1. Scan interactive elements
      const elements = document.querySelectorAll(INTERACTIVE_SELECTOR)
      for (const el of elements) {
        if (!this._isVisible(el)) continue
        const descriptor = this.describeElement(el)
        if (!descriptor) continue
        descriptor.uniqueness = this.computeUniqueness(descriptor)
        this._addToCurrentScreen(descriptor)
      }

      // 2. Update screen state & fingerprint
      this._updateScreenState()
    } catch {
      // Never throw
    }
  }

  // ─── Screen state & fingerprint ────────────────────────────────

  _updateScreenState() {
    const screen = this.screens.get(this.currentUrl)
    if (!screen) return

    const state = this._captureScreenState()
    const fingerprint = this._computeFingerprint(state)

    const changed = screen.fingerprint !== fingerprint
    screen.state = state
    screen.fingerprint = fingerprint
    screen.name = state.title || screen.name

    if (changed) this._dirty = true
  }

  /**
   * Capture a rich descriptor of the current page state.
   * Contains everything the AI needs to identify and reason about this screen.
   */
  _captureScreenState() {
    const loc = window.location

    return {
      // ─── URL decomposition
      url: {
        pathname: loc.pathname,
        search: loc.search || null,
        hash: loc.hash || null,
        params: parseSearchParams(loc.search),
      },

      // ─── Page identity
      title: document.title || null,
      h1: getFirst('h1'),
      h2s: getAll('h2', 5),
      meta_description: document.querySelector('meta[name="description"]')?.content || null,

      // ─── Breadcrumb
      breadcrumb: this._extractBreadcrumb(),

      // ─── Landmarks (structural regions)
      landmarks: this._extractLandmarks(),

      // ─── Active component states
      modals: this._extractModals(),
      tabs: this._extractTabs(),
      accordions: this._extractAccordions(),

      // ─── DOM skeleton (structural signature)
      skeleton: this._buildSkeleton(document.body, 0),
    }
  }

  /**
   * Compute a fingerprint hash from the screen state.
   * Combines URL + structural skeleton + component states.
   */
  _computeFingerprint(state) {
    const parts = [
      state.url.pathname,
      state.url.hash || '',
      state.skeleton,
      state.modals.map(m => m.label || m.role || 'modal').join(','),
      state.tabs.map(t => `${t.tablist_label || ''}:${t.active_label || ''}`).join(','),
    ]
    return murmurhash3(parts.join('|'))
  }

  // ─── State extractors ──────────────────────────────────────────

  _extractBreadcrumb() {
    // aria breadcrumb
    const nav = document.querySelector('nav[aria-label*="breadcrumb" i], nav[aria-label*="trilha" i], [role="navigation"][aria-label*="breadcrumb" i], ol.breadcrumb, .breadcrumb')
    if (!nav) return null

    const items = nav.querySelectorAll('li, a, [role="link"]')
    const crumbs = []
    for (const item of items) {
      const text = item.textContent?.trim()
      if (text && text.length <= 60 && !crumbs.includes(text)) crumbs.push(text)
      if (crumbs.length >= 8) break
    }
    return crumbs.length ? crumbs : null
  }

  _extractLandmarks() {
    const landmarks = []
    const seen = new Set()

    const addLandmark = (el, role, source) => {
      const label = el.getAttribute('aria-label') || el.getAttribute('aria-labelledby')
        ? this._resolveAriaLabelledby(el) : null
      const tag = el.tagName.toLowerCase()
      const key = `${role}:${label || tag}`
      if (seen.has(key)) return
      seen.add(key)
      landmarks.push({ role, tag, label, source })
    }

    // Semantic tags
    for (const tag of LANDMARK_TAGS) {
      document.querySelectorAll(tag).forEach(el => {
        if (!this._isVisible(el)) return
        const role = el.getAttribute('role') || IMPLICIT_ROLES[tag] || tag
        addLandmark(el, role, 'tag')
      })
    }

    // Explicit ARIA roles
    for (const role of LANDMARK_ROLES) {
      document.querySelectorAll(`[role="${role}"]`).forEach(el => {
        if (!this._isVisible(el)) return
        addLandmark(el, role, 'aria')
      })
    }

    return landmarks
  }

  _extractModals() {
    const modals = []
    const candidates = document.querySelectorAll(
      'dialog[open], [role="dialog"], [role="alertdialog"], [aria-modal="true"], .modal.show, .modal.open, .modal.active, [data-state="open"][role="dialog"]',
    )

    for (const el of candidates) {
      if (!this._isVisible(el)) continue
      const label = el.getAttribute('aria-label')
        || el.getAttribute('title')
        || el.querySelector('h1, h2, h3, [class*="title"], [class*="header"]')?.textContent?.trim()?.slice(0, 80)
        || null
      const role = el.getAttribute('role') || 'dialog'
      modals.push({ role, label, tag: el.tagName.toLowerCase() })
    }
    return modals
  }

  _extractTabs() {
    const tabGroups = []
    const tablists = document.querySelectorAll('[role="tablist"]')

    for (const tablist of tablists) {
      if (!this._isVisible(tablist)) continue
      const label = tablist.getAttribute('aria-label') || null
      const tabs = tablist.querySelectorAll('[role="tab"]')
      const tabItems = []
      let activeLabel = null

      for (const tab of tabs) {
        const text = tab.textContent?.trim()?.slice(0, 60) || null
        const isActive = tab.getAttribute('aria-selected') === 'true'
          || tab.classList.contains('active')
          || tab.classList.contains('selected')
        tabItems.push({ label: text, active: isActive })
        if (isActive) activeLabel = text
      }

      if (tabItems.length) {
        tabGroups.push({
          tablist_label: label,
          active_label: activeLabel,
          tabs: tabItems,
        })
      }
    }
    return tabGroups
  }

  _extractAccordions() {
    const expanded = []
    const triggers = document.querySelectorAll('[aria-expanded="true"]')

    for (const trigger of triggers) {
      if (!this._isVisible(trigger)) continue
      const text = trigger.textContent?.trim()?.slice(0, 80) || null
      const controlsId = trigger.getAttribute('aria-controls')
      expanded.push({ label: text, controls: controlsId })
    }
    return expanded
  }

  /**
   * Build a lightweight DOM skeleton string for fingerprinting.
   * Walks top-level structure (limited depth), encodes tags + roles.
   */
  _buildSkeleton(node, depth) {
    if (!node || depth > SKELETON_MAX_DEPTH) return ''
    const tag = node.tagName?.toLowerCase()
    if (!tag) return ''

    const role = node.getAttribute?.('role') || ''
    const token = role ? `${tag}[${role}]` : tag

    const childTokens = []
    const children = node.children || []
    let i = 0
    while (i < children.length) {
      const child = children[i]
      const childTag = child.tagName?.toLowerCase()
      if (!childTag || !this._isVisible(child)) { i++; continue }

      // Count consecutive siblings with same tag
      let count = 1
      while (i + count < children.length && children[i + count].tagName?.toLowerCase() === childTag) {
        count++
      }

      if (count >= 3) {
        const childRole = child.getAttribute?.('role') || ''
        childTokens.push(childRole ? `${childTag}[${childRole}]*${count}` : `${childTag}*${count}`)
        i += count
      } else {
        childTokens.push(this._buildSkeleton(child, depth + 1))
        i++
      }
    }

    const inner = childTokens.filter(Boolean).join('+')
    return inner ? `${token}>${inner}` : token
  }

  _resolveAriaLabelledby(element) {
    const ids = element.getAttribute('aria-labelledby')
    if (!ids) return null
    return ids.split(/\s+/)
      .map(id => document.getElementById(id)?.textContent?.trim())
      .filter(Boolean)
      .join(' ')
      .slice(0, MAX_LABEL_LENGTH) || null
  }

  // ─── Snapshot for sync payload ─────────────────────────────────

  getSnapshot() {
    const screens = []
    for (const [url, screen] of this.screens) {
      const elements = Array.from(screen.elements.values())
      if (!elements.length) continue
      screens.push({
        name: screen.name,
        url,
        fingerprint: screen.fingerprint,
        state: screen.state,
        elements,
      })
    }
    return { screens }
  }

  // ─── Element description ────────────────────────────────────────

  describeElement(element) {
    const tag = element.tagName?.toLowerCase()
    if (!tag) return null

    const role = this._computeRole(element, tag)
    const action = this._inferAction(element, tag, role)

    const id = element.id || null
    const name = element.getAttribute('name') || null
    const type = element.getAttribute('type')?.toLowerCase() || null
    const placeholder = element.getAttribute('placeholder') || null
    const testid = element.getAttribute('data-testid') || element.getAttribute('data-test-id') || null
    const title = element.getAttribute('title') || null
    const href = element.getAttribute('href') || null
    const alt = element.getAttribute('alt') || null

    // Only resolve external visible label for form fields (inputs are "mute" — no own text)
    // Buttons, links, tabs already have their name in computed_text
    const isFormField = ['input', 'select', 'textarea'].includes(tag)
    const visibleLabel = isFormField ? this._resolveVisibleLabel(element) : null
    const ariaLabel = element.getAttribute('aria-label') || null
    const ariaLabelledby = element.getAttribute('aria-labelledby') || null
    const computedText = this._getComputedText(element, tag)

    // Must have at least one identifiable trait
    const hasIdentity = visibleLabel || ariaLabel || placeholder || testid || id || computedText
    if (!hasIdentity) return null

    return {
      tag,
      role,
      action,
      attributes: { id, name, type, placeholder, 'data-testid': testid, title, href, alt },
      labels: {
        visible_label: visibleLabel,
        aria_label: ariaLabel,
        aria_labelledby: ariaLabelledby,
        placeholder,
        computed_text: computedText,
      },
      hierarchy: this._resolveHierarchy(element),
      interacted: false,
      lastInteraction: null,
    }
  }

  // ─── Label resolution (browser-native) ──────────────────────────

  _resolveVisibleLabel(element) {
    // 1. Native labels API (works for <label for="id"> and <label> wrappers)
    try {
      if (element.labels?.length > 0) {
        const text = element.labels[0].textContent?.trim()
        if (text && text.length <= MAX_LABEL_LENGTH) return text
      }
    } catch { /* labels not supported on this element */ }

    // 2. aria-labelledby — resolve referenced elements
    const labelledBy = element.getAttribute('aria-labelledby')
    if (labelledBy) {
      const parts = labelledBy.split(/\s+/)
        .map(id => document.getElementById(id)?.textContent?.trim())
        .filter(Boolean)
      if (parts.length) return parts.join(' ').slice(0, MAX_LABEL_LENGTH)
    }

    // 3. aria-label
    const ariaLabel = element.getAttribute('aria-label')
    if (ariaLabel) return ariaLabel

    // 4. Previous sibling with short text (div/span as visual label)
    const prev = element.previousElementSibling
    if (prev && !this._isInteractive(prev)) {
      const text = prev.textContent?.trim()
      if (text && text.length > 0 && text.length <= MAX_TEXT_LENGTH) return text
    }

    // 5. Walk parent chain — check previous sibling of each ancestor
    let parent = element.parentElement
    for (let depth = 0; parent && depth < 3; depth++) {
      const prevParent = parent.previousElementSibling
      if (prevParent && !this._isInteractive(prevParent)) {
        const text = prevParent.textContent?.trim()
        if (text && text.length > 0 && text.length <= MAX_TEXT_LENGTH) return text
      }
      parent = parent.parentElement
    }

    return null
  }

  _getComputedText(element, tag) {
    // For buttons, links, tabs — the visible text IS the accessible name
    if (['button', 'a', 'summary'].includes(tag) || element.getAttribute('role') === 'tab') {
      const text = element.textContent?.trim()
      return text?.slice(0, MAX_LABEL_LENGTH) || null
    }
    // For images
    if (tag === 'img') return element.getAttribute('alt') || null
    return null
  }

  // ─── Role computation ──────────────────────────────────────────

  _computeRole(element, tag) {
    const explicit = element.getAttribute('role')
    if (explicit) return explicit

    if (tag === 'input') {
      const type = element.getAttribute('type')?.toLowerCase() || 'text'
      return INPUT_ROLE_MAP[type] || 'textbox'
    }

    return IMPLICIT_ROLES[tag] || null
  }

  _inferAction(element, tag, role) {
    if (role && ROLE_ACTION_MAP[role]) return ROLE_ACTION_MAP[role]
    if (['input', 'textarea'].includes(tag)) return 'fill'
    if (tag === 'select') return 'select'
    if (['button', 'a', 'summary'].includes(tag)) return 'click'
    return 'interact'
  }

  // ─── Hierarchy ─────────────────────────────────────────────────

  _resolveHierarchy(element) {
    const parent = element.parentElement
    const parentTag = parent?.tagName?.toLowerCase() || null
    const parentRole = parent?.getAttribute('role') || null

    // Find nearest ancestor landmark
    let ancestor = parent
    let ancestorLandmark = null
    while (ancestor) {
      const tag = ancestor.tagName?.toLowerCase()
      const role = ancestor.getAttribute('role')
      if (LANDMARK_TAGS.has(tag) || LANDMARK_ROLES.has(role)) {
        ancestorLandmark = role || tag
        break
      }
      ancestor = ancestor.parentElement
    }

    return { parent_tag: parentTag, parent_role: parentRole, ancestor_landmark: ancestorLandmark }
  }

  // ─── Uniqueness (live DOM queries) ─────────────────────────────

  computeUniqueness(descriptor) {
    const uniqueBy = []
    let matchCount = 1

    // Test id uniqueness
    if (descriptor.attributes.id) {
      try {
        const count = document.querySelectorAll(`[id="${CSS.escape(descriptor.attributes.id)}"]`).length
        if (count === 1) uniqueBy.push('id')
      } catch { /* invalid selector */ }
    }

    // Test data-testid uniqueness
    if (descriptor.attributes['data-testid']) {
      try {
        const count = document.querySelectorAll(`[data-testid="${CSS.escape(descriptor.attributes['data-testid'])}"]`).length
        if (count === 1) uniqueBy.push('data-testid')
      } catch { /* */ }
    }

    // Test label uniqueness
    if (descriptor.labels.visible_label) {
      try {
        const allLabels = document.querySelectorAll('label')
        const sameLabel = Array.from(allLabels).filter(
          l => l.textContent?.trim() === descriptor.labels.visible_label,
        ).length
        if (sameLabel <= 1) uniqueBy.push('label')
      } catch { /* */ }
    }

    // Test placeholder uniqueness
    if (descriptor.attributes.placeholder) {
      try {
        const count = document.querySelectorAll(
          `[placeholder="${CSS.escape(descriptor.attributes.placeholder)}"]`,
        ).length
        if (count === 1) uniqueBy.push('placeholder')
      } catch { /* */ }
    }

    // Test role+name uniqueness
    if (descriptor.role && descriptor.labels.computed_text) {
      try {
        const roleSelector = `[role="${descriptor.role}"]`
        const implicitTag = Object.entries(IMPLICIT_ROLES).find(([, r]) => r === descriptor.role)?.[0]
        const selectors = [roleSelector]
        if (implicitTag) selectors.push(implicitTag)
        const candidates = document.querySelectorAll(selectors.join(', '))
        const sameNameCount = Array.from(candidates).filter(
          el => el.textContent?.trim() === descriptor.labels.computed_text,
        ).length
        matchCount = sameNameCount
        if (sameNameCount === 1) uniqueBy.push('role+name')
      } catch { /* */ }
    }

    return {
      is_unique: uniqueBy.length > 0,
      match_count: matchCount,
      unique_by: uniqueBy,
    }
  }

  // ─── Internal helpers ──────────────────────────────────────────

  _addToCurrentScreen(descriptor) {
    const screen = this.screens.get(this.currentUrl)
    if (!screen) return

    // Dedup key: role + best name
    const name = descriptor.labels.visible_label
      || descriptor.labels.aria_label
      || descriptor.labels.placeholder
      || descriptor.labels.computed_text
      || descriptor.attributes['data-testid']
      || ''
    const key = `${descriptor.role || descriptor.tag}::${name}::${descriptor.action}`

    const existing = screen.elements.get(key)
    if (existing) {
      // Merge: prefer interacted over scanned, update uniqueness
      if (descriptor.interacted && !existing.interacted) {
        screen.elements.set(key, { ...existing, ...descriptor })
        this._dirty = true
      } else {
        // Update uniqueness if newer
        existing.uniqueness = descriptor.uniqueness
      }
    } else {
      screen.elements.set(key, descriptor)
      this._dirty = true
    }
  }

  _isVisible(element) {
    if (element.hidden) return false
    if (element.getAttribute('aria-hidden') === 'true') return false
    const style = element.style
    if (style?.display === 'none') return false
    if (style?.visibility === 'hidden') return false
    // Check offsetParent — null means element is not rendered (except for fixed/body)
    if (!element.offsetParent && element.tagName !== 'BODY' && getComputedStyle(element).position !== 'fixed') return false
    return true
  }

  _isInteractive(element) {
    const tag = element.tagName?.toLowerCase()
    return ['input', 'select', 'textarea', 'button', 'a'].includes(tag)
  }
}

// ─── Utilities ──────────────────────────────────────────────────

function normalizeUrl(url) {
  try {
    const u = new URL(url)
    return u.pathname + u.hash.split('?')[0] || '/'
  } catch {
    return url?.slice(0, 100) || '/'
  }
}

function parseSearchParams(search) {
  if (!search) return null
  try {
    const params = {}
    const sp = new URLSearchParams(search)
    for (const [k, v] of sp) params[k] = v
    return Object.keys(params).length ? params : null
  } catch {
    return null
  }
}

function getFirst(selector) {
  const el = document.querySelector(selector)
  return el?.textContent?.trim()?.slice(0, 120) || null
}

function getAll(selector, max) {
  const els = document.querySelectorAll(selector)
  const results = []
  for (let i = 0; i < els.length && results.length < max; i++) {
    const text = els[i].textContent?.trim()?.slice(0, 120)
    if (text) results.push(text)
  }
  return results.length ? results : null
}
