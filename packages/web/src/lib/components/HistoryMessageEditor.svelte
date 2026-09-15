<script lang="ts">
  import { onMount, onDestroy } from 'svelte'
  import { base } from '$app/paths'
  import { marked } from 'marked'
  import DOMPurify from 'isomorphic-dompurify'
  import type { MessageEditorSnapshot, MessageFieldBackup } from '@claude-sessions/core'

  interface Props {
    projectName: string
    sessionId: string
    messageUuid: string
    onSaved: () => void | Promise<void>
    onClose: () => void
  }
  let { projectName, sessionId, messageUuid, onSaved, onClose }: Props = $props()
  let snapshot = $state<MessageEditorSnapshot | null>(null)
  let selectedId = $state('')
  let draft = $state('')
  let loading = $state(true)
  let saving = $state(false)
  let historyLoading = $state(false)
  let error = $state('')
  let notice = $state('')
  let tab = $state<'edit' | 'preview' | 'raw' | 'history'>('edit')
  let backups: MessageFieldBackup[] = $state([])
  let dialog: HTMLDivElement | undefined = $state()
  let controller: AbortController | undefined
  let alive = true
  const field = $derived.by(() => snapshot?.fields.find((item) => item.id === selectedId))
  const dirty = $derived(!!field && draft !== field.value)
  const preview = $derived(DOMPurify.sanitize(marked.parse(draft, { async: false })))

  function endpoint(resource: string) {
    return `${base}/api/editor/${resource}?${new URLSearchParams({ project: projectName, session: sessionId, uuid: messageUuid })}`
  }
  async function request<T>(
    resource: string,
    method = 'GET',
    body?: unknown,
    signal?: AbortSignal
  ): Promise<T> {
    const response = await fetch(endpoint(resource), {
      method,
      cache: 'no-store',
      signal,
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const data = await response.json().catch(() => null)
    if (!response.ok)
      throw new Error(data?.error || `请求失败（HTTP ${response.status}），请重新加载确认状态。`)
    if (!data) throw new Error('服务器未返回有效结果，请重新加载核对。')
    return data as T
  }
  function accept(data: MessageEditorSnapshot, preferred = '') {
    snapshot = data
    const firstText = data.fields.find((item) => item.kind === 'text')?.id
    selectedId = data.fields.some((item) => item.id === preferred)
      ? preferred
      : firstText || data.fields[0]?.id || ''
    draft = data.fields.find((item) => item.id === selectedId)?.value || ''
  }
  async function load(preferred = '') {
    controller?.abort()
    const current = new AbortController()
    controller = current
    loading = true
    error = ''
    notice = ''
    try {
      const data = await request<MessageEditorSnapshot>('message', 'GET', undefined, current.signal)
      if (alive && !current.signal.aborted) accept(data, preferred)
    } catch (cause) {
      if (alive && !current.signal.aborted)
        error = cause instanceof Error ? cause.message : '读取失败。'
    } finally {
      if (alive && !current.signal.aborted) loading = false
    }
  }
  function discard() {
    return !dirty || window.confirm('有未保存的草稿，确定放弃这些修改吗？')
  }
  function close() {
    if (!saving && discard()) onClose()
  }
  function choose(id: string) {
    if (id === selectedId || saving || !discard()) return
    selectedId = id
    draft = snapshot?.fields.find((item) => item.id === id)?.value || ''
    tab = 'edit'
    notice = ''
    error = ''
  }
  function refreshOuter() {
    Promise.resolve()
      .then(() => {
        if (alive) return onSaved()
      })
      .catch(() => {
        if (alive) error = '文件已保存，但外层消息列表刷新失败，请刷新页面查看。'
      })
  }
  async function save() {
    if (!snapshot || !field || !dirty || saving || loading) return
    saving = true
    error = ''
    notice = ''
    try {
      const result = await request<{ snapshot: MessageEditorSnapshot; backupId: string | null }>(
        'message',
        'PATCH',
        {
          revision: snapshot.revision,
          targetId: selectedId,
          value: draft,
        }
      )
      if (!alive) return
      accept(result.snapshot, selectedId)
      notice = result.backupId ? '已保存当前字段，原文已备份，后续消息保留。' : '内容没有变化。'
      refreshOuter()
    } catch (cause) {
      if (alive) error = cause instanceof Error ? cause.message : '保存失败，草稿已保留。'
    } finally {
      if (alive) saving = false
    }
  }
  async function history() {
    tab = 'history'
    historyLoading = true
    error = ''
    try {
      const data = await request<MessageFieldBackup[]>('backups')
      if (alive) backups = data
    } catch (cause) {
      if (alive) error = cause instanceof Error ? cause.message : '读取备份失败。'
    } finally {
      if (alive) historyLoading = false
    }
  }
  async function restore(backup: MessageFieldBackup) {
    if (!snapshot || saving || !discard()) return
    if (
      !window.confirm(
        `恢复「${backup.label}」的修改前内容？只恢复这个字段，保留其他字段和后续消息。`
      )
    )
      return
    saving = true
    error = ''
    notice = ''
    try {
      const result = await request<{ snapshot: MessageEditorSnapshot }>('backups', 'POST', {
        revision: snapshot.revision,
        backupId: backup.id,
      })
      if (!alive) return
      accept(result.snapshot, backup.targetId)
      tab = 'edit'
      notice = '已恢复该字段；恢复前的版本也已备份，其他内容保留。'
      refreshOuter()
    } catch (cause) {
      if (alive) error = cause instanceof Error ? cause.message : '恢复失败。'
    } finally {
      if (alive) saving = false
    }
  }
  async function copy(value: string) {
    try {
      await navigator.clipboard.writeText(value)
      notice = '已复制。'
    } catch {
      error = '浏览器未允许自动复制，请选中内容后使用 ⌘ / Ctrl + C。'
    }
  }
  function keydown(event: KeyboardEvent) {
    if (event.key === 'Tab' && dialog) {
      const controls = [
        ...dialog.querySelectorAll<HTMLElement>(
          'button:not(:disabled), textarea:not(:disabled), summary, a[href]'
        ),
      ].filter((element) => element.getClientRects().length > 0)
      const first = controls[0]
      const last = controls.at(-1)
      if (
        first &&
        last &&
        event.shiftKey &&
        (document.activeElement === first || document.activeElement === dialog)
      ) {
        event.preventDefault()
        last.focus()
      } else if (first && last && !event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }
    if (event.key === 'Escape') {
      event.preventDefault()
      close()
    }
    if ((event.metaKey || event.ctrlKey) && ['s', 'Enter'].includes(event.key)) {
      event.preventDefault()
      void save()
    }
  }
  function beforeUnload(event: BeforeUnloadEvent) {
    if (dirty || saving) {
      event.preventDefault()
      event.returnValue = ''
    }
  }
  onMount(() => {
    void load()
    dialog?.focus()
  })
  onDestroy(() => {
    alive = false
    controller?.abort()
  })
</script>

<svelte:window onbeforeunload={beforeUnload} />

<div
  class="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-3 sm:p-6"
  role="presentation"
>
  <div
    bind:this={dialog}
    role="dialog"
    aria-modal="true"
    aria-labelledby="history-editor-heading"
    tabindex="-1"
    onkeydown={keydown}
    class="flex h-[90vh] max-h-[1000px] w-full max-w-6xl flex-col overflow-hidden rounded-xl border border-gh-border bg-gh-bg text-gh-text shadow-2xl outline-none"
  >
    <header class="border-b border-gh-border bg-gh-bg-secondary px-5 py-4">
      <div class="flex items-center justify-between gap-3">
        <h2 id="history-editor-heading" class="text-lg font-semibold">
          编辑历史消息 <span class="ml-2 text-xs font-normal text-gh-text-secondary"
            >逐内容块 · 保留后续历史</span
          >
        </h2>
        {#if dirty}<span
            class="rounded-full bg-amber-500/15 px-3 py-1 text-xs text-amber-600"
            data-testid="unsaved-draft">未保存</span
          >{/if}
      </div>
      <div class="mt-2 flex flex-wrap items-center gap-2 text-xs text-gh-text-secondary">
        <span>会话 ID</span><code class="select-all break-all">{sessionId}</code>
        <button class="text-gh-accent hover:underline" onclick={() => void copy(sessionId)}
          >复制会话 ID</button
        >
      </div>
      <p class="mt-1 break-all text-xs text-gh-text-secondary">
        消息 UUID：<code class="select-all">{messageUuid}</code>
      </p>
    </header>

    <div class="flex min-h-0 flex-1 flex-col md:flex-row">
      <aside
        class="max-h-40 shrink-0 overflow-y-auto border-b border-gh-border bg-gh-bg-secondary p-3 md:max-h-none md:w-60 md:border-r md:border-b-0"
        aria-label="可编辑内容块"
      >
        <p class="mb-2 text-xs text-gh-text-secondary">
          {snapshot?.fields.length || 0} 个可编辑字段
        </p>
        {#each snapshot?.fields || [] as item (item.id)}
          <button
            data-field-id={item.id}
            aria-pressed={selectedId === item.id}
            disabled={saving || loading}
            onclick={() => choose(item.id)}
            class="mb-1 w-full rounded-md border p-3 text-left text-sm disabled:opacity-50 {selectedId ===
            item.id
              ? 'border-gh-accent bg-gh-accent/10'
              : 'border-transparent hover:bg-gh-border-subtle'}"
          >
            <span class="block font-medium">{item.label}</span>
            <code class="mt-1 block break-all text-[10px] text-gh-text-secondary">{item.id}</code>
          </button>
        {/each}
        <p class="mt-3 text-xs leading-relaxed text-gh-text-secondary">
          工具调用、图片和未知字段保持原样。原始记录可在右侧检查。
        </p>
      </aside>

      <main class="min-h-0 min-w-0 flex-1 overflow-y-auto p-5">
        {#if error}<div
            role="alert"
            class="mb-3 whitespace-pre-wrap break-words rounded-md border border-red-500/40 bg-red-500/10 p-3 text-sm text-red-600"
            data-testid="editor-error"
          >
            {error}
          </div>{/if}
        {#if notice}<div
            role="status"
            class="mb-3 rounded-md border border-green-500/30 bg-green-500/10 p-3 text-sm text-green-600"
            data-testid="editor-success"
          >
            {notice}
          </div>{/if}
        <div
          class="mb-3 flex flex-wrap items-center justify-between gap-2 text-xs text-gh-text-secondary"
        >
          <span>编辑前请关闭目标 Claude 会话；文件版本检查不能同步客户端内存。</span>
          <button
            class="text-gh-accent hover:underline disabled:opacity-50"
            disabled={saving || loading}
            onclick={() => {
              if (discard()) void load(selectedId)
            }}>重新加载</button
          >
        </div>
        {#if loading}
          <p role="status" class="py-16 text-center text-gh-text-secondary">正在读取最新记录…</p>
        {:else if snapshot}
          {#each snapshot.warnings as warning}<p
              class="mb-2 rounded border border-amber-500/25 bg-amber-500/10 p-2 text-xs leading-relaxed"
            >
              {warning}
            </p>{/each}
          <nav
            class="my-4 flex flex-wrap gap-2 border-b border-gh-border pb-2"
            aria-label="编辑视图"
          >
            {#each [['edit', '文本编辑'], ['preview', '预览'], ['raw', '原始记录'], ['history', '历史备份']] as [id, label]}
              <button
                disabled={saving}
                aria-pressed={tab === id}
                onclick={() => {
                  if (id === 'history') void history()
                  else tab = id as typeof tab
                }}
                class="rounded px-3 py-2 text-sm disabled:opacity-50 {tab === id
                  ? 'bg-gh-accent/10 text-gh-accent'
                  : 'text-gh-text-secondary hover:bg-gh-border-subtle'}">{label}</button
              >
            {/each}
          </nav>
          {#if tab === 'edit'}
            {#if field}
              <label class="mb-2 block text-sm font-medium" for="history-editor-text"
                >{field.label}</label
              >
              <textarea
                id="history-editor-text"
                data-testid="field-text"
                bind:value={draft}
                disabled={saving}
                spellcheck="false"
                class="min-h-72 w-full resize-y rounded-lg border border-gh-border bg-gh-bg-secondary p-4 font-mono text-sm leading-7 outline-none focus:border-gh-accent focus:ring-1 focus:ring-gh-accent disabled:opacity-60"
                rows="13"
              ></textarea>
              <p class="mt-2 text-xs text-gh-text-secondary">
                可保留空白、换行或清空文本。⌘ / Ctrl + Enter（或 S）保存当前字段。
              </p>
              <button
                class="mt-2 text-xs text-gh-accent hover:underline"
                onclick={() => void copy(draft)}>复制草稿</button
              >
            {:else}<p class="py-8 text-gh-text-secondary">
                当前记录没有可编辑文本。请查看原始记录；本版本不隐式新增或删除内容块。
              </p>{/if}
          {:else if tab === 'preview'}
            {#if draft}<div class="history-preview text-sm leading-7">{@html preview}</div>{:else}<p
                class="text-gh-text-secondary"
              >
                （空文本）
              </p>{/if}
          {:else if tab === 'raw'}
            <p class="mb-2 text-xs text-gh-text-secondary">
              原始文件第 {snapshot.lineNumber} 行 · 同 UUID 共 {snapshot.duplicateCount} 条 · 只读
            </p>
            <pre
              class="max-h-[60vh] overflow-auto whitespace-pre-wrap break-all rounded-lg bg-gh-bg-secondary p-4 font-mono text-xs leading-6">{snapshot.rawRecord}</pre>
          {:else}
            <p class="mb-3 text-xs leading-relaxed text-gh-text-secondary">
              保存前的备份可能也包含未完成的写入尝试。恢复只修改该备份对应的字段，保留其他编辑和后续消息。
            </p>
            {#if historyLoading}<p role="status">正在加载备份…</p>
            {:else if !backups.length}<p class="py-8 text-gh-text-secondary">
                此消息暂无编辑备份。
              </p>
            {:else}
              {#each backups as backup (backup.id)}
                <section
                  class="mb-3 rounded-lg border border-gh-border p-3"
                  data-backup-id={backup.id}
                >
                  <div class="flex flex-wrap items-center justify-between gap-2">
                    <p class="text-sm font-medium">{backup.label}</p>
                    <button
                      disabled={saving}
                      onclick={() => void restore(backup)}
                      class="rounded border border-gh-accent px-3 py-1 text-xs text-gh-accent disabled:opacity-50"
                      >恢复这个字段</button
                    >
                  </div>
                  <p class="mt-1 text-xs text-gh-text-secondary">
                    {new Date(backup.createdAt).toLocaleString()} · {backup.kind === 'restore'
                      ? '恢复前备份'
                      : '编辑前备份'}
                  </p>
                  <details class="mt-2 text-xs">
                    <summary class="cursor-pointer text-gh-accent">查看修改前的完整文本</summary>
                    <pre
                      class="mt-2 max-h-52 overflow-auto whitespace-pre-wrap break-all rounded bg-gh-bg-secondary p-3">{backup.before ||
                        '（空文本）'}</pre>
                  </details>
                </section>
              {/each}
            {/if}
          {/if}
        {/if}
      </main>
    </div>
    <footer
      class="flex items-center justify-between gap-3 border-t border-gh-border bg-gh-bg-secondary px-5 py-3"
    >
      <span class="text-xs text-gh-text-secondary">按字段保存 · 自动备份 · 版本冲突检查</span>
      <div class="flex gap-2">
        <button
          disabled={saving}
          onclick={close}
          class="rounded-md border border-gh-border px-4 py-2 text-sm disabled:opacity-50"
          >关闭</button
        >
        <button
          disabled={loading || saving || !dirty || !field}
          onclick={() => void save()}
          data-testid="save-field"
          class="rounded-md bg-gh-accent px-4 py-2 text-sm text-white hover:opacity-90 disabled:opacity-40"
          >{saving ? '保存中…' : '保存字段'}</button
        >
      </div>
    </footer>
  </div>
</div>

<style>
  .history-preview {
    overflow-wrap: anywhere;
  }
  .history-preview :global(pre) {
    overflow: auto;
    white-space: pre;
    padding: 1rem;
    border-radius: 0.5rem;
    background: var(--color-gh-bg-secondary);
  }
  .history-preview :global(p) {
    margin-bottom: 1rem;
    white-space: pre-wrap;
  }
  .history-preview :global(a) {
    color: var(--color-gh-accent);
    text-decoration: underline;
  }
  .history-preview :global(ul),
  .history-preview :global(ol) {
    padding-left: 1.5rem;
    list-style: revert;
  }
  .history-preview :global(h1),
  .history-preview :global(h2),
  .history-preview :global(h3) {
    font-weight: 600;
    font-size: 1.2em;
    margin: 1rem 0;
  }
  .history-preview :global(img) {
    max-width: 100%;
  }
</style>
