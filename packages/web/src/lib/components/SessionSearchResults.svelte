<script lang="ts">
  import type { SessionSearchHit } from '$lib/utils/session-search'
  import Icon from './Icon.svelte'
  import SearchHighlight from './SearchHighlight.svelte'
  let {
    hits,
    query,
    selectedKey,
    onLocate,
  }: {
    hits: SessionSearchHit[]
    query: string
    selectedKey: string | null
    onLocate: (hit: SessionSearchHit) => void
  } = $props()
  let limit = $state(80)
  const visibleLimit = $derived(
    Math.max(limit, hits.findIndex((hit) => hit.key === selectedKey) + 1)
  )
  $effect(() => {
    void query
    limit = 80
  })
</script>

<div class="session-search-results" aria-label="会话内搜索结果" data-session-search-results>
  {#if !hits.length}
    <div class="session-search-empty">
      <Icon name="search" size={28} />
      <p>当前会话没有匹配的消息</p>
      <span>可以换个关键词，或勾选“包含元数据”。</span>
    </div>
  {:else}
    {#each hits.slice(0, visibleLimit) as hit (hit.key)}
      <button
        class="session-search-result"
        class:active={selectedKey === hit.key}
        data-search-hit={hit.key}
        onclick={() => onLocate(hit)}
        aria-label={`查看第 ${hit.index + 1} 条记录的上下文`}
      >
        <span class="search-result-meta"
          ><span
            >#{hit.index + 1} · {['user', 'human'].includes(hit.message.type)
              ? '用户'
              : hit.message.type === 'assistant'
                ? 'Agent'
                : hit.message.type}</span
          ><span>{hit.label}</span><time
            >{hit.message.timestamp ? new Date(hit.message.timestamp).toLocaleString() : ''}</time
          ></span
        >
        <span class="search-result-snippet"><SearchHighlight text={hit.snippet} {query} /></span>
        <span class="search-result-footer"
          ><code>{hit.message.uuid || hit.message.messageId || '无 UUID 的记录'}</code><span
            >{hit.matches.length > 1 ? `${hit.matches.length} 个字段命中 · ` : ''}查看上下文 <Icon
              name="right"
              size={13}
            /></span
          ></span
        >
      </button>
    {/each}
    {#if hits.length > visibleLimit}<button
        class="quiet-button mx-auto"
        onclick={() => (limit = visibleLimit + 80)}
        >显示更多结果（还有 {hits.length - visibleLimit} 条）</button
      >{/if}
  {/if}
</div>
