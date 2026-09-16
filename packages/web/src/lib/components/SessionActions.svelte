<script lang="ts">
  import Icon from './Icon.svelte'
  let {
    onResumeSession,
    onCompressSession,
    onRenameSession,
    onDeleteSession,
    compact = false,
  }: {
    onResumeSession?: (event: MouseEvent) => void
    onCompressSession?: (event: MouseEvent) => void
    onRenameSession?: (event: MouseEvent) => void
    onDeleteSession?: (event: MouseEvent) => void
    compact?: boolean
  } = $props()
  let open = $state(false)
  let container: HTMLDivElement | undefined = $state()
  let trigger: HTMLButtonElement | undefined = $state()
  let position = $state('')
  function toggle() {
    if (!open && trigger) {
      const rect = trigger.getBoundingClientRect()
      position = `left:${Math.max(8, Math.min(innerWidth - 198, rect.right - 190))}px;top:${Math.max(8, Math.min(rect.bottom + 6, innerHeight - 190))}px`
    }
    open = !open
  }
  $effect(() => {
    if (!open) return
    const outside = (event: PointerEvent) => {
      if (!container?.contains(event.target as Node)) open = false
    }
    document.addEventListener('pointerdown', outside)
    const dismiss = () => (open = false)
    window.addEventListener('resize', dismiss)
    return () => {
      document.removeEventListener('pointerdown', outside)
      window.removeEventListener('resize', dismiss)
    }
  })
  function select(action: ((event: MouseEvent) => void) | undefined, event: MouseEvent) {
    open = false
    action?.(event)
  }
  function keys(event: KeyboardEvent) {
    if (event.key === 'Escape') {
      open = false
      trigger?.focus()
      event.preventDefault()
      return
    }
    if (!['ArrowDown', 'ArrowUp'].includes(event.key)) return
    event.preventDefault()
    if (!open) {
      toggle()
      requestAnimationFrame(() =>
        container?.querySelector<HTMLButtonElement>('[role=menuitem]')?.focus()
      )
      return
    }
    const items = [...(container?.querySelectorAll<HTMLButtonElement>('[role=menuitem]') || [])]
    const index = items.indexOf(document.activeElement as HTMLButtonElement)
    items[(index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus()
  }
</script>

<div class="flex items-center gap-1">
  {#if onResumeSession && !compact}<button
      class="quiet-button"
      onclick={onResumeSession}
      title="继续会话"
      ><Icon name="play" size={16} /><span class="hidden lg:inline">继续会话</span></button
    >{/if}
  {#if onCompressSession || onRenameSession || onDeleteSession || (compact && onResumeSession)}
    <div class="relative" bind:this={container} role="group">
      <button
        bind:this={trigger}
        class="quiet-button"
        aria-label="更多会话操作"
        aria-haspopup="menu"
        aria-expanded={open}
        onkeydown={keys}
        onclick={toggle}><Icon name="more" size={18} /></button
      >
      {#if open}
        <div class="session-action-menu" role="menu" aria-label="会话操作" style={position}>
          {#if compact && onResumeSession}<button
              role="menuitem"
              onkeydown={keys}
              onclick={(event) => select(onResumeSession, event)}
              ><Icon name="play" size={16} />继续会话</button
            >{/if}
          {#if onRenameSession}<button
              role="menuitem"
              onkeydown={keys}
              onclick={(event) => select(onRenameSession, event)}
              ><Icon name="edit" size={16} />重命名会话</button
            >{/if}
          {#if onCompressSession}<button
              role="menuitem"
              onkeydown={keys}
              onclick={(event) => select(onCompressSession, event)}
              ><Icon name="archive" size={16} />清理冗余记录</button
            >{/if}
          {#if onDeleteSession}<button
              role="menuitem"
              onkeydown={keys}
              class="delete-action"
              onclick={(event) => select(onDeleteSession, event)}
              ><Icon name="trash" size={16} />删除会话</button
            >{/if}
        </div>
      {/if}
    </div>
  {/if}
</div>

<style>
  .session-action-menu {
    position: fixed;
    width: 190px;
    padding: 5px;
    background: var(--color-gh-bg);
    border: 1px solid var(--color-gh-border);
    border-radius: 10px;
    box-shadow: 0 8px 28px #14233b18;
    z-index: 40;
  }
  .session-action-menu button {
    width: 100%;
    display: flex;
    align-items: center;
    gap: 9px;
    padding: 10px;
    border-radius: 6px;
    font-size: 12px;
    text-align: left;
  }
  .session-action-menu button:hover {
    background: var(--color-gh-bg-secondary);
  }
  .delete-action {
    color: var(--color-gh-red);
    border-top: 1px solid var(--color-gh-border);
    margin-top: 3px;
  }
</style>
