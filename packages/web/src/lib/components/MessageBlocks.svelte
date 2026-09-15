<script lang="ts">
  let { content }: { content: unknown } = $props()
  const record = (value: unknown): Record<string, unknown> =>
    value !== null && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {}
  const text = (value: unknown) =>
    typeof value === 'string' ? value : JSON.stringify(value, null, 2) || ''
</script>

{#snippet renderContent(value: unknown)}
  {#if typeof value === 'string'}
    <p class="max-h-[40rem] overflow-auto whitespace-pre-wrap break-words text-sm leading-7">
      {value || '（空文本）'}
    </p>
  {:else if Array.isArray(value)}
    {#each value as entry, index}
      {@const block = record(entry)}
      <div
        class="my-2 min-w-0"
        data-content-index={index}
        data-content-type={String(block.type || 'unknown')}
      >
        {#if block.type === 'text'}
          {@render renderContent(text(block.text))}
        {:else if block.type === 'thinking'}
          <details class="rounded border border-amber-500/20 bg-amber-500/5 p-2">
            <summary class="cursor-pointer text-xs text-gh-text-secondary"
              >思考过程 · 块 {index + 1}</summary
            >
            <div class="mt-2">{@render renderContent(text(block.thinking))}</div>
          </details>
        {:else if block.type === 'tool_use'}
          <details class="rounded border border-gh-border bg-gh-bg-secondary p-2">
            <summary class="cursor-pointer text-xs"
              >工具调用 · {text(block.name)} · {text(block.id)}</summary
            >
            <pre class="mt-2 max-h-80 overflow-auto whitespace-pre-wrap break-all text-xs">{text(
                block.input
              )}</pre>
          </details>
        {:else if block.type === 'tool_result'}
          <details class="rounded border border-gh-border bg-gh-bg-secondary p-2">
            <summary class="cursor-pointer text-xs"
              >工具结果 · {text(block.tool_use_id)}{block.is_error ? ' · 失败' : ''}</summary
            >
            <div class="mt-2">{@render renderContent(block.content)}</div>
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
          <details class="rounded border border-gh-border p-2">
            <summary class="cursor-pointer text-xs">{text(block.type || '未知内容块')}</summary>
            <pre class="mt-2 max-h-80 overflow-auto whitespace-pre-wrap break-all text-xs">{text(
                entry
              )}</pre>
          </details>
        {/if}
      </div>
    {/each}
  {:else if value !== undefined && value !== null}
    <pre class="max-h-80 overflow-auto whitespace-pre-wrap break-all text-xs">{text(value)}</pre>
  {:else}<p class="text-xs text-gh-text-secondary">未保存正文。</p>{/if}
{/snippet}

{@render renderContent(content)}
