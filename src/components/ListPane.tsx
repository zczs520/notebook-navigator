/*
 * Notebook Navigator - Plugin for Obsidian
 * Copyright (c) 2025-2026 Johan Sanneblad
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 */

/**
 * OPTIMIZATIONS:
 *
 * 1. React.memo with forwardRef - Only re-renders on prop changes
 *
 * 2. Virtualization:
 *    - TanStack Virtual for rendering only visible items
 *    - Estimated row heights from fixed measurements and visible row sections
 *    - Direct memory cache lookups in estimateSize function
 *    - Virtualizer refreshes size estimates when row-height inputs change
 *
 * 3. List building optimization:
 *    - useMemo rebuilds list items only when dependencies change
 *    - File filtering happens once during list build
 *    - Sort operations optimized with pre-computed values
 *    - Pinned files handled separately for efficiency
 *
 * 4. Event handling:
 *    - Debounced vault event handlers via forceUpdate
 *    - Selective updates based on file location (folder/tag context)
 *    - Database content changes trigger selective size-estimate refreshes
 *
 * 5. Selection handling:
 *    - Stable file index for onClick handlers
 *    - Multi-selection support without re-render
 *    - Keyboard navigation optimized
 */

import React, { useRef, useEffect, useImperativeHandle, forwardRef, useState, useMemo, useLayoutEffect } from 'react';
import { TFile, Platform } from 'obsidian';
import { Virtualizer } from '@tanstack/react-virtual';
import { useSelectionState, useSelectionDispatch } from '../context/SelectionContext';
import { useServices } from '../context/ServicesContext';
import { useSettingsState, useActiveProfile, useSettingsDerived } from '../context/SettingsContext';
import { useUIState } from '../context/UIStateContext';
import { useFileCache } from '../context/StorageContext';
import { useShortcuts } from '../context/ShortcutsContext';
import { useListPaneKeyboard } from '../hooks/useListPaneKeyboard';
import { useListPaneData } from '../hooks/useListPaneData';
import { useListPaneScroll } from '../hooks/useListPaneScroll';
import { useListPaneTitle } from '../hooks/useListPaneTitle';
import { useListPaneAppearance } from '../hooks/useListPaneAppearance';
import { useListPaneSearch, type SearchQueryUpdateOptions } from '../hooks/useListPaneSearch';
import { useListPaneSelectionCoordinator } from '../hooks/useListPaneSelectionCoordinator';
import type { EnsureSelectionOptions, EnsureSelectionResult, SelectFileOptions } from '../hooks/useListPaneSelectionCoordinator';
import { useContextMenu } from '../hooks/useContextMenu';
import { IOS_FLOATING_TOOLBAR_HEIGHT_PX, ListPaneItemType, type CSSPropertiesWithVars } from '../types';
import { getEffectiveSortOption } from '../utils/sortUtils';
import { ListPaneHeader } from './ListPaneHeader';
import { ListToolbar } from './ListToolbar';
import { Calendar } from './calendar';
import { SearchInput } from './SearchInput';
import { ListPaneTitleArea } from './ListPaneTitleArea';
import { ListPaneVirtualContent, getHoveredFilePathAtPointer, type PointerClientPosition } from './listPane/ListPaneVirtualContent';
import type { FileItemStorageHelpers } from './FileItem';
import { type SearchShortcut } from '../types/shortcuts';
import { type SearchNavFilterState } from '../types/search';
import { EMPTY_LIST_MENU_TYPE } from '../utils/contextMenu';
import { useUXPreferences } from '../context/UXPreferencesContext';
import { type InclusionOperator } from '../utils/filterSearch';
import type { FolderDecorationModel } from '../utils/folderDecoration';
import { useSurfaceColorVariables } from '../hooks/useSurfaceColorVariables';
import { LIST_PANE_SURFACE_COLOR_MAPPINGS } from '../constants/surfaceColorMappings';
import { getListPaneMeasurements } from '../utils/listPaneMeasurements';
import { createHiddenTagVisibility } from '../utils/tagPrefixMatcher';
import { getPropertyKeySet } from '../utils/vaultProfiles';
import { DateUtils } from '../utils/dateUtils';
import type { NavigateToFolderOptions, RevealPropertyOptions, RevealTagOptions } from '../hooks/useNavigatorReveal';
import type { FileItemPillDecorationModel } from '../utils/fileItemPillDecoration';
import { compositeWithBase } from '../utils/colorUtils';
import { runAsyncAction } from '../utils/async';
import { getPinnedSectionCollapseKey } from '../utils/selectionUtils';
import { isImageFile } from '../utils/fileTypeUtils';

