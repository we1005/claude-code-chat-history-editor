<script lang="ts">
  import type { Project, SessionMeta, SessionData } from '$lib/api'
  import { untrack } from 'svelte'
  import { formatProjectName } from '$lib/utils'
  import {
    sortProjects,
    groupProjects,
    getDisplayTitle as coreGetDisplayTitle,
    getSecondaryInfo as coreGetSecondaryInfo,
    getSessionTooltip,
    getTotalTodoCount,
    sessionHasSubItems,
    canMoveSession,
    type SessionSortField,
    type SessionSortOrder,
    type TitleDisplayMode,
    type ProjectGroup,
    type ProjectTreeNode,
    type ProjectViewMode,
  } from '@claude-sessions/core'
  import { appConfig } from '$lib/stores/config'
  import SessionActions from './SessionActions.svelte'
  import CommandTitle from './CommandTitle.svelte'
  import Icon from './Icon.svelte'
  import { sidebarOpen } from '$lib/stores/workspace'

  interface Props {
    projects: Project[]
    projectSessions: Map<string, SessionMeta[]>
    projectSessionData: Map<string, Map<string, SessionData>>
    expandedProjects: Set<string>
    selectedSession: SessionMeta | null
    loadingProject: string | null
    sortField: SessionSortField
    sortOrder: SessionSortOrder
    titleDisplayMode: TitleDisplayMode
    viewMode?: ProjectViewMode
    expandedGroups?: Set<string>
    onToggleProject: (name: string) => void
    onToggleGroup?: (name: string) => void
    onViewModeChange?: (mode: ProjectViewMode) => void
    onSelectSession: (session: SessionMeta) => void
    onCompressSession?: (e: Event, session: SessionMeta) => void
    onDeleteSession: (e: Event, session: SessionMeta) => void
    onMoveSession?: (session: SessionMeta, targetProject: string) => void
    onRenameSession: (e: Event, session: SessionMeta) => void
    onResumeSession?: (e: Event, session: SessionMeta) => void
    onSortChange?: (field: SessionSortField, order: SessionSortOrder) => void
    onTitleModeChange?: (mode: TitleDisplayMode) => void
  }

  let {
    projects,
    projectSessions,
    projectSessionData,
    expandedProjects,
    selectedSession,
    loadingProject,
    sortField,
    sortOrder,
    titleDisplayMode,
    viewMode = 'flat',
    expandedGroups = new Set<string>(),
    onToggleProject,
    onToggleGroup,
    onViewModeChange,
    onSelectSession,
    onCompressSession,
    onDeleteSession,
    onMoveSession,
    onRenameSession,
    onResumeSession,
    onSortChange,
    onTitleModeChange,
  }: Props = $props()

  // Sort field labels for display
  const sortFieldLabels: Record<SessionSortField, string> = {
    summary: '摘要更新时间',
    modified: '文件修改时间',
    created: '创建时间',
    updated: '最后消息时间',
    messageCount: '消息数量',
    title: '会话标题',
  }

  const handleSortFieldChange = (e: Event) => {
    const target = e.target as HTMLSelectElement
    onSortChange?.(target.value as SessionSortField, sortOrder)
  }

  const toggleSortOrder = () => {
    onSortChange?.(sortField, sortOrder === 'asc' ? 'desc' : 'asc')
  }

  // 3-way view mode cycle: flat -> folder-group -> date-group -> flat
  // Web currently treats date-group as flat (date grouping is vscode-only for now).
  const cycleViewMode = () => {
    const next: ProjectViewMode =
      viewMode === 'flat' ? 'folder-group' : viewMode === 'folder-group' ? 'date-group' : 'flat'
    onViewModeChange?.(next)
  }

  const viewModeLabel: Record<ProjectViewMode, string> = {
    flat: 'Flat',
    'folder-group': 'Folder',
    'date-group': 'Date',
  }

  const viewModeIcon: Record<ProjectViewMode, string> = {
    flat: 'menu',
    'folder-group': 'folder',
    'date-group': 'clock',
  }

  // Get session data with summary info
  const getSessionData = (projectName: string, sessionId: string): SessionData | undefined => {
    return projectSessionData.get(projectName)?.get(sessionId)
  }

  // Get display title using core utility (customTitle ?? title chain — agentName demoted)
  const getDisplayTitle = (session: SessionMeta): string => {
    const data = getSessionData(session.projectName, session.id)
    return coreGetDisplayTitle({
      customTitle: data?.customTitle,
      title: session.title,
      createdAt: session.createdAt,
      mode: titleDisplayMode,
    })
  }

  // Build line-2 metadata: agentName · {relativeTime} · 💬 {messageCount}
  const getSecondaryInfo = (session: SessionMeta): string => {
    const data = getSessionData(session.projectName, session.id)
    return coreGetSecondaryInfo({
      agentName: data?.agentName,
      updatedAt: data?.updatedAt ?? session.updatedAt,
      messageCount: session.messageCount,
    }).replace(/💬\s*(\d[\d,]*)/g, '$1 条消息')
  }

  // Check if session has agents or todos (using core utilities)
  const getSessionInfo = (
    session: SessionMeta
  ): { agents: number; todos: number; summaries: number } => {
    const data = getSessionData(session.projectName, session.id)
    const todoCount = data?.todos ? getTotalTodoCount(data.todos) : 0
    return {
      agents: data?.agents.length ?? 0,
      todos: todoCount,
      summaries: data?.summaries.length ?? 0,
    }
  }

  // Check if session has sub-items (using core utility)
  const hasSessionSubItems = (session: SessionMeta): boolean => {
    const data = getSessionData(session.projectName, session.id)
    if (!data) return false
    return sessionHasSubItems(data)
  }

  // Tooltip cache - invalidated when projectSessionData changes
  const tooltipCache = new Map<string, string>()
  $effect(() => {
    // Clear cache when session data changes
    void projectSessionData.size
    tooltipCache.clear()
  })

  // Get cached tooltip text
  const getCachedTooltip = (session: SessionMeta): string => {
    const key = `${session.projectName}:${session.id}`
    let tooltip = tooltipCache.get(key)
    if (!tooltip) {
      const data = getSessionData(session.projectName, session.id)
      tooltip = getSessionTooltip({
        id: session.id,
        title: session.title,
        customTitle: data?.customTitle,
        createdAt: data?.createdAt,
        updatedAt: data?.updatedAt,
      })
      tooltipCache.set(key, tooltip)
    }
    return tooltip
  }

  // Flat-mode sorted projects (existing behavior)
  const sortedProjects = $derived(
    sortProjects(projects, {
      currentProjectName: $appConfig.currentProjectName,
      homeDir: $appConfig.homeDir,
    })
  )

  // Folder-grouped tree (new)
  const treeNodes = $derived(
    groupProjects(projects, {
      sort: {
        currentProjectName: $appConfig.currentProjectName,
        homeDir: $appConfig.homeDir,
      },
    })
  )

  // Whether folder-grouping is the active rendering mode
  const isGrouped = $derived(viewMode === 'folder-group')

  // Expanded sessions state (for showing summaries, todos, agents sublist)
  let expandedSessions = $state<Set<string>>(new Set())
  let projectList: HTMLUListElement | undefined = $state()
  $effect(() => {
    const id = selectedSession?.id
    if (!id || !$sidebarOpen || !projectList) return
    const frame = requestAnimationFrame(() => {
      const target = projectList?.querySelector<HTMLElement>(
        `[data-session-select="${CSS.escape(id)}"]`
      )
      if (!target || !projectList || !projectList.clientHeight) return
      const bounds = target.getBoundingClientRect()
      const viewport = projectList.getBoundingClientRect()
      if (bounds.top < viewport.top || bounds.bottom > viewport.bottom)
        projectList.scrollTop += bounds.top - viewport.top - projectList.clientHeight / 3
    })
    return () => cancelAnimationFrame(frame)
  })

  // Auto-expand selected session
  $effect(() => {
    const id = selectedSession?.id
    if (id) {
      untrack(() => {
        if (!expandedSessions.has(id)) {
          expandedSessions.add(id)
          expandedSessions = new Set(expandedSessions)
        }
      })
    }
  })

  const toggleSessionExpand = (e: Event, sessionId: string) => {
    e.stopPropagation()
    if (expandedSessions.has(sessionId)) {
      expandedSessions.delete(sessionId)
    } else {
      expandedSessions.add(sessionId)
    }
    expandedSessions = new Set(expandedSessions)
  }

  // Drag and drop state
  let draggedSession = $state<SessionMeta | null>(null)
  let dropTargetProject = $state<string | null>(null)

  const handleDragStart = (e: DragEvent, session: SessionMeta) => {
    if (!e.dataTransfer) return
    draggedSession = session
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData(
      'text/plain',
      JSON.stringify({ id: session.id, project: session.projectName })
    )
  }

  const handleDragEnd = () => {
    draggedSession = null
    dropTargetProject = null
  }

  const handleDragOver = (e: DragEvent, projectName: string) => {
    if (!draggedSession || !canMoveSession(draggedSession.projectName, projectName)) return
    e.preventDefault()
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move'
    dropTargetProject = projectName
  }

  const handleDragLeave = () => {
    dropTargetProject = null
  }

  const handleDrop = (e: DragEvent, targetProject: string) => {
    e.preventDefault()
    dropTargetProject = null
    if (!draggedSession || !canMoveSession(draggedSession.projectName, targetProject)) return
    onMoveSession?.(draggedSession, targetProject)
    draggedSession = null
  }

  // Indent style helper for group/leaf rendering
  const indentStyle = (depth: number): string => `padding-left: ${depth * 12 + 16}px;`
