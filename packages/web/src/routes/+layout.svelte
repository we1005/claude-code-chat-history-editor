<script lang="ts">
  import '../app.css'
  import { onMount } from 'svelte'
  import { goto } from '$app/navigation'
  import { page } from '$app/state'
  import { base } from '$app/paths'
  import type { Snippet } from 'svelte'
  import { provideSessionContext } from '@claude-sessions/ui'
  import * as api from '$lib/api'
  import { appConfig } from '$lib/stores/config'
  import { initTheme, toggleTheme, effectiveTheme, themePreference } from '$lib/stores/theme'
  import { ConfirmModal, Toast } from '$lib/components'
  import Icon from '$lib/components/Icon.svelte'
  import { sidebarOpen, toggleSidebar, initWorkspace } from '$lib/stores/workspace'

  let { children }: { children: Snippet } = $props()
  let searchInput: HTMLInputElement | undefined = $state()
  let searchDropdown: HTMLDivElement | undefined = $state()
  onMount(initWorkspace)

  function workspaceKeydown(event: KeyboardEvent) {
    if (
      (event.metaKey || event.ctrlKey) &&
      event.key.toLowerCase() === 'k' &&
      !document.querySelector('[role="dialog"]')
    ) {
      event.preventDefault()
      searchInput?.focus()
      searchInput?.select()
    }
    if (event.key === 'Escape') {
      showSearchDropdown = false
      ++searchVersion
      searchingTitle = false
      searchingContent = false
      if (window.matchMedia('(max-width: 899px)').matches) sidebarOpen.set(false)
    }
  }

  function searchKeydown(event: KeyboardEvent) {
    if (event.key === 'Enter' && searchResults[0]) {
      event.preventDefault()
      selectSearchResult(searchResults[0])
      return
    }
    if (event.key === 'ArrowDown' && searchResults.length) {
      event.preventDefault()
      showSearchDropdown = true
      requestAnimationFrame(() =>
        searchDropdown?.querySelector<HTMLButtonElement>('button')?.focus()
      )
    }
  }

  function resultKeydown(event: KeyboardEvent, index: number) {
    if (!['ArrowDown', 'ArrowUp', 'Escape'].includes(event.key)) return
    event.preventDefault()
    if (event.key === 'Escape') {
      showSearchDropdown = false
      searchInput?.focus()
      return
    }
    const buttons = searchDropdown?.querySelectorAll<HTMLButtonElement>('[data-search-result]')
    if (buttons?.length)
      buttons[
        (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length
      ]?.focus()
  }

  // Provide @claude-sessions/ui shared components with web-side adapters.
  // The vscode-extension webview supplies a different provider built on
  // postMessage RPC; the contract (SessionApi/SessionStorage) is the same.
  provideSessionContext({
    api: {
      openFile: (filePath) => api.openFile(filePath),
      checkFileExists: (filePath) => api.checkFileExists(filePath),
    },
    storage: {
      get: (key) => (typeof window === 'undefined' ? null : localStorage.getItem(key)),
      set: (key, value) => {
        if (typeof window !== 'undefined') localStorage.setItem(key, value)
      },
    },
  })

  // Check if we're on a session page for search context
  const isSessionPage = $derived(page.url.pathname.startsWith('/session/'))

  // Convert project name to display path (e.g., "-Users-david-works--vscode" -> "~/works/.vscode")
  const formatProjectPath = (projectName: string): string => {
    // Replace -- with a placeholder, then - with /, then restore .
    const placeholder = '___DOT___'
    let path = projectName
      .replace(/--/g, placeholder) // Double dash -> placeholder for dot
      .replace(/-/g, '/') // Single dash -> slash
      .replace(new RegExp(placeholder, 'g'), '/.') // Restore dots (add slash before)
    // Convert /Users/username/... to ~/...
    const homeMatch = path.match(/^\/Users\/[^/]+\/(.+)$/)
    if (homeMatch) return `~/${homeMatch[1]}`
    return path
  }
  const currentSessionInfo = $derived.by(() => {
    if (!isSessionPage) return null
    const match = page.url.pathname.match(/^\/session\/([^/]+)\/([^/]+)/)
    if (!match) return null
    return { projectName: decodeURIComponent(match[1]), sessionId: decodeURIComponent(match[2]) }
  })

  let version = $state('')
  let cleaning = $state(false)
  let shuttingDown = $state(false)
  let showCleanupModal = $state(false)
  let cleanupPreview = $state<api.CleanupPreview[] | null>(null)
  let cleanupResult = $state<{
    success: boolean
    deletedCount: number
    removedMessageCount: number
    deletedOrphanAgentCount: number
    deletedOrphanTodoCount: number
  } | null>(null)

  // Toast for alerts
  let toastMessage = $state<string | null>(null)
  let toastVariant = $state<'success' | 'error' | 'info' | 'warning'>('info')

  // Confirm modal state
  let confirmModal = $state<{
    show: boolean
    title: string
    message: string
    variant: 'danger' | 'default'
    onConfirm: () => void
  }>({
    show: false,
    title: '',
    message: '',
    variant: 'default',
    onConfirm: () => {},
  })

  const showToast = (
    message: string,
    variant: 'success' | 'error' | 'info' | 'warning' = 'info'
  ) => {
    toastMessage = message
    toastVariant = variant
  }

  const showConfirm = (
    title: string,
    message: string,
    onConfirm: () => void,
    variant: 'danger' | 'default' = 'default'
  ) => {
    confirmModal = { show: true, title, message, variant, onConfirm }
  }

  const closeConfirm = () => {
    confirmModal = { ...confirmModal, show: false }
  }

  // Search state
  let searchQuery = $state('')
  let searchResults = $state<api.SearchResult[]>([])
  let searchingTitle = $state(false)
  let searchingContent = $state(false)
  let showSearchDropdown = $state(false)
  let searchDebounceTimer: ReturnType<typeof setTimeout> | null = null
  let searchVersion = 0
  let searchError = $state('')
  let completedQuery = ''
  $effect(() => {
    if (!showSearchDropdown) return
    const outside = (event: PointerEvent) => {
      if (event.target !== searchInput && !searchDropdown?.contains(event.target as Node))
        showSearchDropdown = false
    }
    document.addEventListener('pointerdown', outside)
    return () => document.removeEventListener('pointerdown', outside)
  })

  // Cleanup options
  let clearEmpty = $state(true)
  let skipWithTodos = $state(true)
  let clearOrphanAgents = $state(true)
  let clearOrphanTodos = $state(false)

  // Computed totals
  let totalEmpty = $derived(
    cleanupPreview?.reduce((sum, p) => sum + p.emptySessions.length, 0) ?? 0
  )
  let totalWithTodos = $derived(
    cleanupPreview?.reduce((sum, p) => sum + p.emptyWithTodosCount, 0) ?? 0
  )
  let totalOrphanAgents = $derived(
    cleanupPreview?.reduce((sum, p) => sum + p.orphanAgentCount, 0) ?? 0
  )
  let totalOrphanTodos = $derived(
    cleanupPreview?.reduce((sum, p) => sum + p.orphanTodoCount, 0) ?? 0
  )
  let effectiveDeleteCount = $derived(skipWithTodos ? totalEmpty - totalWithTodos : totalEmpty)

  onMount(() => {
    return initTheme()
  })

  onMount(async () => {
    try {
      const res = await api.getVersion()
      version = res.version
      appConfig.set({
        version: res.version,
        homeDir: res.homeDir,
        currentProjectName: res.currentProjectName,
      })
    } catch {
      version = 'unknown'
    }
  })

  const handleShutdown = () => {
    showConfirm(
      'Shutdown',
      'Shutdown the server?',
      async () => {
        closeConfirm()
        shuttingDown = true
        try {
          await api.shutdown()
        } catch {
          // Server is shutting down, connection will be lost
        }
      },
      'danger'
    )
  }

  const openCleanupModal = async () => {
    try {
      cleanupPreview = await api.previewCleanup()
      showCleanupModal = true
    } catch (e) {
      showToast(`Error: ${e}`, 'error')
    }
  }

  const closeCleanupModal = () => {
    showCleanupModal = false
    cleanupPreview = null
  }

  const executeCleanup = async () => {
    if (effectiveDeleteCount === 0 && !clearOrphanAgents && !clearOrphanTodos) {
      showToast('Nothing to clean up', 'warning')
      return
    }

    cleaning = true
    try {
      cleanupResult = await api.clearSessions({
        clearEmpty,
        clearInvalid: false,
        skipWithTodos,
        clearOrphanAgents,
        clearOrphanTodos,
      })
      showCleanupModal = false
      cleanupPreview = null
      setTimeout(() => {
        cleanupResult = null
        window.location.reload()
      }, 2000)
    } catch (e) {
      showToast(`Error: ${e}`, 'error')
    } finally {
      cleaning = false
    }
  }

  // Search functions
  const handleSearchInput = (e: Event) => {
    const query = (e.target as HTMLInputElement).value
    searchQuery = query
    const version = ++searchVersion
    searchResults = []
    searchError = ''
    searchingContent = false
    searchingTitle = false

    if (searchDebounceTimer) clearTimeout(searchDebounceTimer)

    if (!query.trim()) {
      searchResults = []
      showSearchDropdown = false
      return
    }

    // Debounce: search after 300ms of no typing
    searchingTitle = true
    showSearchDropdown = true
    searchDebounceTimer = setTimeout(() => performSearch(query, version), 300)
  }

  // Sort results to prioritize current session when on session page
  const sortResultsWithCurrentSession = (results: api.SearchResult[]): api.SearchResult[] => {
    const sessionInfo = currentSessionInfo
    if (!sessionInfo) return results

    return [...results].sort((a, b) => {
      const aIsCurrent =
        a.projectName === sessionInfo.projectName && a.sessionId === sessionInfo.sessionId
      const bIsCurrent =
        b.projectName === sessionInfo.projectName && b.sessionId === sessionInfo.sessionId
      if (aIsCurrent && !bIsCurrent) return -1
      if (!aIsCurrent && bIsCurrent) return 1
      return 0
    })
  }

  const performSearch = async (query: string, version: number) => {
    if (!query.trim() || version !== searchVersion) return

    const sessionInfo = currentSessionInfo

    // Phase 1: Title search (fast) - prioritize current session's project
    searchingTitle = true
    try {
      const titleResults = await api.searchSessions(query, {
        searchContent: false,
        project: sessionInfo?.projectName,
      })
      if (version !== searchVersion) return
      searchResults = sortResultsWithCurrentSession(titleResults)
      completedQuery = query
    } catch (e) {
      if (version === searchVersion) searchError = '搜索失败，请稍后重试。'
    } finally {
      if (version === searchVersion) searchingTitle = false
    }
  }

  // Whole-transcript searches can be expensive; run only when explicitly chosen.
  const performContentSearch = async () => {
    const query = searchQuery
    const version = searchVersion
    if (!query.trim() || searchingContent) return
    searchError = ''
    searchingContent = true
    try {
      const allResults = await api.searchSessions(query, { searchContent: true })
      if (version !== searchVersion) return
      // Merge results, keeping title matches first
      const existingIds = new Set(searchResults.map((r) => `${r.projectName}:${r.sessionId}`))
      const newResults = allResults.filter(
        (r) => !existingIds.has(`${r.projectName}:${r.sessionId}`)
      )
      searchResults = sortResultsWithCurrentSession([...searchResults, ...newResults])
    } catch (e) {
      if (version === searchVersion) searchError = '内容搜索失败，请稍后重试。'
    } finally {
      if (version === searchVersion) searchingContent = false
    }
  }

  const selectSearchResult = (result: api.SearchResult) => {
    ++searchVersion
    searchingTitle = false
    searchingContent = false
    searchQuery = ''
    searchResults = []
    showSearchDropdown = false
    // Use path-based routing for proper navigation
    goto(`/#${new URLSearchParams({ project: result.projectName, session: result.sessionId })}`)
  }

  const closeSearchDropdown = () => {
    // Delay to allow click on result
    setTimeout(() => {
      if (
        !searchDropdown?.contains(document.activeElement) &&
        document.activeElement !== searchInput
      )
        showSearchDropdown = false
    }, 200)
  }
</script>

<svelte:window onkeydown={workspaceKeydown} />

<svelte:head>
  <title>Claude Code Chat History Editor</title>
</svelte:head>

<div class="studio-shell bg-gh-bg text-gh-text">
  <header class="studio-topbar">
    <div class="studio-brand">
      {#if !isSessionPage}
        <button
          class="quiet-button"
          onclick={toggleSidebar}
          aria-label={$sidebarOpen ? '收起项目侧栏' : '打开项目侧栏'}
          aria-expanded={$sidebarOpen}
          title="项目侧栏"><Icon name="panel" /></button
        >
      {/if}
      <a
        href={currentSessionInfo
          ? `/#${new URLSearchParams({ project: currentSessionInfo.projectName, session: currentSessionInfo.sessionId })}`
          : '/'}
        class="flex items-center gap-2 hover:text-gh-accent"
        title={currentSessionInfo ? '返回工作台' : 'Claude History Editor'}
      >
        <img src={`${base}/favicon.svg?v=2`} alt="" />
        <span class="studio-brand-name">Claude History</span>
      </a>
      {#if version}
        <span class="studio-version">v{version}</span>
      {/if}
      <button
        onclick={toggleTheme}
        class="p-1.5 rounded-md text-gh-text-secondary hover:text-gh-text hover:bg-gh-border-subtle transition-colors"
        title="Theme: {$themePreference} ({$effectiveTheme})"
      >
        {#if $effectiveTheme === 'light'}
          <!-- Sun icon -->
          <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path
              stroke-linecap="round"
              stroke-linejoin="round"
              stroke-width="2"
              d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.364 6.364l-.707-.707M6.343 6.343l-.707-.707m12.728 0l-.707.707M6.343 17.657l-.707.707M16 12a4 4 0 11-8 0 4 4 0 018 0z"
            />
          </svg>
        {:else if $themePreference === 'system'}
          <!-- Monitor icon -->
          <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path
              stroke-linecap="round"
              stroke-linejoin="round"
              stroke-width="2"
              d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"
            />
          </svg>
        {:else}
          <!-- Moon icon -->
          <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path
              stroke-linecap="round"
              stroke-linejoin="round"
              stroke-width="2"
              d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z"
            />
          </svg>
        {/if}
      </button>
    </div>

    <!-- Search -->
    <div class="studio-search">
      <span class="studio-search-icon"><Icon name="search" size={16} /></span>
      <input
        bind:this={searchInput}
        type="text"
        placeholder="搜索会话或 ID…"
        aria-label="搜索会话或 ID"
        value={searchQuery}
        oninput={handleSearchInput}
        onfocus={() => {
          if (searchQuery.trim()) {
            showSearchDropdown = true
            if (completedQuery !== searchQuery && !searchingTitle)
              void performSearch(searchQuery, ++searchVersion)
          }
        }}
        onblur={closeSearchDropdown}
        onkeydown={searchKeydown}
        class="w-full px-4 py-2 bg-gh-bg border border-gh-border rounded-md text-sm focus:outline-none focus:border-gh-accent"
      />
      {#if !searchingTitle && !searchingContent}<kbd>⌘ K</kbd>{/if}
      {#if searchingTitle || searchingContent}
        <div class="absolute right-3 top-1/2 -translate-y-1/2">
          <svg class="animate-spin h-4 w-4 text-gh-text-secondary" viewBox="0 0 24 24">
            <circle
              class="opacity-25"
              cx="12"
              cy="12"
              r="10"
              stroke="currentColor"
              stroke-width="4"
              fill="none"
            />
            <path
              class="opacity-75"
              fill="currentColor"
              d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
            />
          </svg>
        </div>
      {/if}

      <!-- Search Dropdown -->
      {#if showSearchDropdown && searchQuery.trim()}
        <div
          bind:this={searchDropdown}
          class="absolute top-full left-0 right-0 mt-1 bg-gh-bg-secondary border border-gh-border rounded-md shadow-lg max-h-80 overflow-y-auto z-50"
        >
          {#if searchError}<div role="alert" class="px-4 py-3 text-sm text-gh-red">
              {searchError}
            </div>{/if}
          {#if searchResults.length === 0 && searchingTitle}
            <div role="status" class="px-4 py-3 text-sm text-gh-text-secondary">正在搜索会话…</div>
          {:else if searchResults.length === 0}
            <div role="status" class="px-4 py-3 text-sm text-gh-text-secondary">
              没有匹配的会话，可尝试搜索消息内容。
            </div>
          {:else}
            {#each searchResults as result, index}
              <button
                data-search-result
                class="w-full text-left px-4 py-2 hover:bg-gh-border-subtle border-b border-gh-border last:border-b-0"
                onclick={() => selectSearchResult(result)}
                onkeydown={(event) => resultKeydown(event, index)}
                onblur={closeSearchDropdown}
              >
                <div class="flex items-center gap-2">
                  <span
                    class="text-xs px-1.5 py-0.5 rounded {result.matchType === 'sessionId'
                      ? 'bg-gh-accent/20 text-gh-accent font-mono'
                      : result.matchType === 'title'
                        ? 'bg-gh-green/20 text-gh-green'
                        : 'bg-gh-accent/20 text-gh-accent'}"
                  >
                    {result.matchType === 'sessionId'
                      ? 'ID'
                      : result.matchType === 'title'
                        ? 'Title'
                        : 'Content'}
                  </span>
                  <span class="text-xs text-gh-text-secondary truncate flex-shrink-0 max-w-[120px]"
                    >{formatProjectPath(result.projectName)}</span
                  >
                  <span class="text-sm font-medium truncate">{result.title}</span>
                </div>
                {#if result.matchType === 'sessionId'}
                  <div class="text-xs text-gh-text-secondary mt-1 font-mono truncate">
                    {result.sessionId}
                  </div>
                {:else if result.snippet}
                  <div class="text-xs text-gh-text-secondary mt-1 line-clamp-2">
                    {result.snippet}
                  </div>
                {/if}
              </button>
            {/each}
          {/if}
          <button
            class="w-full px-4 py-3 text-left text-xs text-gh-accent border-t border-gh-border hover:bg-gh-bg disabled:opacity-60"
            disabled={searchingContent || searchingTitle}
            onclick={() => void performContentSearch()}
            onblur={closeSearchDropdown}
          >
            <Icon name="search" size={13} class="mr-1" />{searchingContent
              ? '正在搜索完整消息内容…'
              : '搜索消息内容'}
          </button>
        </div>
      {/if}
    </div>

    <div class="studio-tools">
      <button
        class="quiet-button disabled:opacity-50"
        onclick={openCleanupModal}
        disabled={cleaning}
        aria-label="清理会话"
      >
        <Icon name="archive" size={16} /><span class="control-label"
          >{cleaning ? '清理中…' : '清理'}</span
        >
      </button>
      <button
        class="quiet-button danger disabled:opacity-50"
        onclick={handleShutdown}
        disabled={shuttingDown}
        aria-label="关闭服务"
      >
        <Icon name="power" size={16} /><span class="control-label"
          >{shuttingDown ? '关闭中…' : '关闭服务'}</span
        >
      </button>
    </div>
  </header>

  <main class="studio-main">
    {@render children()}
  </main>
</div>

<!-- Cleanup Modal -->
{#if showCleanupModal && cleanupPreview}
  <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
  <!-- svelte-ignore a11y_interactive_supports_focus -->
  <div
    class="fixed inset-0 bg-black/50 flex items-center justify-center z-50"
    onclick={(e) => e.target === e.currentTarget && closeCleanupModal()}
    onkeydown={(e) => e.key === 'Escape' && closeCleanupModal()}
    role="dialog"
    aria-modal="true"
    aria-labelledby="cleanup-modal-title"
  >
    <div
      class="bg-gh-bg-secondary border border-gh-border rounded-lg p-6 w-[400px] shadow-xl text-gh-text"
    >
      <h2 id="cleanup-modal-title" class="text-lg font-semibold mb-4">Cleanup Options</h2>

      <div class="space-y-3 text-gh-text">
        <!-- Clear Empty Sessions -->
        <label class="flex items-center gap-3 cursor-pointer">
          <input
            type="checkbox"
            bind:checked={clearEmpty}
            class="w-4 h-4 rounded border-gh-border bg-gh-bg text-gh-green focus:ring-gh-green"
          />
          <span class="flex-1">
            Delete empty sessions
            <span class="text-gh-text-secondary">({totalEmpty})</span>
          </span>
        </label>

        <!-- Preserve With Todos (indented, disabled if clearEmpty is false) -->
        <label class="flex items-center gap-3 cursor-pointer ml-6" class:opacity-50={!clearEmpty}>
          <input
            type="checkbox"
            bind:checked={skipWithTodos}
            disabled={!clearEmpty}
            class="w-4 h-4 rounded border-gh-border bg-gh-bg text-gh-green focus:ring-gh-green disabled:opacity-50"
          />
          <span class="flex-1">
            Preserve sessions with todos
            <span class="text-gh-text-secondary"
              >({totalWithTodos > 0 ? `-${totalWithTodos}` : '0'})</span
            >
          </span>
        </label>

        <!-- Clear Orphan Agents -->
        <label class="flex items-center gap-3 cursor-pointer">
          <input
            type="checkbox"
            bind:checked={clearOrphanAgents}
            class="w-4 h-4 rounded border-gh-border bg-gh-bg text-gh-green focus:ring-gh-green"
          />
          <span class="flex-1">
            Delete orphan agents
            <span class="text-gh-text-secondary">({totalOrphanAgents})</span>
          </span>
        </label>

        <!-- Clear Orphan Todos -->
        <label class="flex items-center gap-3 cursor-pointer">
          <input
            type="checkbox"
            bind:checked={clearOrphanTodos}
            class="w-4 h-4 rounded border-gh-border bg-gh-bg text-gh-green focus:ring-gh-green"
          />
          <span class="flex-1">
            Delete orphan todos
            <span class="text-gh-text-secondary">({totalOrphanTodos})</span>
          </span>
        </label>
      </div>

      <!-- Summary -->
      <div class="mt-4 pt-4 border-t border-gh-border text-sm text-gh-text-secondary">
        {#if clearEmpty}
          Will delete {effectiveDeleteCount} session{effectiveDeleteCount !== 1 ? 's' : ''}
          {#if skipWithTodos && totalWithTodos > 0}
            (skipping {totalWithTodos} with todos)
          {/if}
        {/if}
        {#if clearOrphanAgents && totalOrphanAgents > 0}
          {#if clearEmpty},{/if}
          {totalOrphanAgents} orphan agent{totalOrphanAgents !== 1 ? 's' : ''}
        {/if}
        {#if clearOrphanTodos && totalOrphanTodos > 0}
          {#if clearEmpty || clearOrphanAgents},{/if}
          {totalOrphanTodos} orphan todo{totalOrphanTodos !== 1 ? 's' : ''}
        {/if}
        {#if !clearEmpty && !clearOrphanAgents && !clearOrphanTodos}
          Nothing selected
        {/if}
      </div>

      <!-- Buttons -->
      <div class="flex gap-2 mt-6 justify-end">
        <button
          class="px-4 py-2 text-sm rounded-md border border-gh-border hover:bg-gh-border-subtle"
          onclick={closeCleanupModal}
        >
          Cancel
        </button>
        <button
          class="px-4 py-2 text-sm rounded-md bg-gh-red text-white hover:bg-red-700 disabled:opacity-50"
          onclick={executeCleanup}
          disabled={cleaning ||
            (effectiveDeleteCount === 0 && !clearOrphanAgents && !clearOrphanTodos)}
        >
          {cleaning ? 'Cleaning...' : 'Execute Cleanup'}
        </button>
      </div>
    </div>
  </div>
{/if}

{#if cleanupResult}
  <div class="fixed bottom-4 right-4 bg-gh-green text-white px-5 py-3 rounded-md text-sm z-50">
    {#if cleanupResult.removedMessageCount > 0}
      Removed {cleanupResult.removedMessageCount} invalid messages.
    {/if}
    {#if cleanupResult.deletedCount > 0}
      Deleted {cleanupResult.deletedCount} empty sessions.
    {/if}
    {#if cleanupResult.deletedOrphanAgentCount > 0}
      Deleted {cleanupResult.deletedOrphanAgentCount} orphan agents.
    {/if}
    {#if cleanupResult.deletedOrphanTodoCount > 0}
      Deleted {cleanupResult.deletedOrphanTodoCount} orphan todos.
    {/if}
  </div>
{/if}

<ConfirmModal
  show={confirmModal.show}
  title={confirmModal.title}
  message={confirmModal.message}
  variant={confirmModal.variant}
  onConfirm={confirmModal.onConfirm}
  onCancel={closeConfirm}
/>

<Toast bind:message={toastMessage} variant={toastVariant} />