/**
 * Renders the list pane displaying files from the selected folder.
 * Handles file sorting, grouping by date or folder, pinned notes, and auto-selection.
 * Integrates with the app context to manage file selection and navigation.
 *
 * @returns A scrollable list of files grouped by date or folder with empty state handling
 */
interface ExecuteSearchShortcutParams {
    searchShortcut: SearchShortcut;
}

export type { SelectFileOptions };

export interface ListPaneHandle {
    getIndexOfPath: (path: string) => number;
    virtualizer: Virtualizer<HTMLDivElement, Element> | null;
    scrollContainerRef: HTMLDivElement | null;
    selectFile: (file: TFile, options?: SelectFileOptions) => void;
    selectAdjacentFile: (direction: 'next' | 'previous') => boolean;
    modifySearchWithTag: (tag: string, operator: InclusionOperator, options?: SearchQueryUpdateOptions) => void;
    modifySearchWithProperty: (key: string, value: string | null, operator: InclusionOperator, options?: SearchQueryUpdateOptions) => void;
    modifySearchWithDateToken: (dateToken: string, options?: SearchQueryUpdateOptions) => void;
    toggleSearch: () => void;
    executeSearchShortcut: (params: ExecuteSearchShortcutParams) => Promise<void>;
}

interface ListPaneProps {
    /**
     * Reference to the root navigator container (.nn-split-container).
     * This is passed from NotebookNavigatorComponent to ensure keyboard events
     * are captured at the navigator level, not globally. This allows proper
     * keyboard navigation between panes while preventing interference with
     * other Obsidian views.
     */
    rootContainerRef: React.RefObject<HTMLDivElement | null>;
    /**
     * Optional resize handle props for dual-pane mode.
     * When provided, renders a resize handle overlay on the list pane boundary.
     */
    resizeHandleProps?: {
        onPointerDown: (e: React.PointerEvent<HTMLDivElement>) => void;
    };
    /**
     * Callback invoked whenever tag-related search tokens change.
     */
    onSearchTokensChange?: (state: SearchNavFilterState) => void;
    folderDecorationModel: FolderDecorationModel;
    fileItemPillDecorationModel: FileItemPillDecorationModel;
    onNavigateToFolder: (folderPath: string, options?: NavigateToFolderOptions) => void;
    onRevealTag: (tagPath: string, options?: RevealTagOptions) => void;
    onRevealProperty: (propertyNodeId: string, options?: RevealPropertyOptions) => boolean;
}

interface ListPaneTitleChromeProps {
    onHeaderClick?: () => void;
    isSearchActive?: boolean;
    onSearchToggle?: () => void;
    shouldShowDesktopTitleArea: boolean;
    children: React.ReactNode;
}

function ListPaneTitleChrome({
    onHeaderClick,
    isSearchActive,
    onSearchToggle,
    shouldShowDesktopTitleArea,
    children
}: ListPaneTitleChromeProps) {
    const { desktopTitle, breadcrumbSegments, iconName, showIcon } = useListPaneTitle();
    return (
        <>
            <ListPaneHeader
                onHeaderClick={onHeaderClick}
                isSearchActive={isSearchActive}
                onSearchToggle={onSearchToggle}
                desktopTitle={desktopTitle}
                breadcrumbSegments={breadcrumbSegments}
                iconName={iconName}
                showIcon={showIcon}
            />
            {children}
            {shouldShowDesktopTitleArea ? <ListPaneTitleArea desktopTitle={desktopTitle} /> : null}
        </>
    );
}