</script>

<aside class="project-rail" aria-label="项目和会话">
  <div class="project-rail-heading">
    <h2 class="project-rail-title">
      <Icon name="folder" size={17} />项目<span class="project-rail-count">{projects.length}</span>
    </h2>
    <!-- Sort Options -->
    <div class="project-rail-sort">
      <select aria-label="会话排序方式" value={sortField} onchange={handleSortFieldChange}>
        {#each Object.entries(sortFieldLabels) as [value, label]}
          <option {value}>{label}</option>
        {/each}
      </select>
      <button
        class="quiet-button"
        onclick={toggleSortOrder}
        title={sortOrder === 'desc' ? 'Descending (newest first)' : 'Ascending (oldest first)'}
        aria-label={sortOrder === 'desc' ? '当前降序，切换为升序' : '当前升序，切换为降序'}
      >
        <Icon name={sortOrder === 'desc' ? 'arrowDown' : 'arrowUp'} size={15} />
      </button>
      <button
        class="quiet-button {titleDisplayMode === 'datetime' ? 'text-gh-accent' : ''}"
        onclick={() => onTitleModeChange?.(titleDisplayMode === 'message' ? 'datetime' : 'message')}
        aria-label={titleDisplayMode === 'message'
          ? 'Showing first message — click for date/time'
          : 'Showing date/time — click for first message'}
        title={titleDisplayMode === 'message'
          ? 'Showing first message — click for date/time'
          : 'Showing date/time — click for first message'}
      >
        <Icon name={titleDisplayMode === 'datetime' ? 'clock' : 'text'} size={15} />
      </button>
      <button
        class="quiet-button"
        onclick={cycleViewMode}
        aria-label={`View mode: ${viewModeLabel[viewMode]} (click to cycle)`}
        title={`View mode: ${viewModeLabel[viewMode]} (click to cycle)`}
        data-testid="view-mode-toggle"
        data-view-mode={viewMode}
      >
        <Icon name={viewModeIcon[viewMode]} size={15} />
      </button>
    </div>
  </div>

  <ul bind:this={projectList} class="project-list overflow-y-auto flex-1" data-view-mode={viewMode}>
    {#if isGrouped}
      {#each treeNodes as node}
        {@render treeNode(node)}
      {/each}
    {:else}
      {#each sortedProjects as project}
        {@render projectBlock(project, project.displayName, 0)}
      {/each}
    {/if}
  </ul>
</aside>

<!-- Recursive tree node renderer (group or leaf) -->
{#snippet treeNode(node: ProjectTreeNode)}
  {#if node.kind === 'group'}
    {@render groupBlock(node)}
  {:else}
    {@render projectBlock(node.project, node.collapsedPath, node.depth)}
  {/if}
{/snippet}

<!-- Group header + recursive children -->
{#snippet groupBlock(group: ProjectGroup)}
  {@const expanded = expandedGroups.has(group.name)}
  <li
    class="border-b border-gh-border-subtle"
    data-testid="project-group"
    data-group-name={group.name}
  >
    <button
      class="w-full py-2 bg-transparent border-none text-gh-text cursor-pointer text-left flex items-center gap-2 text-sm font-semibold hover:bg-gh-border-subtle"
      style={indentStyle(group.depth)}
      onclick={() => onToggleGroup?.(group.name)}
      aria-expanded={expanded}
    >
      <span class="text-gh-text-secondary"
        ><Icon name={expanded ? 'down' : 'right'} size={13} /></span
      >
      <span class="text-gh-text-secondary"><Icon name="folder" size={15} /></span>
      <span class="flex-1 overflow-hidden text-ellipsis whitespace-nowrap" title={group.name}>
        {group.displayName}
      </span>
      <span class="bg-gh-border px-2 py-0.5 rounded-full text-xs font-normal">
        {group.totalSessions}
      </span>
    </button>
    {#if expanded}
      <ul>
        {#each group.children as child}
          {@render treeNode(child)}
        {/each}
      </ul>
    {/if}
  </li>
{/snippet}

<!--
  Project block (group leaf or flat-mode row). Accepts an explicit displayPath so
  grouped mode can show the path-collapsed form ("github.com/es6kr/skills") instead of
  the full displayName.
-->
{#snippet projectBlock(project: Project, displayPath: string, depth: number)}
  {@const isDropTarget = dropTargetProject === project.name}
  <li class="project-folder">
    <!-- Project Header -->
    <button
      class="project-folder-button {isDropTarget
        ? 'bg-gh-green/20 ring-2 ring-gh-green ring-inset'
        : ''}"
      style={indentStyle(depth)}
      onclick={() => onToggleProject(project.name)}
      ondragover={(e) => handleDragOver(e, project.name)}
      ondragleave={handleDragLeave}
      ondrop={(e) => handleDrop(e, project.name)}
      data-testid="project-row"
      data-project-name={project.name}
      aria-expanded={expandedProjects.has(project.name)}
    >
      <span class="text-gh-text-secondary"
        ><Icon name={expandedProjects.has(project.name) ? 'down' : 'right'} size={13} /></span
      >
      <span class="text-gh-text-secondary"><Icon name="folder" size={15} /></span>
      <span class="flex-1 overflow-hidden text-ellipsis whitespace-nowrap" title={displayPath}>
        {formatProjectName(displayPath)}
      </span>
      <span class="rail-counter">
        {project.sessionCount}
      </span>
    </button>

    <!-- Sessions List -->
    {#if expandedProjects.has(project.name)}
      <ul>
        {#if loadingProject === project.name}
          <li class="py-2 px-8 text-gh-text-secondary text-sm">Loading...</li>
        {:else}
          {#each projectSessions.get(project.name) ?? [] as session (session.id)}
            {@const isSelected = selectedSession?.id === session.id}
            {@const isDragging = draggedSession?.id === session.id}
            {@const sessionInfo = getSessionInfo(session)}
            {@const displayTitle = getDisplayTitle(session)}
            {@const secondaryInfo = getSecondaryInfo(session)}
            {@const data = getSessionData(session.projectName, session.id)}
            {@const isExpanded = expandedSessions.has(session.id)}
            {@const hasSubItems = hasSessionSubItems(session)}
            {@const hasSideIcons = sessionInfo.agents > 0 || sessionInfo.todos > 0}
            <li
              class="project-session relative group {isSelected ? 'selected' : ''} {isDragging
                ? 'opacity-50'
                : ''}"
              draggable="true"
              ondragstart={(e) => handleDragStart(e, session)}
              ondragend={handleDragEnd}
            >
              <!-- Session Row (two-line: title + secondary metadata) -->
              <div class="flex items-center">
                {#if hasSubItems}
                  <button
                    class="flex-shrink-0 w-5 h-8 flex items-center justify-center bg-transparent border-none cursor-pointer text-gh-text-secondary text-xs ml-1 z-10 relative"
                    onclick={(e) => toggleSessionExpand(e, session.id)}
                    title={isExpanded ? 'Collapse' : 'Expand'}
                  >
                    <Icon name={isExpanded ? 'down' : 'right'} size={12} />
                  </button>
                {:else}
                  <span class="w-5 ml-1"></span>
                {/if}
                <div class="flex-1 min-w-0 flex">
                  <button
                    class="session-select w-full pr-3 bg-transparent text-gh-text cursor-pointer text-left flex items-center gap-2 text-[13px]"
                    onclick={() => onSelectSession(session)}
                    data-session-select={session.id}
                    title={getCachedTooltip(session)}
                    aria-current={isSelected ? 'page' : undefined}
                  >
                    <span class="flex-1 min-w-0 flex flex-col gap-0.5">
                      <!-- Line 1: title -->
                      <span class="overflow-hidden text-ellipsis whitespace-nowrap font-medium">
                        <CommandTitle title={displayTitle} />
                      </span>
                      <!-- Line 2: secondary metadata (agentName · time · 💬 count) -->
                      {#if secondaryInfo}
                        <span
                          class="overflow-hidden text-ellipsis whitespace-nowrap text-[11px] text-gh-text-secondary"
                        >
                          {secondaryInfo}
                        </span>
                      {/if}
                    </span>
                    {#if hasSideIcons}
                      <span
                        class="flex-shrink-0 flex items-center gap-2 text-xs text-gh-text-secondary"
                      >
                        {#if sessionInfo.agents > 0}
                          <span class="flex items-center gap-0.5">
                            <Icon name="spark" size={12} /><span>{sessionInfo.agents}</span>
                          </span>
                        {/if}
                        {#if sessionInfo.todos > 0}
                          <span class="flex items-center gap-0.5">
                            <Icon name="checklist" size={12} /><span>{sessionInfo.todos}</span>
                          </span>
                        {/if}
                      </span>
                    {/if}
                  </button>
                </div>

                <!-- Action buttons (visible on hover, absolute positioned) -->
                <div
                  class="session-row-actions absolute right-1 top-2 h-8 flex items-center gap-0.5 px-1 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity"
                >
                  <SessionActions
                    compact
                    onResumeSession={onResumeSession
                      ? (event) => onResumeSession?.(event, session)
                      : undefined}
                    onCompressSession={onCompressSession
                      ? (event) => onCompressSession?.(event, session)
                      : undefined}
                    onRenameSession={(event) => onRenameSession(event, session)}
                    onDeleteSession={(event) => onDeleteSession(event, session)}
                  />
                </div>
              </div>

              <!-- Session Sub Items (Summaries, Todos, Agents) -->
              {#if isExpanded && hasSubItems}
                <ul class="bg-gh-bg-secondary/50 border-t border-gh-border-subtle text-xs">
                  <!-- Summaries (oldest first, current summary at index 0) -->
                  {#if data?.summaries && data.summaries.length > 0}
                    {#each data.summaries as summary, idx}
                      <li
                        class="py-1.5 px-4 pl-8 hover:bg-gh-border-subtle/50 flex flex-col gap-0.5 {idx ===
                        0
                          ? 'text-gh-text'
                          : 'text-gh-text-secondary'}"
                        title={summary.summary}
                      >
                        <div class="flex items-start gap-2">
                          <span class="flex-shrink-0"><Icon name="file" size={13} /></span>
                          <span class="overflow-hidden text-ellipsis line-clamp-2">
                            {summary.summary.length > 100
                              ? summary.summary.slice(0, 97) + '...'
                              : summary.summary}
                          </span>
                        </div>
                        {#if summary.timestamp}
                          <span class="pl-6 text-[10px] text-gh-text-secondary/70">
                            {new Date(summary.timestamp).toLocaleString()}
                          </span>
                        {/if}
                      </li>
                    {/each}
                  {/if}
                  <!-- Todos -->
                  {#if data?.todos?.sessionTodos && data.todos.sessionTodos.length > 0}
                    <li
                      class="py-1.5 px-4 pl-8 text-gh-text-secondary hover:bg-gh-border-subtle/50 flex items-start gap-2"
                    >
                      <span class="flex-shrink-0"><Icon name="checklist" size={13} /></span>
                      <span>Session Todos ({data.todos.sessionTodos.length})</span>
                    </li>
                  {/if}
                  {#if data?.todos?.agentTodos}
                    {#each data.todos.agentTodos as agentTodo}
                      <li
                        class="py-1.5 px-4 pl-8 text-gh-text-secondary hover:bg-gh-border-subtle/50 flex items-start gap-2"
                      >
                        <span class="flex-shrink-0"><Icon name="checklist" size={13} /></span>
                        <span>Agent Todos ({agentTodo.todos.length})</span>
                      </li>
                    {/each}
                  {/if}
                  <!-- Agents -->
                  {#if data?.agents && data.agents.length > 0}
                    {#each data.agents as agent}
                      <li
                        class="py-1.5 px-4 pl-8 text-gh-text-secondary hover:bg-gh-border-subtle/50 flex items-start gap-2"
                        title={agent.name ?? agent.id}
                      >
                        <span class="flex-shrink-0"><Icon name="spark" size={13} /></span>
                        <span class="overflow-hidden text-ellipsis whitespace-nowrap">
                          {agent.name ?? agent.id.slice(0, 12) + '...'} ({agent.messageCount} msgs)
                        </span>
                      </li>
                    {/each}
                  {/if}
                </ul>
              {/if}
            </li>
          {/each}
        {/if}
      </ul>
    {/if}
  </li>
{/snippet}
