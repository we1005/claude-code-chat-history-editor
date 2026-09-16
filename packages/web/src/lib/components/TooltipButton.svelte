<script lang="ts">
  import type { Snippet } from 'svelte'
  import type { HTMLButtonAttributes } from 'svelte/elements'

  interface Props extends HTMLButtonAttributes {
    title: string
    children: Snippet
    position?: 'top' | 'bottom'
    class?: string
  }

  let {
    title,
    children,
    position = 'bottom',
    class: className = '',
    ...buttonProps
  }: Props = $props()

  let buttonEl = $state<HTMLButtonElement | null>(null)
  let showTooltip = $state(false)
  let tooltipStyle = $state('')

  const updateTooltipPosition = () => {
    if (!buttonEl) return
    const rect = buttonEl.getBoundingClientRect()
    const left = rect.left + rect.width / 2
    if (position === 'top') {
      tooltipStyle = `left: ${left}px; bottom: ${window.innerHeight - rect.top + 8}px;`
    } else {
      tooltipStyle = `left: ${left}px; top: ${rect.bottom + 8}px;`
    }
  }

  const handleMouseEnter = () => {
    updateTooltipPosition()
    showTooltip = true
  }

  const handleMouseLeave = () => {
    showTooltip = false
  }
</script>

<button
  bind:this={buttonEl}
  class="tooltip-btn {className}"
  onmouseenter={handleMouseEnter}
  onmouseleave={handleMouseLeave}
  onfocus={handleMouseEnter}
  onblur={handleMouseLeave}
  {...buttonProps}
  aria-label={buttonProps['aria-label'] ?? title}
>
  {@render children()}
</button>

{#if showTooltip}
  <span class="tooltip" style={tooltipStyle}>
    {title}
  </span>
{/if}

<style>
  .tooltip-btn {
    position: relative;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    background: transparent;
    border: 1px solid transparent;
    cursor: pointer;
    padding: 6px;
    min-width: 30px;
    min-height: 30px;
    border-radius: 6px;
    transition:
      background 140ms,
      color 140ms;
  }
  .tooltip-btn:hover {
    background: var(--color-gh-border-subtle);
  }
  .tooltip-btn:focus-visible {
    outline: 2px solid var(--color-gh-accent);
    outline-offset: 1px;
  }
  .tooltip-btn:disabled {
    opacity: 0.4;
    cursor: default;
  }
  .tooltip {
    position: fixed;
    transform: translateX(-50%);
    padding: 0.25rem 0.5rem;
    font-size: 0.75rem;
    white-space: nowrap;
    border-radius: 0.25rem;
    background-color: var(--color-gh-text);
    color: var(--color-gh-bg);
    border: 1px solid var(--color-gh-border);
    box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1);
    pointer-events: none;
    z-index: 9999;
  }
</style>