export const ListPane = React.memo(
    forwardRef<ListPaneHandle, ListPaneProps>(function ListPane(props, ref) {
        const { app, isMobile, plugin } = useServices();
        const { onNavigateToFolder, onRevealTag, onRevealProperty, folderDecorationModel, fileItemPillDecorationModel } = props;
        const selectionState = useSelectionState();
        const selectionDispatch = useSelectionDispatch();
        const settings = useSettingsState();
        const activeProfile = useActiveProfile();
        const { fileNameIconNeedles } = useSettingsDerived();
        const uxPreferences = useUXPreferences();
        const includeDescendantNotes = uxPreferences.includeDescendantNotes;
        const showHiddenItems = uxPreferences.showHiddenItems;
        const showCalendar = uxPreferences.showCalendar;
        const appearanceSettings = useListPaneAppearance();
        const { getFileDisplayName, getDB, getFileTimestamps, hasPreview, regenerateFeatureImageForFile } = useFileCache();
        const { noteShortcutKeysByPath, addNoteShortcut, removeShortcut } = useShortcuts();
        const uiState = useUIState();
        const isVerticalDualPane = !uiState.singlePane && settings.dualPaneOrientation === 'vertical';
        const calendarPlacement = settings.calendarPlacement;
        const shouldRenderCalendarOverlay =
            settings.calendarEnabled && calendarPlacement === 'left-sidebar' && showCalendar && isVerticalDualPane;
        const listPaneRef = useRef<HTMLDivElement>(null);
        const hoverPointerClientPositionRef = useRef<PointerClientPosition | null>(null);
        // Android uses toolbar at top, iOS at bottom
        const isAndroid = Platform.isAndroidApp;
        /** Maps semi-transparent theme color variables to computed opaque equivalents (see constants/surfaceColorMappings). */
        const { color: listSurfaceColor, version: listSurfaceVersion } = useSurfaceColorVariables(listPaneRef, {
            app,
            rootContainerRef: props.rootContainerRef,
            variables: LIST_PANE_SURFACE_COLOR_MAPPINGS
        });
        const solidBackgroundCacheRef = useRef<Map<string, string | undefined>>(new Map());
        const [calendarWeekCount, setCalendarWeekCount] = useState<number>(() => settings.calendarWeeksToShow);
        const [isListScrolling, setIsListScrolling] = useState(false);
        const [hoveredFilePath, setHoveredFilePath] = useState<string | null>(null);
        const addNoteShortcutRef = useRef(addNoteShortcut);
        const removeShortcutRef = useRef(removeShortcut);
        const dateSearchGuardRef = useRef<{ query: string; originPath: string | null; armed: boolean } | null>(null);
        const listPaneTitle = settings.listPaneTitle ?? 'header';
        const shouldShowDesktopTitleArea = !isMobile && listPaneTitle === 'list';
        const listMeasurements = getListPaneMeasurements(isMobile);
        const topSpacerHeight = shouldShowDesktopTitleArea ? 0 : listMeasurements.topSpacer;
        const iconColumnStyle = useMemo(() => {
            if (settings.showFileIcons) {
                return undefined;
            }
            return {
                '--nn-file-icon-slot-width': '0px',
                '--nn-file-icon-slot-width-mobile': '0px',
                '--nn-file-icon-slot-gap': '0px'
            } as React.CSSProperties;
        }, [settings.showFileIcons]);
        const listPaneStyle = useMemo<CSSPropertiesWithVars>(() => {
            return {
                ...(iconColumnStyle ?? {}),
                '--nn-calendar-week-count': calendarWeekCount
            };
        }, [calendarWeekCount, iconColumnStyle]);

        useEffect(() => {
            if (settings.calendarWeeksToShow !== 6) {
                setCalendarWeekCount(settings.calendarWeeksToShow);
            }
        }, [settings.calendarWeeksToShow]);

        useEffect(() => {
            solidBackgroundCacheRef.current.clear();
        }, [listSurfaceColor, listSurfaceVersion]);

        const getSolidBackground = useMemo(() => {
            return (color?: string | null) => {
                void listSurfaceVersion;
                if (!color) {
                    return undefined;
                }
                const trimmed = color.trim();
                if (!trimmed) {
                    return undefined;
                }
                const cache = solidBackgroundCacheRef.current;
                if (cache.has(trimmed)) {
                    return cache.get(trimmed);
                }
                const pane = listPaneRef.current;
                const solidColor = compositeWithBase(listSurfaceColor, trimmed, { container: pane ?? null });
                cache.set(trimmed, solidColor);
                return solidColor;
            };
        }, [listSurfaceColor, listSurfaceVersion]);

        const shouldUseFloatingToolbars = isMobile && Platform.isIosApp && settings.useFloatingToolbars;
        const scrollPaddingEnd = useMemo(() => {
            if (!shouldUseFloatingToolbars) {
                return 0;
            }

            // Keep in sync with `--nn-ios-pane-bottom-overlay-height` in `src/styles/sections/platform-ios.css`.
            // The calendar overlay is outside the scroller, so it is intentionally not included here.
            return IOS_FLOATING_TOOLBAR_HEIGHT_PX;
        }, [shouldUseFloatingToolbars]);
        const ensureSelectionForCurrentFilterRef = useRef<((options?: EnsureSelectionOptions) => EnsureSelectionResult) | null>(null);
        const {
            isSearchActive,
            searchProvider,
            searchQuery,
            debouncedSearchQuery,
            debouncedSearchTokens,
            searchHighlightQuery,
            shouldFocusSearch,
            activeSearchShortcut,
            isSavingSearchShortcut,
            suppressSearchTopScrollRef,
            setSearchQuery,
            handleSearchToggle,
            closeSearch,
            focusSearchComplete,
            handleSaveSearchShortcut,
            handleRemoveSearchShortcut,
            modifySearchWithTag,
            modifySearchWithProperty,
            modifySearchWithDateToken,
            toggleSearch,
            executeSearchShortcut
        } = useListPaneSearch({
            rootContainerRef: props.rootContainerRef,
            onSearchTokensChange: props.onSearchTokensChange,
            onNavigateToFolder,
            onRevealTag,
            onRevealProperty,
            ensureSelectionForCurrentFilterRef
        });

        const { selectionType, selectedFolder, selectedTag, selectedProperty, selectedFile } = selectionState;
        useEffect(() => {
            if (!isSearchActive) {
                dateSearchGuardRef.current = null;
                return;
            }

            const normalizedQuery = searchQuery.trim();
            const dateMatch = normalizedQuery.match(/^@c:(\d{4}-\d{2}-\d{2})$/);
            if (!dateMatch) {
                dateSearchGuardRef.current = null;
                return;
            }

            const selectedPath = selectedFile?.path ?? null;
            const guard = dateSearchGuardRef.current;
            if (!guard || guard.query !== normalizedQuery) {
                dateSearchGuardRef.current = { query: normalizedQuery, originPath: selectedPath, armed: false };
                return;
            }

            if (!selectedFile) {
                return;
            }

            if (!guard.armed && selectedPath === guard.originPath) {
                return;
            }
            guard.armed = true;

            const timestamps = getFileTimestamps(selectedFile);
            const createdDate = new Date(timestamps.created);
            if (!Number.isFinite(createdDate.getTime())) {
                closeSearch();
                return;
            }

            const year = createdDate.getFullYear();
            const month = `${createdDate.getMonth() + 1}`.padStart(2, '0');
            const day = `${createdDate.getDate()}`.padStart(2, '0');
            const selectedFileDate = `${year}-${month}-${day}`;
            if (selectedFileDate !== dateMatch[1]) {
                closeSearch();
            }
        }, [closeSearch, getFileTimestamps, isSearchActive, searchQuery, selectedFile]);
        const pinnedCollapseKey = getPinnedSectionCollapseKey({ selectionType, selectedFolder, selectedTag, selectedProperty });
        const pinnedGroupExpanded = settings.collapsedPinnedContexts[pinnedCollapseKey] !== true;
        const handlePinnedGroupHeaderToggle = React.useCallback(() => {
            runAsyncAction(() => plugin.togglePinnedGroupCollapsed(pinnedCollapseKey));
        }, [pinnedCollapseKey, plugin]);

        // Determine if list pane is visible early to optimize
        const isVisible = !uiState.singlePane || uiState.currentSinglePaneView === 'files';
        const onlyWithImages = appearanceSettings.mode === 'gallery' || uiState.noteImageFilter === 'images';

        // Use the new data hook
        const { listItems, orderedFiles, orderedFileIndexMap, filePathToIndex, files, localDayKey } = useListPaneData({
            selectionType,
            selectedFolder,
            selectedTag,
            selectedProperty,
            settings,
            activeProfile,
            groupBy: appearanceSettings.groupBy,
            pinnedGroupExpanded,
            searchProvider,
            // Use debounced value for filtering
            searchQuery: isSearchActive ? debouncedSearchQuery : undefined,
            searchTokens: isSearchActive ? debouncedSearchTokens : undefined,
            visibility: { includeDescendantNotes, showHiddenItems },
            onlyWithImages
        });
        const listStartsWithGroupHeader =
            listItems[0]?.type === ListPaneItemType.TOP_SPACER && listItems[1]?.type === ListPaneItemType.HEADER;
        const effectiveTopSpacerHeight = settings.stickyGroupHeaders && listStartsWithGroupHeader ? 0 : topSpacerHeight;
        const localDayReference = useMemo(() => DateUtils.parseLocalDayKey(localDayKey), [localDayKey]);

        // Determine the target folder path for drag-and-drop of external files
        const activeFolderDropPath = useMemo(() => {
            if (selectionType !== 'folder' || !selectedFolder) {
                return null;
            }
            return selectedFolder.path;
        }, [selectionType, selectedFolder]);
        const { visibleListPropertyKeys, visibleNavigationPropertyKeys } = useMemo(() => {
            return {
                visibleListPropertyKeys: getPropertyKeySet(activeProfile.propertyKeys, 'list'),
                visibleNavigationPropertyKeys: getPropertyKeySet(activeProfile.propertyKeys, 'navigation')
            };
        }, [activeProfile.propertyKeys]);
        const fileItemStorage = useMemo<FileItemStorageHelpers>(
            () => ({
                getFileDisplayName,
                getDB,
                getFileTimestamps,
                hasPreview,
                regenerateFeatureImageForFile
            }),
            [getFileDisplayName, getDB, getFileTimestamps, hasPreview, regenerateFeatureImageForFile]
        );
        const hiddenTagVisibility = useMemo(
            () => createHiddenTagVisibility(activeProfile.hiddenTags, showHiddenItems),
            [activeProfile.hiddenTags, showHiddenItems]
        );
        const syncHoveredFilePathToPointer = React.useCallback((scrollElement: HTMLDivElement | null) => {
            const nextHoveredFilePath = getHoveredFilePathAtPointer(scrollElement, hoverPointerClientPositionRef.current);
            setHoveredFilePath(previous => (previous === nextHoveredFilePath ? previous : nextHoveredFilePath));
        }, []);
        const handleVirtualizerScrollingChange = React.useCallback(
            (isScrolling: boolean, scrollElement: HTMLDivElement | null) => {
                if (isScrolling) {
                    setIsListScrolling(previous => (previous ? previous : true));
                    setHoveredFilePath(previous => (previous === null ? previous : null));
                    return;
                }

                syncHoveredFilePathToPointer(scrollElement);
                setIsListScrolling(false);
            },
            [syncHoveredFilePathToPointer]
        );
        const visibleListPropertyKeySignature = useMemo(() => {
            if (visibleListPropertyKeys.size === 0) {
                return '';
            }

            const sortedKeys = Array.from(visibleListPropertyKeys);
            sortedKeys.sort();
            return sortedKeys.join('\u0001');
        }, [visibleListPropertyKeys]);

        // Use the new scroll hook
        const { rowVirtualizer, scrollContainerRef, scrollContainerRefCallback, handleScrollToTop, scrollToIndexSafely } =
            useListPaneScroll({
                listItems,
                filePathToIndex,
                selectedFile,
                selectedFolder,
                selectedTag,
                selectedProperty,
                settings,
                folderSettings: appearanceSettings,
                isVisible,
                selectionState,
                selectionDispatch,
                // Use debounced value for scroll orchestration to align with filtering
                searchQuery: isSearchActive ? debouncedSearchQuery : undefined,
                suppressSearchTopScrollRef,
                topSpacerHeight: effectiveTopSpacerHeight,
                includeDescendantNotes,
                pinnedGroupExpanded,
                visiblePropertyKeys: visibleListPropertyKeys,
                visiblePropertyKeySignature: visibleListPropertyKeySignature,
                hiddenTagVisibility,
                scrollMargin: 0,
                scrollPaddingEnd,
                onVirtualizerScrollingChange: handleVirtualizerScrollingChange
            });

        const isCardLayoutMode = appearanceSettings.mode === 'gallery' || appearanceSettings.mode === 'feed';
        const cardColumnCount = appearanceSettings.mode === 'gallery' ? 2 : 1;
        const galleryCardRowHeight = isMobile ? 348 : 328;
        const feedImageCardRowHeight = isMobile ? 316 : 320;
        const feedTextCardRowHeight = isMobile ? 184 : 188;
        const hasCardImage = React.useCallback(
            (file: TFile) => {
                if (!appearanceSettings.showImage) {
                    return false;
                }

                if (isImageFile(file)) {
                    return true;
                }

                const record = getDB().getFile(file.path);
                if (record?.featureImageStatus === 'has' || Boolean(record?.featureImageKey)) {
                    return true;
                }

                if (file.extension !== 'md') {
                    return false;
                }

                const embeds = app.metadataCache.getFileCache(file)?.embeds ?? [];
                return embeds.some(embed => {
                    const target = app.metadataCache.getFirstLinkpathDest(embed.link, file.path);
                    return target instanceof TFile && isImageFile(target);
                });
            },
            [app.metadataCache, appearanceSettings.showImage, getDB]
        );
        const cardRowLayoutByListIndex = useMemo(() => {
            const layouts = new Map<number, { offset: number; height: number }>();
            if (!isCardLayoutMode) {
                return layouts;
            }

            let columnIndex = 0;
            let rowOffset = 0;
            let rowHeight = galleryCardRowHeight;

            listItems.forEach((item, listIndex) => {
                if (item.type !== ListPaneItemType.FILE || !(item.data instanceof TFile)) {
                    return;
                }

                if (columnIndex === 0) {
                    rowHeight =
                        appearanceSettings.mode === 'gallery'
                            ? galleryCardRowHeight
                            : hasCardImage(item.data)
                              ? feedImageCardRowHeight
                              : feedTextCardRowHeight;
                }

                layouts.set(listIndex, { offset: rowOffset, height: rowHeight });
                columnIndex += 1;

                if (columnIndex >= cardColumnCount) {
                    rowOffset += rowHeight;
                    columnIndex = 0;
                }
            });

            return layouts;
        }, [
            appearanceSettings.mode,
            cardColumnCount,
            feedImageCardRowHeight,
            feedTextCardRowHeight,
            galleryCardRowHeight,
            hasCardImage,
            isCardLayoutMode,
            listItems
        ]);
        const scrollToIndexForCurrentMode = React.useCallback(
            (index: number, align: 'start' | 'center' | 'end' | 'auto') => {
                if (!isCardLayoutMode) {
                    scrollToIndexSafely(index, align);
                    return;
                }

                const scrollElement = scrollContainerRef.current;
                const cardRowLayout = cardRowLayoutByListIndex.get(index);
                if (!scrollElement || !cardRowLayout) {
                    scrollToIndexSafely(index, align);
                    return;
                }

                const viewportHeight = scrollElement.clientHeight;
                const viewportTop = scrollElement.scrollTop;
                const viewportBottom = viewportTop + viewportHeight;
                const visibilityPadding = 16;
                const rowTop = cardRowLayout.offset;
                const rowBottom = rowTop + cardRowLayout.height;

                if (align === 'auto' && rowTop >= viewportTop + visibilityPadding && rowBottom <= viewportBottom - visibilityPadding) {
                    return;
                }

                const targetTop =
                    align === 'center'
                        ? rowTop - viewportHeight / 2 + cardRowLayout.height / 2
                        : align === 'end'
                          ? rowBottom - viewportHeight
                          : rowTop - visibilityPadding;

                scrollElement.scrollTo({ top: Math.max(0, targetTop), behavior: 'auto' });
            },
            [cardRowLayoutByListIndex, isCardLayoutMode, scrollContainerRef, scrollToIndexSafely]
        );

        const prevCalendarOverlayVisibleRef = useRef<boolean>(shouldRenderCalendarOverlay);
        const prevCalendarWeekCountRef = useRef<number>(calendarWeekCount);

        useEffect(() => {
            const wasVisible = prevCalendarOverlayVisibleRef.current;
            const prevWeekCount = prevCalendarWeekCountRef.current;

            const becameVisible = shouldRenderCalendarOverlay && !wasVisible;
            const weekCountChanged = shouldRenderCalendarOverlay && calendarWeekCount !== prevWeekCount;

            prevCalendarOverlayVisibleRef.current = shouldRenderCalendarOverlay;
            prevCalendarWeekCountRef.current = calendarWeekCount;

            if (!becameVisible && !weekCountChanged) {
                return;
            }

            if (!selectedFile) {
                return;
            }

            const index = filePathToIndex.get(selectedFile.path);
            if (index === undefined) {
                return;
            }

            const scheduleScroll = () => scrollToIndexForCurrentMode(index, 'auto');

            if (typeof requestAnimationFrame !== 'undefined') {
                requestAnimationFrame(() => {
                    requestAnimationFrame(scheduleScroll);
                });
                return;
            }

            activeWindow.setTimeout(scheduleScroll, 0);
        }, [calendarWeekCount, filePathToIndex, scrollToIndexForCurrentMode, selectedFile, shouldRenderCalendarOverlay]);

        const listToolbar = useMemo(() => {
            return <ListToolbar isSearchActive={isSearchActive} onSearchToggle={handleSearchToggle} />;
        }, [handleSearchToggle, isSearchActive]);

        useEffect(() => {
            if (!isCardLayoutMode || !selectedFile) {
                return;
            }

            const index = filePathToIndex.get(selectedFile.path);
            if (index === undefined) {
                return;
            }

            let firstFrame = 0;
            let secondFrame = 0;
            firstFrame = activeWindow.requestAnimationFrame(() => {
                secondFrame = activeWindow.requestAnimationFrame(() => {
                    scrollToIndexForCurrentMode(index, 'auto');
                });
            });

            return () => {
                activeWindow.cancelAnimationFrame(firstFrame);
                activeWindow.cancelAnimationFrame(secondFrame);
            };
        }, [filePathToIndex, isCardLayoutMode, scrollToIndexForCurrentMode, selectedFile]);

        const handleHoveredFilePathChange = React.useCallback(
            (path: string | null, pointerClientPosition: PointerClientPosition | null) => {
                hoverPointerClientPositionRef.current = pointerClientPosition;
                setHoveredFilePath(previous => (previous === path ? previous : path));
            },
            []
        );

        useLayoutEffect(() => {
            if (isListScrolling) {
                return;
            }

            syncHoveredFilePathToPointer(scrollContainerRef.current);
        }, [isListScrolling, listItems, scrollContainerRef, syncHoveredFilePathToPointer]);

        useEffect(() => {
            addNoteShortcutRef.current = addNoteShortcut;
            removeShortcutRef.current = removeShortcut;
        }, [addNoteShortcut, removeShortcut]);

        // Attach context menu to empty areas in the list pane for file creation
        useContextMenu(scrollContainerRef, { type: EMPTY_LIST_MENU_TYPE, item: selectedFolder ?? null });

        // Check if we're in compact mode
        const isCompactMode = !appearanceSettings.showDate && !appearanceSettings.showPreview && !appearanceSettings.showImage;
        const {
            selectFileFromList,
            selectAdjacentFile,
            ensureSelectionForCurrentFilter,
            handleFileItemClick,
            lastSelectedFilePath,
            isFileSelected,
            scheduleKeyboardSelectionOpen,
            scheduleKeyboardSelectionOpenForFile,
            commitPendingKeyboardSelectionOpen
        } = useListPaneSelectionCoordinator({
            rootContainerRef: props.rootContainerRef,
            orderedFiles,
            filePathToIndex,
            scrollToIndexSafely: scrollToIndexForCurrentMode
        });
        ensureSelectionForCurrentFilterRef.current = ensureSelectionForCurrentFilter;
        const toggleNoteShortcut = React.useCallback(async (file: TFile, shortcutKey: string | undefined) => {
            if (shortcutKey) {
                await removeShortcutRef.current(shortcutKey);
                return;
            }

            await addNoteShortcutRef.current(file.path);
        }, []);

        const effectiveSortOption = getEffectiveSortOption(settings, selectionType, selectedFolder, selectedTag, selectedProperty);

        // Expose the virtualizer instance and file lookup method via the ref
        useImperativeHandle(
            ref,
            () => ({
                getIndexOfPath: (path: string) => filePathToIndex.get(path) ?? -1,
                virtualizer: rowVirtualizer,
                scrollContainerRef: scrollContainerRef.current,
                // Allow parent components to trigger file selection programmatically
                selectFile: selectFileFromList,
                // Provide imperative adjacent navigation for command handlers
                selectAdjacentFile,
                // Toggle or modify search query to include/exclude a tag with AND/OR operator
                modifySearchWithTag,
                // Toggle or modify search query to include/exclude a property with AND/OR operator
                modifySearchWithProperty,
                // Replace the active search query with a date token
                modifySearchWithDateToken,
                // Toggle search mode on/off or focus existing search
                toggleSearch,
                executeSearchShortcut
            }),
            [
                filePathToIndex,
                rowVirtualizer,
                scrollContainerRef,
                toggleSearch,
                executeSearchShortcut,
                selectFileFromList,
                selectAdjacentFile,
                modifySearchWithTag,
                modifySearchWithProperty,
                modifySearchWithDateToken
            ]
        );

        // Add keyboard navigation
        // Note: We pass the root container ref, not the scroll container ref.
        // This ensures keyboard events work across the entire navigator, allowing
        // users to navigate between panes (navigation <-> files) with Tab/Arrow keys.
        useListPaneKeyboard({
            items: listItems,
            virtualizer: rowVirtualizer,
            containerRef: props.rootContainerRef,
            pathToIndex: filePathToIndex,
            orderedFiles,
            orderedFileIndexMap,
            scrollToIndexSafely: scrollToIndexForCurrentMode,
            onSelectFile: (file, options) =>
                selectFileFromList(file, {
                    markKeyboardNavigation: true,
                    suppressOpen: settings.enterToOpenFiles || options?.suppressOpen,
                    debounceOpen: options?.debounceOpen
                }),
            onScheduleKeyboardOpen: scheduleKeyboardSelectionOpen,
            onScheduleKeyboardOpenForFile: scheduleKeyboardSelectionOpenForFile,
            onCommitKeyboardOpen: commitPendingKeyboardSelectionOpen
        });

        // Determine if we're showing empty state
        const isEmptySelection = !selectedFolder && !selectedTag && !selectedProperty;
        const hasNoFiles = files.length === 0;

        const shouldRenderBottomToolbar = isMobile && !isAndroid;
        const shouldRenderBottomToolbarInsidePanel = shouldRenderBottomToolbar && shouldUseFloatingToolbars;
        const shouldRenderBottomToolbarOutsidePanel = shouldRenderBottomToolbar && !shouldUseFloatingToolbars;

        // Single return with conditional content
        return (
            <div
                ref={listPaneRef}
                className={`nn-list-pane ${isSearchActive ? 'nn-search-active' : ''}`}
                style={listPaneStyle}
                data-calendar={shouldRenderCalendarOverlay ? 'true' : undefined}
            >
                {props.resizeHandleProps && <div className="nn-resize-handle" {...props.resizeHandleProps} />}
                <div className="nn-list-pane-chrome">
                    <ListPaneTitleChrome
                        onHeaderClick={handleScrollToTop}
                        isSearchActive={isSearchActive}
                        onSearchToggle={handleSearchToggle}
                        shouldShowDesktopTitleArea={shouldShowDesktopTitleArea}
                    >
                        {/* Android - toolbar at top */}
                        {isMobile && isAndroid ? listToolbar : null}
                        {/* Search bar - collapsible */}
                        <div className={`nn-search-bar-container ${isSearchActive ? 'nn-search-bar-visible' : ''}`}>
                            {isSearchActive && (
                                <SearchInput
                                    searchQuery={searchQuery}
                                    onSearchQueryChange={setSearchQuery}
                                    shouldFocus={shouldFocusSearch}
                                    onFocusComplete={focusSearchComplete}
                                    onClose={closeSearch}
                                    onFocusFiles={() => {
                                        // Ensure selection exists when focusing list from search (no editor open)
                                        ensureSelectionForCurrentFilter({ openInEditor: false });
                                    }}
                                    containerRef={props.rootContainerRef}
                                    onSaveShortcut={!activeSearchShortcut ? handleSaveSearchShortcut : undefined}
                                    onRemoveShortcut={activeSearchShortcut ? handleRemoveSearchShortcut : undefined}
                                    isShortcutSaved={Boolean(activeSearchShortcut)}
                                    isShortcutDisabled={isSavingSearchShortcut}
                                    searchProvider={searchProvider}
                                />
                            )}
                        </div>
                    </ListPaneTitleChrome>
                </div>
                <div className="nn-list-pane-panel">
                    <ListPaneVirtualContent
                        listItems={listItems}
                        rowVirtualizer={rowVirtualizer}
                        scrollContainerRefCallback={scrollContainerRefCallback}
                        activeFolderDropPath={activeFolderDropPath}
                        isCompactMode={isCompactMode}
                        isEmptySelection={isEmptySelection}
                        hasNoFiles={hasNoFiles}
                        topSpacerHeight={effectiveTopSpacerHeight}
                        settings={settings}
                        pinnedGroupExpanded={pinnedGroupExpanded}
                        onPinnedGroupHeaderToggle={handlePinnedGroupHeaderToggle}
                        selectionType={selectionType}
                        sortOption={effectiveSortOption}
                        searchHighlightQuery={searchHighlightQuery}
                        isFolderNavigation={selectionState.isFolderNavigation}
                        lastSelectedFilePath={lastSelectedFilePath}
                        isFileSelected={isFileSelected}
                        hoveredFilePath={hoveredFilePath}
                        suppressRowHover={isListScrolling}
                        onHoveredFilePathChange={handleHoveredFilePathChange}
                        onFileClick={handleFileItemClick}
                        onModifySearchWithTag={modifySearchWithTag}
                        onModifySearchWithProperty={modifySearchWithProperty}
                        localDayReference={localDayReference}
                        fileIconSize={listMeasurements.fileIconSize}
                        appearanceSettings={appearanceSettings}
                        includeDescendantNotes={includeDescendantNotes}
                        hiddenTagVisibility={hiddenTagVisibility}
                        fileNameIconNeedles={fileNameIconNeedles}
                        visibleListPropertyKeys={visibleListPropertyKeys}
                        visibleNavigationPropertyKeys={visibleNavigationPropertyKeys}
                        fileItemStorage={fileItemStorage}
                        noteShortcutKeysByPath={noteShortcutKeysByPath}
                        onToggleNoteShortcut={toggleNoteShortcut}
                        onNavigateToFolder={onNavigateToFolder}
                        folderDecorationModel={folderDecorationModel}
                        fileItemPillDecorationModel={fileItemPillDecorationModel}
                        getSolidBackground={getSolidBackground}
                    />
                    {/* iOS: keep the floating toolbar inside the panel */}
                    {shouldRenderBottomToolbarInsidePanel ? <div className="nn-pane-bottom-toolbar">{listToolbar}</div> : null}
                </div>
                {shouldRenderCalendarOverlay ? (
                    <div className="nn-navigation-calendar-overlay">
                        <Calendar onWeekCountChange={setCalendarWeekCount} onAddDateFilter={modifySearchWithDateToken} />
                    </div>
                ) : null}
                {shouldRenderBottomToolbarOutsidePanel ? <div className="nn-pane-bottom-toolbar">{listToolbar}</div> : null}
            </div>
        );
    })
);
