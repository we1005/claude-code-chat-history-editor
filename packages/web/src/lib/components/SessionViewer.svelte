<script lang="ts">
  import {
    deleteMessageWithChainRepair,
    validateChain,
    validateProgressMessages,
  } from '@claude-sessions/core'
  import type { AgentInfo, Message, SessionMeta, TodoItem } from '$lib/api'
  import * as api from '$lib/api'
  import { getDisplayTitle } from '$lib/utils'
  import { onDestroy, tick } from 'svelte'
  import Icon from './Icon.svelte'
  import { sidebarOpen } from '$lib/stores/workspace'
  import HistoryMessageEditor from './HistoryMessageEditor.svelte'
  import MessageFilter from './MessageFilter.svelte'
  import MessageList from './MessageList.svelte'
  import ScrollButtons from './ScrollButtons.svelte'
  import ValidationBadge from './ValidationBadge.svelte'
  import CommandTitle from './CommandTitle.svelte'
  import SessionActions from './SessionActions.svelte'
  import SessionSearchResults from './SessionSearchResults.svelte'
  import {
    indexSessionMessages,
    searchSessionMessages,
    recordKeys,
    type SessionSearchHit,
  } from '$lib/utils/session-search'
  import {
    ALL_MESSAGE_CATEGORIES,
    getMessageCategory,
    DEFAULT_VISIBLE_CATEGORIES,
    type MessageCategory,
  } from '$lib/utils'

  // Tab type - messages, todos, or agent:<agentId>
  type TabType = 'messages' | 'todos' | `agent:${string}`

  interface Props {
    session: SessionMeta | null
    messages: Message[]
    todos?: TodoItem[]
    agents?: AgentInfo[]
    customTitle?: string
    projectDisplayName?: string
    backUrl?: string // If provided, shows back button header
    onDeleteMessage?: (msg: Message) => void // Called after actual deletion
    onMessagesChange?: (messages: Message[]) => void // Called when messages array changes
    onRefresh?: () => Promise<void> // Called to refresh messages from server
    onEditTitle?: (msg: Message) => void
    onSplitSession?: (msg: Message) => void
    onCompressSession?: () => void
    onRenameSession?: () => void
    onResumeSession?: () => void
    onDeleteSession?: () => void
    enableScroll?: boolean
    externalScrollContainer?: HTMLElement | null
    fullWidth?: boolean
    loading?: boolean
    loadError?: string
  }

  let {
    session,
    messages,
    todos = [],
    agents = [],
    customTitle,
    backUrl,
    onDeleteMessage,
    onMessagesChange,
    onRefresh,
    onEditTitle,
    onSplitSession,
    onCompressSession,
    onRenameSession,
    onResumeSession,
    onDeleteSession,
    enableScroll = true,
    externalScrollContainer = null,
    fullWidth = false,
    loading = false,
    loadError = '',
  }: Props = $props()

  const displayTitle = $derived(
    getDisplayTitle({
      customTitle,
      title: session?.title,
    })
  )

  // Validation (logging is done server-side in /api/session)
  const chainResult = $derived(validateChain(messages as Parameters<typeof validateChain>[0]))
  const progressResult = $derived(
    validateProgressMessages(messages as Parameters<typeof validateProgressMessages>[0])
  )
  let isRepairing = $state(false)

  // Message type filter with localStorage persistence
  const FILTER_STORAGE_KEY = 'claudeSessionsMessageTypeFilter'
  const getInitialVisibleCategories = (): Set<MessageCategory> => {
    if (typeof window === 'undefined') return new Set(DEFAULT_VISIBLE_CATEGORIES)
    const stored = localStorage.getItem(FILTER_STORAGE_KEY)
    if (stored === null) return new Set(DEFAULT_VISIBLE_CATEGORIES)
    try {
      const parsed = JSON.parse(stored)
      if (!Array.isArray(parsed)) return new Set(DEFAULT_VISIBLE_CATEGORIES)
      const valid = parsed.filter(
        (c): c is MessageCategory =>
          typeof c === 'string' && ALL_MESSAGE_CATEGORIES.includes(c as MessageCategory)
      )
      return new Set(valid)
    } catch {
      return new Set(DEFAULT_VISIBLE_CATEGORIES)
    }
  }
  let visibleCategories = $state<Set<MessageCategory>>(getInitialVisibleCategories())
  $effect(() => {
    if (typeof window !== 'undefined') {
      localStorage.setItem(FILTER_STORAGE_KEY, JSON.stringify([...visibleCategories]))
    }
  })

  const filteredMessages = $derived(
    messages.filter((m) => visibleCategories.has(getMessageCategory(m)))
  )

  const handleFilterToggle = (category: MessageCategory) => {
    const next = new Set(visibleCategories)
    if (next.has(category)) {
      next.delete(category)
    } else {
      next.add(category)
    }
    visibleCategories = next
  }

  const handleFilterReset = () => {
    visibleCategories = new Set(DEFAULT_VISIBLE_CATEGORIES)
  }

  const handleRepairChain = async () => {
    if (!session || isRepairing) return
    isRepairing = true
    try {
      const result = await api.repairChain(session.projectName, session.id)
      if (result.success && result.repairCount > 0) {
        // Refresh messages from server
        await syncFromServer()
      }
    } catch (e) {
      console.error('Failed to repair chain:', e)
    } finally {
      isRepairing = false
    }
  }

  const handleRepairProgress = async () => {
    if (!session || isRepairing) return
    isRepairing = true
    try {
      // Delete each progress message with chain repair
      for (const error of progressResult.errors) {
        const msg = messages[error.line - 1]
        if (msg?.uuid) {
          await api.deleteMessage(session.projectName, session.id, msg.uuid)
        }
      }
      // Refresh messages from server
      await syncFromServer()
    } catch (e) {
      console.error('Failed to remove cleanup artifacts:', e)
    } finally {
      isRepairing = false
    }
  }

  let activeTab = $state<TabType>('messages')
  let agentMessages = $state<Message[]>([])
  let loadingAgent = $state(false)
  let searchOpen = $state(false)
  let searchDraft = $state('')
  let searchQuery = $state('')
  let includeMetadata = $state(false)
  let contextMode = $state(false)
  let selectedSearchKey = $state<string | null>(null)
  let locateRequest = $state(0)
  let searchError = $state('')
  let searchInput: HTMLInputElement | undefined = $state()
  let searchTimer: ReturnType<typeof setTimeout> | undefined
  const searchSource = $derived(activeTab.startsWith('agent:') ? agentMessages : messages)
  const searchIndex = $derived(
    searchOpen ? indexSessionMessages(searchSource, includeMetadata) : []
  )
  const searchHits = $derived(searchSessionMessages(searchIndex, searchQuery))
  const selectedHitIndex = $derived(searchHits.findIndex((hit) => hit.key === selectedSearchKey))
  const selectedHit = $derived(searchHits[selectedHitIndex] || null)
  const mainIndex = $derived.by(() => {
    const keys = recordKeys(messages)
    return messages.map((message, index) => ({ key: keys[index], message }))
  })
  const agentIndex = $derived.by(() => {
    const keys = recordKeys(agentMessages)
    return agentMessages.map((message, index) => ({ key: keys[index], message }))
  })
  const mainDisplay = $derived(
    contextMode && searchQuery
      ? mainIndex
      : mainIndex.filter((entry) => visibleCategories.has(getMessageCategory(entry.message)))
  )
  const agentDisplay = $derived(
    contextMode && searchQuery
      ? agentIndex
      : agentIndex.filter((entry) => visibleCategories.has(getMessageCategory(entry.message)))
  )

  function changeSearch(value: string) {
    searchDraft = value
    contextMode = false
    selectedSearchKey = null
    searchError = ''
    clearTimeout(searchTimer)
    searchTimer = setTimeout(() => {
      searchQuery = value.trim()
      if (scrollContainer) scrollContainer.scrollTop = 0
    }, 150)
  }
  function closeSearch() {
    clearTimeout(searchTimer)
    searchDraft = ''
    searchQuery = ''
    contextMode = false
    selectedSearchKey = null
    searchOpen = false
    searchError = ''
  }
  async function openSearch() {
    if (!session) return
    if (activeTab === 'todos') {
      activeTab = 'messages'
      await tick()
    }
    searchOpen = true
    await tick()
    searchInput?.focus()
    searchInput?.select()
  }
  function locate(hit: SessionSearchHit) {
    selectedSearchKey = hit.key
    contextMode = true
    searchError = ''
    locateRequest++
  }
  function navigateHit(direction: number) {
    if (!searchHits.length) return
    const index =
      selectedHitIndex < 0
        ? direction > 0
          ? 0
          : searchHits.length - 1
        : (selectedHitIndex + direction + searchHits.length) % searchHits.length
    locate(searchHits[index])
  }
  async function returnSearchResults() {
    contextMode = false
    searchError = ''
    await tick()
    const selected = scrollContainer?.querySelector<HTMLElement>(
      `[data-search-hit="${CSS.escape(selectedSearchKey || '')}"]`
    )
    if (selected && scrollContainer)
      scrollContainer.scrollTop +=
        selected.getBoundingClientRect().top - scrollContainer.getBoundingClientRect().top - 30
  }
  function searchKeys(event: KeyboardEvent) {
    if (
      (event.metaKey || event.ctrlKey) &&
      event.key.toLowerCase() === 'f' &&
      session &&
      !document.querySelector('[role="dialog"]')
    ) {
      event.preventDefault()
      void openSearch()
    }
  }
  $effect(() => {
    void session?.id
    void activeTab
    closeSearch()
  })
  onDestroy(() => clearTimeout(searchTimer))

  const filteredAgentMessages = $derived(
    agentMessages.filter((m) => visibleCategories.has(getMessageCategory(m)))
  )

  const handleFilterShowAll = () => {
    visibleCategories = new Set(ALL_MESSAGE_CATEGORIES)
  }

  // Undo stack - stores already-deleted messages that can be restored
  interface DeletedMessage {
    msg: Message
    index: number
    isAgent: boolean
    sessionId: string // The session/agent ID where it was deleted from
  }
  let undoStack = $state<DeletedMessage[]>([])
  let undoCountdown = $state(0)
  let undoTimeoutId = $state<ReturnType<typeof setTimeout> | null>(null)

  // Delete operation queue - ensures sequential execution to prevent race conditions
  let deleteQueue: Promise<void> = Promise.resolve()

  // Countdown timer effect for undo availability
  $effect(() => {
    if (undoCountdown <= 0) return

    const intervalId = setInterval(() => {
      undoCountdown = Math.max(0, undoCountdown - 1)
      if (undoCountdown === 0) {
        // Time expired, clear undo stack
        undoStack = []
      }
    }, 1000)

    return () => clearInterval(intervalId)
  })

  // Reset to messages tab when session changes
  $effect(() => {
    // Track session.id to detect session change
    const _sessionId = session?.id
    activeTab = 'messages'
    agentMessages = []
  })

  // Get currently selected agent ID from tab
  const selectedAgentId = $derived(activeTab.startsWith('agent:') ? activeTab.slice(6) : null)

  // Load agent messages when agent tab is selected
  $effect(() => {
    let cancelled = false
    if (selectedAgentId && session) {
      loadingAgent = true
      agentMessages = []
      api
        .getAgentMessages(session.projectName, session.id, selectedAgentId)
        .then((msgs) => {
          if (!cancelled) agentMessages = msgs
        })
        .catch((e) => {
          if (!cancelled) {
            console.error('Failed to load agent messages:', e)
            agentMessages = []
          }
        })
        .finally(() => {
          if (!cancelled) loadingAgent = false
        })
    }
    return () => {
      cancelled = true
    }
  })

  // Message editing state
  let editingMessage = $state<Message | null>(null)

  const handleEditMessage = (msg: Message) => {
    editingMessage = msg
  }

  const handleCancelEdit = () => {
    editingMessage = null
  }

  // Server sync — refreshes messages from server to get chain repair results
  let refreshing = $state(false)
  let refreshError = $state('')
  const syncFromServer = async () => {
    if (!onRefresh) return
    refreshing = true
    try {
      await onRefresh()
    } finally {
      refreshing = false
    }
  }
  let copied = $state(false)
  let copyTimer: ReturnType<typeof setTimeout>
  onDestroy(() => clearTimeout(copyTimer))
  const copySessionId = async () => {
    if (!session) return
    try {
      await navigator.clipboard.writeText(session.id)
      copied = true
      clearTimeout(copyTimer)
      copyTimer = setTimeout(() => (copied = false), 1800)
    } catch {
      refreshError = '自动复制不可用，请选中会话 ID 手动复制。'
    }
  }

  // Undo all deletions - restore messages via API
  const undoAllDeletes = async () => {
    if (undoTimeoutId) clearTimeout(undoTimeoutId)
    if (!session || undoStack.length === 0) return

    // Wait for all pending delete operations to complete before restoring
    await deleteQueue

    // Restore in reverse order (most recent first) to maintain correct indices
    const toRestore = [...undoStack].reverse()

    for (const item of toRestore) {
      try {
        await api.restoreMessage(
          session.projectName,
          item.sessionId,
          item.msg as unknown as Record<string, unknown>,
          item.index
        )
        // Update UI
        if (item.isAgent) {
          const newAgentMessages = [...agentMessages]
          newAgentMessages.splice(item.index, 0, item.msg)
          agentMessages = newAgentMessages
        } else {
          const newMessages = [...messages]
          newMessages.splice(item.index, 0, item.msg)
          onMessagesChange?.(newMessages)
        }
      } catch (e) {
        console.error('Failed to restore message:', e)
      }
    }

    // Clear undo stack
    undoStack = []
    undoCountdown = 0
    undoTimeoutId = null

    // Sync from server to ensure consistent state after restore
    await syncFromServer()
  }

  // Handle message deletion with undo (works for both session and agent messages)
  // Deletes immediately via API, stores in undo stack for potential restore
  const handleMessageDeleteWithUndo = async (msg: Message, isAgent: boolean) => {
    if (!session) return

    const isTitleMessage = msg.type === 'custom-title' || msg.type === 'agent-name'
    const msgId = msg.uuid || msg.messageId || msg.leafUuid
    if (!msgId && !isTitleMessage) return

    // Determine targetType for disambiguation when uuid/messageId collision exists
    const targetType =
      msg.type === 'file-history-snapshot'
        ? ('file-history-snapshot' as const)
        : msg.type === 'summary'
          ? ('summary' as const)
          : undefined

    const targetSessionId = isAgent && selectedAgentId ? selectedAgentId : session.id
    let index: number

    if (isAgent) {
      index = isTitleMessage
        ? agentMessages.indexOf(msg)
        : agentMessages.findIndex((m) => (m.uuid || m.messageId || m.leafUuid) === msgId)
      if (index === -1) return
    } else {
      index = isTitleMessage
        ? messages.indexOf(msg)
        : messages.findIndex((m) => (m.uuid || m.messageId || m.leafUuid) === msgId)
      if (index === -1) return
    }

    // 1. Remove from UI immediately
    if (isTitleMessage) {
      if (isAgent) {
        agentMessages = agentMessages.filter((_, i) => i !== index)
      } else {
        const copy = [...messages]
        copy.splice(index, 1)
        onMessagesChange?.(copy)
      }
    } else {
      if (isAgent) {
        const copy = [...agentMessages] as unknown as Record<string, unknown>[]
        deleteMessageWithChainRepair(copy, msgId!, targetType)
        agentMessages = copy as unknown as Message[]
      } else {
        const copy = [...messages] as unknown as Record<string, unknown>[]
        deleteMessageWithChainRepair(copy, msgId!, targetType)
        onMessagesChange?.(copy as unknown as Message[])
      }
    }

    // 2. Add to undo stack
    undoStack = [...undoStack, { msg, index, isAgent, sessionId: targetSessionId }]

    // 3. Reset countdown and timer
    if (undoTimeoutId) clearTimeout(undoTimeoutId)
    undoCountdown = 10
    undoTimeoutId = setTimeout(() => {
      undoStack = []
      undoCountdown = 0
      undoTimeoutId = null
    }, 10000)

    // 4. Delete via API - queued to prevent race conditions
    deleteQueue = deleteQueue.then(async () => {
      try {
        if (isTitleMessage) {
          await api.deleteTitleMessage(session.projectName, targetSessionId, index)
        } else {
          await api.deleteMessage(session.projectName, targetSessionId, msgId!, targetType)
        }
      } catch (e) {
        console.error('Failed to delete message:', e)
      }
    })

    onDeleteMessage?.(msg)
  }

  // Handle agent message deletion with undo
  const handleAgentMessageDelete = (msg: Message) => {
    handleMessageDeleteWithUndo(msg, true)
  }

  // Handle session message deletion with undo
  const handleSessionMessageDelete = (msg: Message) => {
    handleMessageDeleteWithUndo(msg, false)
  }

  const openSessionFile = async () => {
    if (!session) return
    const filePath = `~/.claude/projects/${session.projectName}/${session.id}.jsonl`
    try {
      await api.openFile(filePath)
    } catch (e) {
      console.error('Failed to open file:', e)
    }
  }

  // Scroll container reference for navigation (internal or external)
  let internalScrollContainer: HTMLDivElement | undefined = $state()
  const scrollContainer = $derived(externalScrollContainer ?? internalScrollContainer)
