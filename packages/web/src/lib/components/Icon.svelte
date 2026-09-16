<script lang="ts">
  let {
    name,
    size = 18,
    class: className = '',
  }: { name: string; size?: number; class?: string } = $props()
  const paths: Record<string, string> = {
    edit: 'M16 3l5 5M4 20l4-1 12-12a2.8 2.8 0 0 0-4-4L4 15v5Z',
    trash: 'M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7',
    play: 'm8 5 11 7-11 7V5Z',
    archive: 'M3 3h18v5H3V3ZM5 8v13h14V8M9 12h6m-3 0v5m-3-3 3 3 3-3',
    scissors:
      'M4 4a3 3 0 1 0 0 6 3 3 0 0 0 0-6ZM4 14a3 3 0 1 0 0 6 3 3 0 0 0 0-6ZM7 8l14 12M7 16 21 4',
    folder: 'M3 5h6l2 2h10v13H3V5Z',
    file: 'M14 2H5v20h14V7l-5-5Zm0 0v5h5M8 12h8M8 16h6',
    message: 'M21 4H3v13h5l4 4v-4h9V4ZM7 8h10M7 12h6',
    user: 'M12 3a4 4 0 1 0 0 8 4 4 0 0 0 0-8ZM4 21v-2a8 6 0 0 1 16 0v2',
    spark: 'm12 3 2.6 6.4L21 12l-6.4 2.6L12 21l-2.6-6.4L3 12l6.4-2.6L12 3Z',
    check: 'm5 12 4 4L19 6',
    checklist: 'M9 5h12M9 12h12M9 19h12M2 5l1 1 3-3M2 12l1 1 3-3M2 19l1 1 3-3',
    clock: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Zm0 4v6l4 2',
    search: 'M10 3a7 7 0 1 0 0 14 7 7 0 0 0 0-14Zm5 12 6 6',
    sliders: 'M4 5h16M4 12h16M4 19h16M8 3v4M16 10v4M10 17v4',
    panel: 'M3 3h18v18H3V3ZM9 3v18',
    menu: 'M4 6h16M4 12h16M4 18h16',
    more: 'M5 11v2M12 11v2M19 11v2',
    down: 'm6 9 6 6 6-6',
    up: 'm6 15 6-6 6 6',
    right: 'm9 6 6 6-6 6',
    left: 'm15 6-6 6 6 6',
    first: 'm6 12 6-6 6 6M6 5h12M6 20l6-6 6 6',
    last: 'm6 4 6 6 6-6M6 19h12M6 12l6 6 6-6',
    arrowDown: 'M12 3v18m-6-6 6 6 6-6',
    arrowUp: 'M12 21V3m-6 6 6-6 6 6',
    text: 'M3 5h18M12 5v15M8 20h8',
    copy: 'M8 8h13v13H8V8ZM16 8V3H3v13h5',
    refresh: 'M20 7v5h-5M4 17v-5h5M5.5 7a8 8 0 0 1 13-2L20 8M4 16l1.5 3a8 8 0 0 0 13-2',
    close: 'm6 6 12 12M6 18 18 6',
    power: 'M12 2v10M6 5a9 9 0 1 0 12 0',
    bookmark: 'M5 3h14v19l-7-5-7 5V3Z',
    square: 'M5 5h14v14H5V5Z',
    terminal: 'm4 6 6 6-6 6m9 0h7',
    activity: 'M2 12h5l3-8 4 16 3-8h5',
  }
</script>

<svg
  width={size}
  height={size}
  viewBox="0 0 24 24"
  fill="none"
  stroke="currentColor"
  stroke-width="1.7"
  stroke-linecap="round"
  stroke-linejoin="round"
  class={`inline-block align-middle shrink-0 ${className}`}
  aria-hidden="true"
  focusable="false"
>
  <path d={paths[name] || paths.file} />
</svg>
