<script lang="ts">
  import type { Message } from '$lib/api'
  import MessageItem from './MessageItem.svelte'
  import { tick } from 'svelte'
  import { recordKeys, type SessionSearchHit, type SearchDocument } from '$lib/utils/session-search'
  import SearchHighlight from './SearchHighlight.svelte'

  interface Props {
    sessionId: string
    messages: Message[]
    onDeleteMessage: (msg: Message) => void
    onEditMessage?: (msg: Message) => void
    onEditTitle?: (msg: Message) => void
    onSplitSession?: (msg: Message) => void
    enableScroll?: boolean
    fullWidth?: boolean
    recordKeyList?: string[]
    activeKey?: string | null
    activeMatch?: SessionSearchHit | null
    searchQuery?: string
    locateRequest?: number
    onLocateError?: (message: string) => void
  }

  let {
    sessionId,
    messages,
    onDeleteMessage,
    onEditMessage,
    onEditTitle,
    onSplitSession,
    enableScroll = true,
    fullWidth = false,
    recordKeyList,
    activeKey = null,
    activeMatch = null,
    searchQuery = '',
    locateRequest = 0,
    onLocateError,
  }: Props = $props()

  // Find index of first meaningful message (user/assistant, not metadata)
  const firstMeaningfulIndex = $derived(
    messages.findIndex((m) => m.type === 'user' || m.type === 'assistant' || m.type === 'human')
  )

  // Use keys from the full source when filters change. UUID-less records are
  // snapshot-bound, so a refreshed array cannot silently retarget an old hit.
  const messageKeys = $derived(recordKeyList || recordKeys(messages))
  const elements = new Map<string, HTMLElement>()
  let fallbackMatches: SearchDocument[] = $state([])
  function register(element: HTMLElement, key: string) {
    elements.set(key, element)
    return {
      destroy() {
        if (elements.get(key) === element) elements.delete(key)
      },
    }
  }
  $effect(() => {
    const key = activeKey
    const hit = activeMatch
    void locateRequest
    if (!key) {
      fallbackMatches = []
      return
    }
    let cancelled = false
    void (async () => {
      await tick()
      if (cancelled) return
      const root = elements.get(key)
      if (!root) {
        onLocateError?.('目标记录已变化，请返回搜索结果重新定位。')
        return
      }
      const missing: SearchDocument[] = []
      let first: HTMLElement | null = null
      for (const document of hit?.matches || []) {
        const target: HTMLElement | null = root.querySelector<HTMLElement>(
          `[data-search-path="${CSS.escape(document.path)}"]`
        )
        if (!target) {
          missing.push(document)
          continue
        }
        if (!first) first = target
        for (
          let parent: HTMLElement | null = target.parentElement;
          parent && parent !== root;
          parent = parent.parentElement
        ) {
          if (parent instanceof HTMLDetailsElement) parent.open = true
        }
      }
      fallbackMatches = missing
      await tick()
      if (cancelled || !root.isConnected) return
      const target: HTMLElement =
        first?.querySelector<HTMLElement>('mark') ||
        first ||
        root.querySelector<HTMLElement>('[data-search-fallback] mark') ||
        root.querySelector<HTMLElement>('[data-search-fallback]') ||
        root
      for (
        let parent: HTMLElement | null = target.parentElement;
        parent && parent !== root;
        parent = parent.parentElement
      ) {
        if (
          parent.scrollHeight > parent.clientHeight &&
          ['auto', 'scroll'].includes(getComputedStyle(parent).overflowY)
        ) {
          parent.scrollTop +=
            target.getBoundingClientRect().top -
            parent.getBoundingClientRect().top -
            parent.clientHeight / 3
        }
      }
      const scroller = root.closest<HTMLElement>('[data-session-scroll]')
      if (scroller)
        scroller.scrollTo({
          top: Math.max(
            0,
            scroller.scrollTop +
              target.getBoundingClientRect().top -
              scroller.getBoundingClientRect().top -
              90
          ),
          behavior: 'auto',
        })
      root.focus({ preventScroll: true })
    })()
    return () => {
      cancelled = true
    }
  })
</script>

<section
  class="min-w-0 overflow-hidden flex flex-col {fullWidth
    ? ''
    : 'border border-gh-border rounded-lg'}"
>
  <div class="message-stream {enableScroll ? 'overflow-y-auto' : ''}">
    {#each messages as msg, i (messageKeys[i])}
      <div
        use:register={messageKeys[i]}
        class="search-record"
        data-search-record-key={messageKeys[i]}
        data-search-active={activeKey === messageKeys[i] || undefined}
        tabindex="-1"
      >
        <MessageItem
          {msg}
          {sessionId}
          isFirst={i === 0 || i === firstMeaningfulIndex}
          onDelete={onDeleteMessage}
          onEdit={onEditMessage}
          {onEditTitle}
          onSplit={onSplitSession}
          searchQuery={activeKey === messageKeys[i] ? searchQuery : ''}
        />
        {#if activeKey === messageKeys[i] && fallbackMatches.length}
          <div class="search-fallback" data-search-fallback>
            {#each fallbackMatches as match}
              <details open>
                <summary>{match.label} · 搜索命中原文</summary>
                <pre><SearchHighlight text={match.text} query={searchQuery} /></pre>
              </details>
            {/each}
          </div>
        {/if}
      </div>
    {/each}
  </div>
</section>