</script>

<svelte:window onkeydown={searchKeys} />

<section
  class="session-viewer {fullWidth ? '' : 'border border-gh-border rounded-lg'}"
  data-session-viewer
>
  <!-- Header -->
  <div class="session-viewer-header">
    {#if backUrl}
      <a
        href={backUrl}
        class="text-gh-muted hover:text-gh-fg flex-shrink-0"
        title="Back to project"
      >
        <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path
            stroke-linecap="round"
            stroke-linejoin="round"
            stroke-width="2"
            d="M10 19l-7-7m0 0l7-7m-7 7h18"
          />
        </svg>
      </a>
    {/if}
    <div class="session-viewer-title">
      {#if session}
        <h2 class="line-clamp-2" title={displayTitle}>
          <CommandTitle title={displayTitle} />
        </h2>
        <div class="flex flex-wrap items-center gap-1 mt-2">
          <code
            class="text-[11px] text-gh-text-secondary select-all break-all mr-1"
            data-session-id={session.id}>{session.id}</code
          >
          <button
            class="quiet-button !p-1"
            onclick={copySessionId}
            aria-label="复制会话 ID"
            title="复制会话 ID"><Icon name={copied ? 'check' : 'copy'} size={13} /></button
          >
          <button
            class="quiet-button !p-1"
            onclick={openSessionFile}
            title="在编辑器中打开会话文件"
            aria-label="在编辑器中打开会话文件"
          >
            <Icon name="file" size={13} />
          </button>
          <ValidationBadge
            chainErrors={chainResult.errors}
            progressErrors={progressResult.errors}
            {isRepairing}
            onRepair={handleRepairChain}
            onRepairProgress={handleRepairProgress}
          />
        </div>
      {:else}
        <h2>会话工作台</h2>
      {/if}
    </div>
    <div class="session-viewer-controls">
      {#if session}<button
          class="quiet-button"
          aria-label="搜索当前会话"
          title="搜索当前会话（⌘ / Ctrl + F）"
          onclick={() => void openSearch()}><Icon name="search" size={17} /></button
        >{/if}
      {#if session && onRefresh}<button
          class="quiet-button"
          disabled={loading || refreshing}
          aria-label="刷新会话"
          title="刷新会话"
          onclick={() => {
            refreshError = ''
            void syncFromServer().catch(() => (refreshError = '刷新失败，请稍后重试。'))
          }}><Icon name="refresh" size={16} class={refreshing ? 'animate-spin' : ''} /></button
        >{/if}
      {#if session}
        <SessionActions {onResumeSession} {onCompressSession} {onRenameSession} {onDeleteSession} />
      {/if}
      {#if activeTab !== 'todos'}
        <ScrollButtons {messages} {scrollContainer} />
      {/if}
    </div>
  </div>
  {#if refreshError}<p role="status" class="px-6 py-2 text-xs text-gh-red">{refreshError}</p>{/if}

  <!-- Tabs -->
  {#if session}
    <div class="session-tabs">
      <div class="flex-1 flex items-center">
        <button
          class="session-tab {activeTab === 'messages' ? 'active' : ''}"
          onclick={() => (activeTab = 'messages')}
        >
          <Icon name="message" size={15} />消息
          <span class="opacity-60"
            >{filteredMessages.length}{filteredMessages.length !== messages.length
              ? `/${messages.length}`
              : ''}</span
          >
        </button>
        {#each agents as agent}
          <button
            class="session-tab {activeTab === `agent:${agent.id}` ? 'active' : ''}"
            title={agent.id}
            onclick={() => (activeTab = `agent:${agent.id}`)}
          >
            <Icon name="spark" size={15} /><span class="max-w-32 truncate">{agent.id}</span>
            ({agent.messageCount})
          </button>
        {/each}
      </div>
      {#if todos.length > 0}
        <button
          class="session-tab {activeTab === 'todos' ? 'active' : ''}"
          onclick={() => (activeTab = 'todos')}
        >
          <Icon name="checklist" size={15} />待办 ({todos.length})
        </button>
      {/if}
    </div>
  {/if}

  <!-- Message Type Filter -->
  {#if searchOpen && session && activeTab !== 'todos'}
    <div class="session-find" data-session-find>
      <div class="session-find-input">
        <Icon name="search" size={16} />
        <input
          bind:this={searchInput}
          value={searchDraft}
          oninput={(event) => changeSearch(event.currentTarget.value)}
          aria-label="搜索当前会话记录"
          placeholder={selectedAgentId
            ? '搜索当前子会话的消息内容…'
            : '搜索正文、思考、工具输入/输出、Compact 总结…'}
          onkeydown={async (event) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              clearTimeout(searchTimer)
              searchQuery = searchDraft.trim()
              await tick()
              navigateHit(event.shiftKey ? -1 : 1)
            }
            if (event.key === 'Escape') {
              event.preventDefault()
              closeSearch()
            }
          }}
        />
        <button
          class="quiet-button"
          aria-label="上一条匹配消息"
          disabled={!searchHits.length || searchDraft.trim() !== searchQuery}
          onclick={() => navigateHit(-1)}><Icon name="up" size={15} /></button
        >
        <button
          class="quiet-button"
          aria-label="下一条匹配消息"
          disabled={!searchHits.length || searchDraft.trim() !== searchQuery}
          onclick={() => navigateHit(1)}><Icon name="down" size={15} /></button
        >
        <button class="quiet-button" aria-label="关闭会话内搜索" onclick={closeSearch}
          ><Icon name="close" size={15} /></button
        >
      </div>
      <div class="session-find-meta">
        <span
          >{searchDraft.trim() !== searchQuery
            ? '正在匹配…'
            : searchQuery
              ? `匹配 ${searchHits.length} 条消息 / 共 ${searchSource.length} 条记录`
              : '仅搜索当前会话已加载记录，包含折叠内容'}</span
        >
        <label><input type="checkbox" bind:checked={includeMetadata} />包含元数据</label>
      </div>
      {#if contextMode && searchQuery}
        <div class="session-find-context" data-search-context>
          <span
            >{selectedHit
              ? `已定位第 ${selectedHit.index + 1} 条记录 · ${selectedHitIndex + 1}/${searchHits.length}`
              : '当前记录已不再匹配'} · 完整消息流</span
          >
          <div>
            <button
              class="quiet-button"
              disabled={!selectedHit}
              onclick={() => selectedHit && locate(selectedHit)}>重新定位</button
            ><button class="quiet-button text-gh-accent" onclick={() => void returnSearchResults()}
              >返回搜索结果</button
            >
          </div>
        </div>
      {/if}
      {#if searchError}<p role="status" class="text-xs text-gh-red mt-2">{searchError}</p>{/if}
    </div>
  {/if}
  {#if session && !searchQuery && (activeTab === 'messages' || activeTab.startsWith('agent:'))}
    <MessageFilter
      messages={activeTab === 'messages' ? messages : agentMessages}
      {visibleCategories}
      onToggle={handleFilterToggle}
      onShowAll={handleFilterShowAll}
      onReset={handleFilterReset}
    />
  {/if}

  <!-- Content -->
  <div
    bind:this={internalScrollContainer}
    class="session-scroll {enableScroll ? '' : '!overflow-visible'}"
    data-session-scroll
  >
    {#if loading}
      <div
        role="status"
        class="flex items-center justify-center h-full gap-3 text-gh-text-secondary text-sm"
      >
        <Icon name="refresh" class="animate-spin" />正在加载会话…
      </div>
    {:else if !session}
      <div class="flex flex-col items-center justify-center h-full gap-4 text-gh-text-secondary">
        <span class="rounded-2xl p-5 bg-gh-bg border border-gh-border"
          ><Icon name="message" size={32} /></span
        >
        <p class="text-base font-medium text-gh-text">选择一个会话开始阅读</p>
        <p class="text-xs">查看原始内容，精确编辑消息，保留后续历史。</p>
        <button class="quiet-button border border-gh-border" onclick={() => sidebarOpen.set(true)}
          >浏览项目 <Icon name="right" size={14} /></button
        >
      </div>
    {:else if loadError}
      <p role="alert" class="p-8 text-sm text-gh-red">{loadError}</p>
    {:else if loadingAgent && activeTab.startsWith('agent:')}
      <p role="status" class="p-8 text-sm text-gh-text-secondary">正在加载子会话…</p>
    {:else if searchOpen && searchDraft.trim() !== searchQuery}
      <p role="status" class="p-8 text-sm text-gh-text-secondary">正在匹配…</p>
    {:else if searchOpen && searchQuery && !contextMode && activeTab !== 'todos'}
      <SessionSearchResults
        hits={searchHits}
        query={searchQuery}
        selectedKey={selectedSearchKey}
        onLocate={locate}
      />
    {:else if activeTab === 'messages'}
      {#if messages.length === 0}
        <div class="flex items-center justify-center h-full text-gh-text-secondary">
          No messages
        </div>
      {:else}
        <MessageList
          sessionId={session.id}
          messages={mainDisplay.map((entry) => entry.message)}
          recordKeyList={mainDisplay.map((entry) => entry.key)}
          activeKey={contextMode ? selectedSearchKey : null}
          activeMatch={contextMode ? selectedHit : null}
          {locateRequest}
          {searchQuery}
          onLocateError={(message) => (searchError = message)}
          onDeleteMessage={handleSessionMessageDelete}
          onEditMessage={handleEditMessage}
          {onEditTitle}
          {onSplitSession}
          enableScroll={false}
          fullWidth={true}
        />
      {/if}
    {:else if activeTab === 'todos'}
      <div class="p-4">
        {#if todos.length === 0}
          <div class="text-gh-text-secondary text-center py-8">No todos</div>
        {:else}
          <ul class="space-y-2">
            {#each todos as todo}
              <li class="flex items-start gap-2 p-3 bg-gh-bg rounded border border-gh-border">
                <span class="flex-shrink-0">
                  {#if todo.status === 'completed'}
                    <Icon name="check" size={16} />
                  {:else if todo.status === 'in_progress'}
                    <Icon name="activity" size={16} />
                  {:else}
                    <Icon name="square" size={16} />
                  {/if}
                </span>
                <span
                  class={todo.status === 'completed' ? 'text-gh-text-secondary line-through' : ''}
                  >{todo.content}</span
                >
              </li>
            {/each}
          </ul>
        {/if}
      </div>
    {:else if selectedAgentId}
      {#if loadingAgent}
        <div class="flex items-center justify-center h-full text-gh-text-secondary">
          Loading agent messages...
        </div>
      {:else if agentMessages.length === 0}
        <div class="flex items-center justify-center h-full text-gh-text-secondary">
          No messages
        </div>
      {:else}
        <MessageList
          sessionId={session.id}
          messages={agentDisplay.map((entry) => entry.message)}
          recordKeyList={agentDisplay.map((entry) => entry.key)}
          activeKey={contextMode ? selectedSearchKey : null}
          activeMatch={contextMode ? selectedHit : null}
          {locateRequest}
          {searchQuery}
          onLocateError={(message) => (searchError = message)}
          onDeleteMessage={handleAgentMessageDelete}
          enableScroll={false}
          fullWidth={true}
        />
      {/if}
    {/if}
  </div>

  <!-- Undo Toast -->
  {#if undoStack.length > 0}
    <div
      class="fixed bottom-4 left-1/2 -translate-x-1/2 bg-neutral-500/20 border border-neutral-600
             rounded-lg shadow-2xl px-4 py-3 flex items-center gap-4 z-50 backdrop-blur-sm"
    >
      <span class="text-sm text-white">
        {undoStack.length === 1 ? 'Message deleted' : `${undoStack.length} messages deleted`}
      </span>
      <span class="text-xs text-gh-text-secondary tabular-nums">{undoCountdown}s</span>
      <button
        onclick={undoAllDeletes}
        class="px-3 py-1 text-sm font-medium text-gh-accent hover:bg-gh-border-subtle rounded transition-colors"
      >
        Undo
      </button>
      <button
        onclick={() => {
          if (undoTimeoutId) clearTimeout(undoTimeoutId)
          undoStack = []
          undoCountdown = 0
        }}
        class="px-2 py-1 text-sm text-gh-text-secondary hover:text-gh-text hover:bg-gh-border-subtle rounded transition-colors"
        title="Dismiss (already deleted)"
      >
        <Icon name="close" size={14} />
      </button>
    </div>
  {/if}

  <!-- Message Editor -->
  {#if editingMessage && session}
    {#key `${session.projectName}/${session.id}/${editingMessage.uuid}`}
      <HistoryMessageEditor
        projectName={session.projectName}
        sessionId={session.id}
        messageUuid={editingMessage.uuid}
        onSaved={syncFromServer}
        onClose={handleCancelEdit}
      />
    {/key}
  {/if}
</section>
