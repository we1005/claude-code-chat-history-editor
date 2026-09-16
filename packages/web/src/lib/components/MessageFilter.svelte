<script lang="ts">
  import type { Message } from '$lib/api'
  import Icon from './Icon.svelte'
  import {
    getMessageCategory,
    MESSAGE_CATEGORY_LABELS,
    DEFAULT_VISIBLE_CATEGORIES,
    type MessageCategory,
  } from '$lib/utils'

  interface Props {
    messages: Message[]
    visibleCategories: Set<MessageCategory>
    onToggle: (category: MessageCategory) => void
    onShowAll: () => void
    onReset: () => void
  }

  let { messages, visibleCategories, onToggle, onShowAll, onReset }: Props = $props()

  const categoryCounts = $derived.by(() => {
    const counts = new Map<MessageCategory, number>()
    for (const msg of messages) {
      const cat = getMessageCategory(msg)
      counts.set(cat, (counts.get(cat) ?? 0) + 1)
    }
    return counts
  })

  const presentCategories = $derived(
    (Object.keys(MESSAGE_CATEGORY_LABELS) as MessageCategory[]).filter(
      (cat) => (categoryCounts.get(cat) ?? 0) > 0
    )
  )

  const isDefault = $derived.by(() => {
    if (visibleCategories.size !== DEFAULT_VISIBLE_CATEGORIES.length) return false
    return DEFAULT_VISIBLE_CATEGORIES.every((c) => visibleCategories.has(c))
  })

  const isAll = $derived(presentCategories.every((c) => visibleCategories.has(c)))
  let open = $state(false)
  const shown = $derived(
    messages.filter((message) => visibleCategories.has(getMessageCategory(message))).length
  )
  const labels: Record<string, string> = {
    assistant: 'Agent',
    user: '用户',
    thinking: '思考',
    tool_use: '工具调用',
    tool_result: '工具结果',
    summary: '摘要',
    metadata: '元数据',
    system: '系统',
    progress: '进度',
  }
</script>

{#if presentCategories.length > 1}
  <details bind:open data-message-filter class="filter-panel">
    <summary aria-label="筛选消息类型" aria-expanded={open}>
      <Icon name="sliders" size={15} /><span>消息类型</span><span class="filter-count"
        >显示 {shown} / {messages.length}</span
      ><Icon name={open ? 'up' : 'down'} size={13} />
    </summary>
    <div class="filter-options">
      <div class="flex items-center gap-1 mr-1">
        <button
          class="px-2 py-0.5 text-xs rounded transition-colors {isAll
            ? 'bg-gh-accent/10 text-gh-accent'
            : 'text-gh-text-secondary hover:text-gh-text hover:bg-gh-border-subtle'}"
          onclick={onShowAll}
        >
          All
        </button>
        <button
          class="px-2 py-0.5 text-xs rounded transition-colors {isDefault
            ? 'bg-gh-accent/10 text-gh-accent'
            : 'text-gh-text-secondary hover:text-gh-text hover:bg-gh-border-subtle'}"
          onclick={onReset}
        >
          Default
        </button>
      </div>
      <div class="w-px h-4 bg-gh-border"></div>
      <div class="flex items-center gap-1.5 flex-wrap">
        {#each presentCategories as category}
          {@const active = visibleCategories.has(category)}
          {@const count = categoryCounts.get(category) ?? 0}
          <button
            class="px-2 py-0.5 text-xs rounded transition-colors whitespace-nowrap {active
              ? 'bg-gh-accent/5 text-gh-accent border border-gh-accent/20'
              : 'text-gh-text-secondary hover:text-gh-text border border-transparent hover:border-gh-border'}"
            onclick={() => onToggle(category)}
          >
            {labels[category] || MESSAGE_CATEGORY_LABELS[category]}
            <span class="ml-0.5 opacity-60">{count}</span>
          </button>
        {/each}
      </div>
    </div>
  </details>
{/if}

<style>
  .filter-panel {
    border-bottom: 1px solid var(--color-gh-border);
    background: var(--color-gh-bg);
  }
  summary {
    list-style: none;
    display: flex;
    align-items: center;
    gap: 8px;
    width: fit-content;
    padding: 10px 32px;
    cursor: pointer;
    color: var(--color-gh-text-secondary);
    font-size: 11px;
  }
  summary::-webkit-details-marker {
    display: none;
  }
  .filter-count {
    color: var(--color-gh-text-secondary);
    opacity: 0.85;
    font-variant-numeric: tabular-nums;
    margin-left: 4px;
  }
  .filter-options {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px;
    padding: 0 32px 14px;
  }
  @media (max-width: 899px) {
    summary {
      padding-left: 16px;
    }
    .filter-options {
      padding-left: 16px;
      padding-right: 16px;
    }
  }
</style>
