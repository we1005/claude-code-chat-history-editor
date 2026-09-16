<script lang="ts">
  import { highlightParts } from '$lib/utils/session-search'
  let { text, query = '' }: { text: string; query?: string } = $props()
  const parts = $derived(highlightParts(text, query))
</script>

{#each parts as part}
  {#if part.match}<mark class="session-search-mark">{part.text}</mark>{:else}{part.text}{/if}
{/each}
