<script lang="ts">
  import Icon from './Icon.svelte'
  import SearchHighlight from './SearchHighlight.svelte'
  let {
    content,
    contentPath = '/message/content',
    searchQuery = '',
  }: { content: unknown; contentPath?: string; searchQuery?: string } = $props()
  const record = (value: unknown): Record<string, unknown> =>
    value !== null && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {}
  const text = (value: unknown) =>
    typeof value === 'string' ? value : JSON.stringify(value, null, 2) || ''
</script>

{#snippet renderContent(value: unknown, sourcePath: string)}
  {#if typeof value === 'string'}
    <p class="message-body-text" data-search-path={sourcePath}>
      <SearchHighlight text={value || '（空文本）'} query={searchQuery} />
    </p>
  {:else if Array.isArray(value)}
    {#each value as entry, index}
      {@const block = record(entry)}
      {@const blockPath = `${sourcePath}/${index}`}
      <div
        class="my-2 min-w-0"
        data-content-index={index}
        data-content-type={String(block.type || 'unknown')}
      >
        {#if block.type === 'text'}
          {@render renderContent(text(block.text), `${blockPath}/text`)}
        {:else if block.type === 'thinking'}
          <details class="message-block-details">
            <summary><Icon name="spark" size={14} />思考过程 · 块 {index + 1}</summary>
            <div class="mt-3">
              {@render renderContent(text(block.thinking), `${blockPath}/thinking`)}
            </div>
          </details>
        {:else if block.type === 'tool_use'}
          <details class="message-block-details">
            <summary
              ><Icon name="terminal" size={14} /><span data-search-path={`${blockPath}/name`}
                ><SearchHighlight text={text(block.name)} query={searchQuery} /></span
              ><span class="ml-auto font-mono text-[10px] opacity-60">{text(block.id)}</span
              ></summary
            >
            <pre
              class="mt-3 max-h-80 overflow-auto whitespace-pre-wrap break-all text-xs"
              data-search-path={`${blockPath}/input`}><SearchHighlight
                text={text(block.input)}
                query={searchQuery}
              /></pre>
          </details>
        {:else if block.type === 'tool_result'}
          <details class="message-block-details">
            <summary
              ><Icon name="file" size={14} />工具结果<span
                class="ml-auto font-mono text-[10px] opacity-60"
                >{text(block.tool_use_id)}{block.is_error ? ' · 失败' : ''}</span
              ></summary
            >
            <div class="mt-3">{@render renderContent(block.content, `${blockPath}/content`)}</div>
          </details>
        {:else if block.type === 'image'}
          {@const source = record(block.source)}
          {#if source.type === 'base64' && typeof source.data === 'string' && /^image\/(png|jpeg|webp|gif)$/.test(String(source.media_type))}
            <img
              src={`data:${source.media_type};base64,${source.data}`}
              alt="会话图片附件"
              loading="lazy"
              class="max-h-96 max-w-full object-contain"
            />
          {:else}<p class="text-xs text-gh-text-secondary">图片附件（原始记录中可查看详情）</p>{/if}
        {:else}
          <details class="message-block-details">
            <summary><Icon name="file" size={14} />{text(block.type || '未知内容块')}</summary>
            <pre
              class="mt-3 max-h-80 overflow-auto whitespace-pre-wrap break-all text-xs"
              data-search-path={blockPath}><SearchHighlight
                text={text(entry)}
                query={searchQuery}
              /></pre>
          </details>
        {/if}
      </div>
    {/each}
  {:else if value !== undefined && value !== null}
    <pre
      class="max-h-80 overflow-auto whitespace-pre-wrap break-all text-xs"
      data-search-path={sourcePath}><SearchHighlight text={text(value)} query={searchQuery} /></pre>
  {:else}<p class="text-xs text-gh-text-secondary">未保存正文。</p>{/if}
{/snippet}

{@render renderContent(content, contentPath)}
