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

import React, { forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { closestCenter, DndContext } from '@dnd-kit/core';
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { Platform, TFile } from 'obsidian';
import { Virtualizer } from '@tanstack/react-virtual';
import { useExpansionDispatch, useExpansionState } from '../../context/ExpansionContext';
import { useSelectionDispatch, useSelectionState } from '../../context/SelectionContext';
import { useServices, useMetadataService, useCommandQueue } from '../../context/ServicesContext';
import { useSettingsState, useSettingsUpdate, useActiveProfile } from '../../context/SettingsContext';
import { useUXPreferences } from '../../context/UXPreferencesContext';
import { useFileCache } from '../../context/StorageContext';
import { useUIState, useUIDispatch } from '../../context/UIStateContext';
import { useNavigationPaneKeyboard } from '../../hooks/useNavigationPaneKeyboard';
import { useNavigationPaneData } from '../../hooks/navigationPane/useNavigationPaneData';
import { useNavigationPaneScroll } from '../../hooks/useNavigationPaneScroll';
import { useNavigationRootReorder } from '../../hooks/useNavigationRootReorder';
import { useMeasuredElementHeight } from '../../hooks/useMeasuredElementHeight';
import { usePointerDrag } from '../../hooks/usePointerDrag';
import { useSurfaceColorVariables } from '../../hooks/useSurfaceColorVariables';
import { useNavigationPaneShortcuts } from '../../hooks/navigationPane/useNavigationPaneShortcuts';
import { useNavigationPaneTreeInteractions } from '../../hooks/navigationPane/useNavigationPaneTreeInteractions';
import { useNavigationSearchHighlights } from '../../hooks/navigationPane/useNavigationSearchHighlights';
import type { SearchNavFilterState } from '../../types/search';
import type { NoteCountInfo } from '../../types/noteCounts';
import type { InclusionOperator } from '../../utils/filterSearch';
import {
    IOS_FLOATING_TOOLBAR_HEIGHT_PX,
    ItemType,
    NavigationSectionId,
    NAVIGATION_PANE_DIMENSIONS,
    TAGS_ROOT_VIRTUAL_FOLDER_ID,
    type CSSPropertiesWithVars
} from '../../types';
import { STORAGE_KEYS } from '../../types';
import { Calendar } from '../calendar';
import { NavigationBanner } from '../NavigationBanner';
import { NavigationRootReorderPanel } from '../NavigationRootReorderPanel';
import { NavigationToolbar } from '../NavigationToolbar';
import { localStorage } from '../../utils/localStorage';
import { getSelectedPath } from '../../utils/selectionUtils';
import { buildIndentGuideLevelsMap, getNavigationIndex, normalizeNavigationPath } from '../../utils/navigationIndex';
import { collectAllTagPaths } from '../../utils/tagTree';
import type { TagTreeNode } from '../../types/storage';
import { normalizeNavigationSectionOrderInput } from '../../utils/navigationSections';
import { compositeWithBase } from '../../utils/colorUtils';
import { getActiveVaultProfile } from '../../utils/vaultProfiles';
import { PropertyKeyVisibilityModal } from '../../modals/PropertyKeyVisibilityModal';
import type { NavigateToFolderOptions, RevealPropertyOptions, RevealTagOptions } from '../../hooks/useNavigatorReveal';
import { NAVIGATION_PANE_SURFACE_COLOR_MAPPINGS } from '../../constants/surfaceColorMappings';
import { showNavigationSectionContextMenu } from '../../utils/contextMenu';
import { verticalAxisOnly } from '../../utils/dndConfig';
import { runAsyncAction } from '../../utils/async';
import { openFileInContext } from '../../utils/openFileInContext';
import type { CombinedNavigationItem } from '../../types/virtualization';
import { NavigationPaneItemRenderer } from './NavigationPaneItemRenderer';
import { NavigationPaneLayout } from './NavigationPaneLayout';
import type { NavigationPaneRowContext } from './NavigationPaneItemRenderer.types';
import type { NavigationRainbowState } from '../../hooks/useNavigationRainbowState';
import type { NavigationPaneSourceState } from '../../hooks/navigationPane/data/useNavigationPaneSourceState';
import type { NavigationPaneTreeSectionsResult } from '../../hooks/navigationPane/data/useNavigationPaneTreeSections';
import type { FolderDecorationModel } from '../../utils/folderDecoration';

const EMPTY_INDENT_GUIDE_MAP = new Map<string, number[]>();

export interface NavigationPaneHandle {
    getIndexOfPath: (itemType: ItemType, path: string) => number;
    virtualizer: Virtualizer<HTMLDivElement, Element> | null;
    scrollContainerRef: HTMLDivElement | null;
    requestScroll: (path: string, options: { align?: 'auto' | 'center' | 'start' | 'end'; itemType: ItemType }) => void;
    openShortcutByNumber: (shortcutNumber: number) => Promise<boolean>;
}

interface NavigationPaneProps {
    style?: React.CSSProperties;
    uiScale: number;
    rootContainerRef: React.RefObject<HTMLDivElement | null>;
    navigationSourceState: NavigationPaneSourceState;
    navigationTreeSections: NavigationPaneTreeSectionsResult;
    folderDecorationModel: FolderDecorationModel;
    navRainbowState: NavigationRainbowState;
    searchNavFilters?: SearchNavFilterState;
    onExecuteSearchShortcut?: (shortcutKey: string, searchShortcut: import('../../types/shortcuts').SearchShortcut) => Promise<void> | void;
    onNavigateToFolder: (folderPath: string, options?: NavigateToFolderOptions) => void;
    onRevealTag: (tagPath: string, options?: RevealTagOptions) => void;
    onRevealProperty: (propertyNodeId: string, options?: RevealPropertyOptions) => boolean;
    onRevealFile: (file: TFile) => void;
    onRevealShortcutFile?: (file: TFile) => void;
    onModifySearchWithTag: (tag: string, operator: InclusionOperator) => void;
    onModifySearchWithProperty: (key: string, value: string | null, operator: InclusionOperator) => void;
    onModifySearchWithDateFilter: (dateToken: string) => void;
}

export const NavigationPane = React.memo(
    forwardRef<NavigationPaneHandle, NavigationPaneProps>(function NavigationPane(props, ref) {
        const { app, isMobile, plugin, propertyTreeService } = useServices();
        const commandQueue = useCommandQueue();
        const metadataService = useMetadataService();
        const expansionState = useExpansionState();
        const expansionDispatch = useExpansionDispatch();
        const selectionState = useSelectionState();
        const selectionDispatch = useSelectionDispatch();
        const settings = useSettingsState();
        const activeProfile = useActiveProfile();
        const updateSettings = useSettingsUpdate();
        const uxPreferences = useUXPreferences();
        const uiState = useUIState();
        const uiDispatch = useUIDispatch();
        const { fileData, getFile, getFileDisplayName, getFileTimestamps, isStorageReady } = useFileCache();
        const getFileWordCount = useCallback(
            (file: TFile): number | null => {
                return getFile(file.path)?.wordCount ?? null;
            },
            [getFile]
        );
        const { startPointerDrag } = usePointerDrag();
        const {
            searchNavFilters,
            onExecuteSearchShortcut,
            rootContainerRef,
            onNavigateToFolder,
            onRevealTag,
            onRevealProperty,
            onRevealFile,
            onRevealShortcutFile,
            onModifySearchWithTag,
            onModifySearchWithProperty,
            onModifySearchWithDateFilter,
            uiScale
        } = props;

        const showHiddenItems = uxPreferences.showHiddenItems;
        const showCalendar = uxPreferences.showCalendar;
        const [selectedHeatmapDay, setSelectedHeatmapDay] = useState<string | null>(null);
        const navigationSummaryRef = useRef<HTMLDivElement>(null);
        const isVerticalDualPane = !uiState.singlePane && settings.dualPaneOrientation === 'vertical';
        const shouldRenderCalendarOverlay =
            settings.calendarEnabled &&
            settings.calendarPlacement === 'left-sidebar' &&
            showCalendar &&
            ((!uiState.singlePane && !isVerticalDualPane) ||
                (uiState.singlePane && settings.calendarLeftPlacement === 'navigation' && uiState.currentSinglePaneView === 'navigation'));

        const formatLocalDateKey = (date: Date): string => {
            const year = date.getFullYear();
            const month = `${date.getMonth() + 1}`.padStart(2, '0');
            const day = `${date.getDate()}`.padStart(2, '0');
            return `${year}-${month}-${day}`;
        };

        const navigationSummary = useMemo(() => {
            const markdownFiles = app.vault.getMarkdownFiles();
            const tagPaths = new Set<string>();
            fileData.tagTree.forEach(node => {
                collectAllTagPaths(node).forEach(tagPath => tagPaths.add(tagPath));
            });
            const today = new Date();
            today.setHours(0, 0, 0, 0);
            const dayMs = 24 * 60 * 60 * 1000;
            const buckets = new Map<number, number>();
            const countByDate = new Map<string, number>();
            const notesByDate = new Map<string, TFile[]>();
            const activeDateKeys = new Set<string>();
            const heatmapDayCount = 84;
            markdownFiles.forEach(file => {
                const day = new Date(file.stat.ctime);
                day.setHours(0, 0, 0, 0);
                const dateKey = formatLocalDateKey(day);
                activeDateKeys.add(dateKey);
                const notes = notesByDate.get(dateKey) ?? [];
                notes.push(file);
                notesByDate.set(dateKey, notes);
                const age = Math.floor((today.getTime() - day.getTime()) / dayMs);
                if (age >= 0 && age < heatmapDayCount) {
                    const index = heatmapDayCount - 1 - age;
                    buckets.set(index, (buckets.get(index) ?? 0) + 1);
                    countByDate.set(dateKey, (countByDate.get(dateKey) ?? 0) + 1);
                }
            });
            const days = Array.from({ length: heatmapDayCount }, (_, index) => {
                const date = new Date(today);
                date.setDate(today.getDate() - (heatmapDayCount - 1 - index));
                const dateKey = formatLocalDateKey(date);
                const notes = [...(notesByDate.get(dateKey) ?? [])].sort((a, b) => b.stat.ctime - a.stat.ctime);
                const count = countByDate.get(dateKey) ?? 0;
                return {
                    date,
                    dateKey,
                    count,
                    notes
                };
            });
            const monthLabels = [days[0], days[Math.floor(days.length / 2)], days[days.length - 1]].map(
                day => `${day.date.getMonth() + 1}月`
            );
            return {
                markdownCount: markdownFiles.length,
                tagCount: tagPaths.size,
                activeDays: activeDateKeys.size,
                days,
                monthLabels,
                maxBucket: Math.max(1, ...buckets.values())
            };
        }, [app.vault, fileData.tagTree, isStorageReady]);
        const selectedHeatmapEntry = navigationSummary.days.find(day => day.dateKey === selectedHeatmapDay) ?? null;
        const selectedHeatmapNotes = selectedHeatmapEntry?.notes ?? [];
        const handleHeatmapNoteOpen = useCallback(
            (event: React.MouseEvent<HTMLButtonElement>, file: TFile) => {
                event.preventDefault();
                event.stopPropagation();
                event.currentTarget.blur();
                runAsyncAction(() => openFileInContext({ app, commandQueue, file, context: 'tab' }));
            },
            [app, commandQueue]
        );
        const handleHeatmapClose = useCallback((event: React.MouseEvent<HTMLButtonElement>) => {
            event.preventDefault();
            event.stopPropagation();
            event.currentTarget.blur();
            setSelectedHeatmapDay(null);
        }, []);
        const handleHeatmapFilter = useCallback(
            (event: React.MouseEvent<HTMLButtonElement>, dateKey: string) => {
                event.preventDefault();
                event.stopPropagation();
                event.currentTarget.blur();
                onModifySearchWithDateFilter(`@c:${dateKey}`);
            },
            [onModifySearchWithDateFilter]
        );

        const navigationSummaryContent = (
            <div className="nn-xhs-nav-summary" ref={navigationSummaryRef}>
                <div className="nn-xhs-nav-stats">
                    <div className="nn-xhs-nav-stat">
                        <strong>{navigationSummary.markdownCount}</strong>
                        <span>笔记</span>
                    </div>
                    <div className="nn-xhs-nav-stat">
                        <strong>{navigationSummary.tagCount}</strong>
                        <span>标签</span>
                    </div>
                    <div className="nn-xhs-nav-stat">
                        <strong>{navigationSummary.activeDays}</strong>
                        <span>天</span>
                    </div>
                </div>
                <div className="nn-xhs-heatmap-card">
                    <div className="nn-xhs-heatmap" aria-label="笔记热力图">
                        {navigationSummary.days.map(day => {
                            const level =
                                day.count === 0 ? 0 : Math.max(1, Math.min(4, Math.ceil((day.count / navigationSummary.maxBucket) * 4)));
                            const isSelected = selectedHeatmapDay === day.dateKey;
                            return (
                                <button
                                    key={day.dateKey}
                                    type="button"
                                    data-level={level}
                                    className={isSelected ? 'is-selected' : ''}
                                    title={`${day.dateKey} · ${day.count} 篇笔记`}
                                    aria-label={`${day.dateKey}，${day.count} 篇笔记`}
                                    disabled={day.count === 0}
                                    onPointerDown={event => {
                                        event.preventDefault();
                                    }}
                                    onClick={event => {
                                        event.preventDefault();
                                        event.stopPropagation();
                                        event.currentTarget.blur();
                                        setSelectedHeatmapDay(day.dateKey);
                                    }}
                                />
                            );
                        })}
                    </div>
                    <div className="nn-xhs-heatmap-months" aria-hidden="true">
                        {navigationSummary.monthLabels.map((label, index) => (
                            <span key={`${label}-${index}`}>{label}</span>
                        ))}
                    </div>
                    {selectedHeatmapEntry ? (
                        <div
                            className="nn-xhs-heatmap-popover"
                            onPointerDown={event => {
                                event.preventDefault();
                            }}
                            onClick={event => {
                                event.stopPropagation();
                            }}
                        >
                            <div className="nn-xhs-heatmap-popover-header">
                                <div>
                                    <strong>{selectedHeatmapEntry.dateKey}</strong>
                                    <span>{selectedHeatmapEntry.count} 篇笔记</span>
                                </div>
                                <button type="button" aria-label="关闭" onClick={handleHeatmapClose}>
                                    ×
                                </button>
                            </div>
                            <div className="nn-xhs-heatmap-note-list">
                                {selectedHeatmapNotes.slice(0, 6).map(file => (
                                    <button key={file.path} type="button" onClick={event => handleHeatmapNoteOpen(event, file)}>
                                        {getFileDisplayName(file)}
                                    </button>
                                ))}
                            </div>
                            {selectedHeatmapNotes.length > 6 ? (
                                <div className="nn-xhs-heatmap-more">还有 {selectedHeatmapNotes.length - 6} 篇</div>
                            ) : null}
                            <button
                                type="button"
                                className="nn-xhs-heatmap-filter"
                                onClick={event => handleHeatmapFilter(event, selectedHeatmapEntry.dateKey)}
                            >
                                筛选当天
                            </button>
                        </div>
                    ) : null}
                </div>
            </div>
        );

        const [calendarWeekCount, setCalendarWeekCount] = useState<number>(() => settings.calendarWeeksToShow);
        useEffect(() => {
            if (settings.calendarWeeksToShow !== 6) {
                setCalendarWeekCount(settings.calendarWeeksToShow);
            }
        }, [settings.calendarWeeksToShow]);

        const navigationPaneRef = useRef<HTMLDivElement>(null);
        const navigationBannerRef = useRef<HTMLDivElement>(null);
        const pinnedShortcutsContainerRef = useRef<HTMLDivElement>(null);
        const [pinnedShortcutsScrollElement, setPinnedShortcutsScrollElement] = useState<HTMLDivElement | null>(null);
        const [pinnedShortcutsHasOverflow, setPinnedShortcutsHasOverflow] = useState(false);
        const pinnedShortcutsResizeFrameRef = useRef<number | null>(null);
        const pinnedShortcutsResizeHeightRef = useRef<number>(0);
        const scaleFactor = Number.isFinite(uiScale) && uiScale > 0 ? uiScale : 1;

        const pinnedShortcutsScrollRefCallback = useCallback((node: HTMLDivElement | null) => {
            setPinnedShortcutsScrollElement(node);
        }, []);

        const [pinnedShortcutsMaxHeight, setPinnedShortcutsMaxHeight] = useState<number | null>(() => {
            const stored = localStorage.get<number>(STORAGE_KEYS.pinnedShortcutsMaxHeightKey);
            if (typeof stored !== 'number' || !Number.isFinite(stored) || stored <= 0) {
                return null;
            }
            return Math.max(NAVIGATION_PANE_DIMENSIONS.pinnedShortcutsMinHeight, Math.round(stored));
        });
        const [isPinnedShortcutsResizing, setIsPinnedShortcutsResizing] = useState(false);

        const updatePinnedShortcutsOverflow = useCallback(
            (element?: HTMLDivElement | null) => {
                const target = element ?? pinnedShortcutsScrollElement;
                if (!target) {
                    setPinnedShortcutsHasOverflow(false);
                    return;
                }

                const hasOverflow = target.scrollHeight - target.clientHeight > 1;
                setPinnedShortcutsHasOverflow(prev => (prev === hasOverflow ? prev : hasOverflow));
            },
            [pinnedShortcutsScrollElement]
        );

        const schedulePinnedShortcutsHeightUpdate = useCallback((height: number) => {
            pinnedShortcutsResizeHeightRef.current = height;
            if (pinnedShortcutsResizeFrameRef.current !== null) {
                return;
            }
            pinnedShortcutsResizeFrameRef.current = window.requestAnimationFrame(() => {
                pinnedShortcutsResizeFrameRef.current = null;
                setPinnedShortcutsMaxHeight(pinnedShortcutsResizeHeightRef.current);
            });
        }, []);

        useEffect(() => {
            return () => {
                if (pinnedShortcutsResizeFrameRef.current !== null) {
                    cancelAnimationFrame(pinnedShortcutsResizeFrameRef.current);
                    pinnedShortcutsResizeFrameRef.current = null;
                }
            };
        }, []);

        useLayoutEffect(() => {
            const element = pinnedShortcutsScrollElement;
            if (!element) {
                setPinnedShortcutsHasOverflow(false);
                return;
            }

            updatePinnedShortcutsOverflow(element);

            if (typeof ResizeObserver === 'undefined') {
                return;
            }

            const resizeObserver = new ResizeObserver(() => {
                updatePinnedShortcutsOverflow(element);
            });
            resizeObserver.observe(element);

            return () => {
                resizeObserver.disconnect();
            };
        }, [pinnedShortcutsScrollElement, updatePinnedShortcutsOverflow]);

        const handlePinnedShortcutsResizePointerDown = useCallback(
            (event: React.PointerEvent<HTMLDivElement>) => {
                if (event.pointerType === 'mouse' && event.button !== 0) {
                    return;
                }

                const pinnedElement = pinnedShortcutsContainerRef.current;
                const scrollElement = pinnedShortcutsScrollElement;
                if (!pinnedElement || !scrollElement) {
                    return;
                }

                const shouldTrackResizeState = !isMobile;
                const handleHeight = Math.round(event.currentTarget.getBoundingClientRect().height / scaleFactor);
                const maxAllowed = Math.round(scrollElement.scrollHeight + handleHeight);
                const minAllowed = Math.min(NAVIGATION_PANE_DIMENSIONS.pinnedShortcutsMinHeight, maxAllowed);
                const startMaxHeight = Math.min(Math.round(pinnedElement.getBoundingClientRect().height / scaleFactor), maxAllowed);
                const startY = event.clientY;
                let currentMaxHeight = startMaxHeight;

                event.preventDefault();
                event.stopPropagation();

                if (shouldTrackResizeState) {
                    setIsPinnedShortcutsResizing(true);
                }

                const clamp = (value: number) => Math.min(Math.max(value, minAllowed), maxAllowed);
                schedulePinnedShortcutsHeightUpdate(currentMaxHeight);

                startPointerDrag({
                    event,
                    onMove: (moveEvent: PointerEvent) => {
                        const deltaY = (moveEvent.clientY - startY) / scaleFactor;
                        currentMaxHeight = clamp(startMaxHeight + deltaY);
                        schedulePinnedShortcutsHeightUpdate(currentMaxHeight);
                    },
                    onEnd: () => {
                        if (pinnedShortcutsResizeFrameRef.current !== null) {
                            cancelAnimationFrame(pinnedShortcutsResizeFrameRef.current);
                            pinnedShortcutsResizeFrameRef.current = null;
                        }
                        const contentFitHeight = Math.round(scrollElement.scrollHeight + handleHeight);
                        if (currentMaxHeight >= contentFitHeight - 2) {
                            setPinnedShortcutsMaxHeight(null);
                            localStorage.remove(STORAGE_KEYS.pinnedShortcutsMaxHeightKey);
                        } else {
                            localStorage.set(STORAGE_KEYS.pinnedShortcutsMaxHeightKey, currentMaxHeight);
                            setPinnedShortcutsMaxHeight(currentMaxHeight);
                        }
                        if (shouldTrackResizeState) {
                            setIsPinnedShortcutsResizing(false);
                        }
                    }
                });
            },
            [isMobile, pinnedShortcutsScrollElement, scaleFactor, schedulePinnedShortcutsHeightUpdate, startPointerDrag]
        );

        const [sectionOrder, setSectionOrder] = useState<NavigationSectionId[]>(() => {
            const stored = localStorage.get<unknown>(STORAGE_KEYS.navigationSectionOrderKey);
            return normalizeNavigationSectionOrderInput(stored);
        });
        const [foldersSectionExpanded, setFoldersSectionExpanded] = useState(true);
        const [tagsSectionExpanded, setTagsSectionExpanded] = useState(true);
        const [propertiesSectionExpanded, setPropertiesSectionExpanded] = useState(true);
        const handleToggleFoldersSection = useCallback(() => {
            setFoldersSectionExpanded(prev => !prev);
        }, []);
        const handleToggleTagsSection = useCallback(() => {
            setTagsSectionExpanded(prev => !prev);
        }, []);
        const handleTogglePropertiesSection = useCallback(() => {
            setPropertiesSectionExpanded(prev => !prev);
        }, []);
        const [isRootReorderMode, setRootReorderMode] = useState(false);

        const handleConfigurePropertyKeysFromSectionMenu = useCallback(() => {
            const profile = getActiveVaultProfile(plugin.settings);
            const modal = new PropertyKeyVisibilityModal(app, {
                initialKeys: profile.propertyKeys,
                onSave: async nextKeys => {
                    profile.propertyKeys = nextKeys;
                    await plugin.saveSettingsAndUpdate();
                }
            });
            modal.open();
        }, [app, plugin]);

        const folderCountsRef = useRef<Map<string, NoteCountInfo>>(new Map());
        const tagCountsRef = useRef<Map<string, NoteCountInfo>>(new Map());
        const propertyCountsRef = useRef<Map<string, NoteCountInfo>>(new Map());

        const shortcuts = useNavigationPaneShortcuts({
            rootContainerRef,
            isRootReorderMode,
            onExecuteSearchShortcut,
            onNavigateToFolder,
            onRevealTag,
            onRevealProperty,
            onRevealFile,
            onRevealShortcutFile,
            getFolderCounts: () => folderCountsRef.current,
            getTagCounts: () => tagCountsRef.current,
            getPropertyCounts: () => propertyCountsRef.current,
            onConfigurePropertyKeys: handleConfigurePropertyKeysFromSectionMenu
        });

        const isVisible = uiState.dualPane || uiState.currentSinglePaneView === 'navigation';
        const {
            items,
            firstSectionId,
            firstInlineFolderPath,
            shortcutItems,
            pinnedRecentNotesItems,
            shouldPinRecentNotes,
            tagsVirtualFolderHasChildren,
            propertiesSectionActive,
            pathToIndex,
            tagCounts,
            propertyCounts,
            folderCounts,
            rootLevelFolders,
            missingRootFolderPaths,
            resolvedRootTagKeys,
            rootOrderingTagTree,
            missingRootTagPaths,
            resolvedRootPropertyKeys,
            rootOrderingPropertyTree,
            missingRootPropertyKeys,
            vaultChangeVersion,
            navigationBannerPath
        } = useNavigationPaneData({
            settings,
            isVisible,
            sourceState: props.navigationSourceState,
            treeSections: props.navigationTreeSections,
            folderDecorationModel: props.folderDecorationModel,
            navRainbowState: props.navRainbowState,
            shortcutsExpanded: shortcuts.shortcutsExpanded,
            recentNotesExpanded: shortcuts.recentNotesExpanded,
            pinShortcuts: uiState.pinShortcuts && settings.showShortcuts,
            sectionOrder
        });
        folderCountsRef.current = folderCounts;
        tagCountsRef.current = tagCounts;
        propertyCountsRef.current = propertyCounts;

        const tree = useNavigationPaneTreeInteractions({
            app,
            commandQueue,
            isMobile,
            settings,
            uiState,
            expansionState,
            expansionDispatch,
            selectionState,
            selectionDispatch,
            uiDispatch,
            propertyTreeService,
            tagTree: props.navigationTreeSections.renderTagTree,
            propertyTree: props.navigationTreeSections.renderPropertyTree,
            tagsVirtualFolderHasChildren,
            setShortcutsExpanded: shortcuts.setShortcutsExpanded,
            setRecentNotesExpanded: shortcuts.setRecentNotesExpanded,
            clearActiveShortcut: shortcuts.clearActiveShortcut,
            onModifySearchWithTag,
            onModifySearchWithProperty
        });

        const searchHighlights = useNavigationSearchHighlights({ searchNavFilters });

        useEffect(() => {
            if (!isStorageReady) {
                return;
            }

            const shouldCleanupTags = expansionState.expandedTags.size > 0;
            const shouldCleanupProperties = expansionState.expandedProperties.size > 0;
            if (!shouldCleanupTags && !shouldCleanupProperties) {
                return;
            }

            const existingTags = shouldCleanupTags ? new Set<string>() : null;
            const existingPropertyNodeIds = shouldCleanupProperties ? new Set<string>() : null;

            if (existingTags) {
                const visitedTagNodes = new Set<TagTreeNode>();
                fileData.tagTree.forEach(rootTagNode => {
                    collectAllTagPaths(rootTagNode, existingTags, visitedTagNodes);
                });
            }

            if (existingPropertyNodeIds) {
                fileData.propertyTree.forEach(keyNode => {
                    existingPropertyNodeIds.add(keyNode.id);
                    keyNode.children.forEach(valueNode => {
                        existingPropertyNodeIds.add(valueNode.id);
                    });
                });
            }

            if (existingTags) {
                expansionDispatch({ type: 'CLEANUP_DELETED_TAGS', existingTags });
            }

            if (existingPropertyNodeIds) {
                expansionDispatch({ type: 'CLEANUP_DELETED_PROPERTIES', existingPropertyNodeIds });
            }
        }, [
            expansionDispatch,
            expansionState.expandedProperties.size,
            expansionState.expandedTags.size,
            fileData.propertyTree,
            fileData.tagTree,
            isStorageReady
        ]);

        const indentGuideLevelsByKey = useMemo(
            () => (settings.showIndentGuides ? buildIndentGuideLevelsMap(items) : EMPTY_INDENT_GUIDE_MAP),
            [items, settings.showIndentGuides]
        );

        const pinnedNavigationItems = useMemo(() => {
            const pinnedShortcutItems = uiState.pinShortcuts && settings.showShortcuts ? shortcutItems : [];
            const pinnedRecentItems = shouldPinRecentNotes ? pinnedRecentNotesItems : [];
            const pinnedNavigationOrder = normalizeNavigationSectionOrderInput(sectionOrder);

            const ordered: CombinedNavigationItem[] = [];
            pinnedNavigationOrder.forEach(sectionId => {
                if (sectionId === NavigationSectionId.RECENT && shouldPinRecentNotes) {
                    ordered.push(...pinnedRecentItems);
                }
                if (sectionId === NavigationSectionId.SHORTCUTS && uiState.pinShortcuts && settings.showShortcuts) {
                    ordered.push(...pinnedShortcutItems);
                }
            });
            return ordered;
        }, [pinnedRecentNotesItems, sectionOrder, settings.showShortcuts, shortcutItems, shouldPinRecentNotes, uiState.pinShortcuts]);

        const shouldRenderNavigationBanner = Boolean(navigationBannerPath && !isRootReorderMode);
        const navigationBannerContent =
            shouldRenderNavigationBanner && navigationBannerPath ? <NavigationBanner path={navigationBannerPath} /> : null;
        const shouldRenderPinnedShortcuts = pinnedNavigationItems.length > 0 && !isRootReorderMode;

        useLayoutEffect(() => {
            updatePinnedShortcutsOverflow(pinnedShortcutsScrollElement);
        }, [pinnedNavigationItems, pinnedShortcutsScrollElement, updatePinnedShortcutsOverflow]);

        const navigationBannerHeight = useMeasuredElementHeight(navigationBannerRef, {
            enabled: Boolean(navigationBannerContent) && !settings.pinNavigationBanner
        });
        const navigationSummaryHeight = useMeasuredElementHeight(navigationSummaryRef, {
            enabled: !isRootReorderMode
        });
        const pinnedShortcutsHeight = useMeasuredElementHeight(pinnedShortcutsContainerRef, {
            enabled: isMobile && shouldRenderPinnedShortcuts && !isRootReorderMode
        });
        const navigationScrollMargin = navigationBannerHeight + navigationSummaryHeight + pinnedShortcutsHeight;
        const hasNavigationBannerConfigured = Boolean(navigationBannerPath);

        const { color: navSurfaceColor, version: navSurfaceVersion } = useSurfaceColorVariables(navigationPaneRef, {
            app,
            rootContainerRef,
            variables: NAVIGATION_PANE_SURFACE_COLOR_MAPPINGS
        });
        const activeNavRainbow = props.navRainbowState.navRainbow;
        const solidBackgroundCacheRef = useRef<Map<string, string | undefined>>(new Map());
        useEffect(() => {
            solidBackgroundCacheRef.current.clear();
        }, [activeNavRainbow, navSurfaceColor, navSurfaceVersion]);

        const getSolidBackground = useCallback(
            (color?: string | null) => {
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
                const pane = navigationPaneRef.current;
                const solidColor = compositeWithBase(navSurfaceColor, trimmed, { container: pane ?? null });
                cache.set(trimmed, solidColor);
                return solidColor;
            },
            [navSurfaceColor]
        );

        const {
            reorderableRootFolders,
            reorderableRootTags,
            reorderableRootProperties,
            sectionReorderItems,
            folderReorderItems,
            tagReorderItems,
            propertyReorderItems,
            canReorderSections,
            canReorderRootFolders,
            canReorderRootTags,
            canReorderRootProperties,
            canReorderRootItems,
            showRootFolderSection,
            showRootTagSection,
            showRootPropertySection,
            resetRootTagOrderLabel,
            resetRootPropertyOrderLabel,
            handleResetRootFolderOrder,
            handleResetRootTagOrder,
            handleResetRootPropertyOrder,
            reorderSectionOrder,
            reorderRootFolderOrder,
            reorderRootTagOrder,
            reorderRootPropertyOrder
        } = useNavigationRootReorder({
            app,
            items,
            settings,
            showHiddenItems,
            updateSettings,
            sectionOrder,
            setSectionOrder,
            rootLevelFolders,
            missingRootFolderPaths,
            resolvedRootTagKeys,
            rootOrderingTagTree,
            missingRootTagPaths,
            resolvedRootPropertyKeys,
            rootOrderingPropertyTree,
            missingRootPropertyKeys,
            metadataService,
            foldersSectionExpanded,
            tagsSectionExpanded,
            propertiesSectionExpanded,
            propertiesSectionActive,
            handleToggleFoldersSection,
            handleToggleTagsSection,
            handleTogglePropertiesSection,
            activeProfile
        });

        useEffect(() => {
            if (isRootReorderMode && !canReorderRootItems) {
                setRootReorderMode(false);
            }
        }, [canReorderRootItems, isRootReorderMode]);

        const handleToggleRootReorder = useCallback(() => {
            if (!canReorderRootItems) {
                return;
            }
            setRootReorderMode(prev => !prev);
        }, [canReorderRootItems]);

        const isAndroid = Platform.isAndroidApp;
        const shouldUseFloatingToolbars = isMobile && Platform.isIosApp && settings.useFloatingToolbars;
        const scrollPaddingEnd = useMemo(() => {
            if (!shouldUseFloatingToolbars) {
                return 0;
            }
            return IOS_FLOATING_TOOLBAR_HEIGHT_PX;
        }, [shouldUseFloatingToolbars]);

        const { rowVirtualizer, scrollContainerRef, scrollContainerRefCallback, requestScroll } = useNavigationPaneScroll({
            items,
            pathToIndex,
            isVisible,
            activeShortcutKey: shortcuts.activeShortcutKey,
            scrollMargin: navigationScrollMargin,
            scrollPaddingEnd
        });

        useEffect(() => {
            if (isRootReorderMode) {
                return;
            }
            rowVirtualizer.measure();
        }, [
            isRootReorderMode,
            navigationScrollMargin,
            reorderableRootFolders,
            reorderableRootProperties,
            reorderableRootTags,
            rowVirtualizer,
            sectionOrder
        ]);

        useEffect(() => {
            if (!isRootReorderMode) {
                return;
            }
            rowVirtualizer.scrollToOffset(0, { align: 'start', behavior: 'auto' });
            const scroller = scrollContainerRef.current;
            if (scroller) {
                scroller.scrollTo({ top: 0, behavior: 'auto' });
            }
        }, [isRootReorderMode, rowVirtualizer, scrollContainerRef]);

        const handleTreeUpdateComplete = useCallback(() => {
            const selectedPath = getSelectedPath(selectionState);
            if (!selectedPath) {
                return;
            }

            const itemType =
                selectionState.selectionType === ItemType.TAG
                    ? ItemType.TAG
                    : selectionState.selectionType === ItemType.PROPERTY
                      ? ItemType.PROPERTY
                      : ItemType.FOLDER;
            requestScroll(normalizeNavigationPath(itemType, selectedPath), { align: 'auto', itemType });
        }, [requestScroll, selectionState]);

        const prevCalendarOverlayVisibleRef = useRef<boolean>(shouldRenderCalendarOverlay);
        const prevCalendarWeekCountRef = useRef<number>(calendarWeekCount);
        const prevShowAllTagsFolder = useRef(settings.showAllTagsFolder);
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

            const scheduleScroll = () => handleTreeUpdateComplete();
            if (typeof requestAnimationFrame !== 'undefined') {
                requestAnimationFrame(() => {
                    requestAnimationFrame(scheduleScroll);
                });
                return;
            }

            activeWindow.setTimeout(scheduleScroll, 0);
        }, [calendarWeekCount, handleTreeUpdateComplete, shouldRenderCalendarOverlay]);

        useEffect(() => {
            if (settings.showAllTagsFolder) {
                const shouldAutoExpandTags = !prevShowAllTagsFolder.current && settings.showAllTagsFolder;
                if (shouldAutoExpandTags && !expansionState.expandedVirtualFolders.has(TAGS_ROOT_VIRTUAL_FOLDER_ID)) {
                    expansionDispatch({ type: 'TOGGLE_VIRTUAL_FOLDER_EXPANDED', folderId: TAGS_ROOT_VIRTUAL_FOLDER_ID });
                }
            }
            prevShowAllTagsFolder.current = settings.showAllTagsFolder;
        }, [expansionDispatch, expansionState.expandedVirtualFolders, settings.showAllTagsFolder]);

        useImperativeHandle(
            ref,
            () => ({
                getIndexOfPath: (itemType: ItemType, path: string) => {
                    const index = getNavigationIndex(pathToIndex, itemType, path);
                    return index ?? -1;
                },
                virtualizer: rowVirtualizer,
                scrollContainerRef: scrollContainerRef.current,
                requestScroll,
                openShortcutByNumber: shortcuts.openShortcutByNumber
            }),
            [pathToIndex, requestScroll, rowVirtualizer, scrollContainerRef, shortcuts.openShortcutByNumber]
        );

        const keyboardItems = isRootReorderMode ? [] : items;
        const keyboardPathToIndex = isRootReorderMode ? new Map<string, number>() : pathToIndex;
        useNavigationPaneKeyboard({
            items: keyboardItems,
            virtualizer: rowVirtualizer,
            containerRef: props.rootContainerRef,
            pathToIndex: keyboardPathToIndex
        });

        const navigationPaneStyle = useMemo<CSSPropertiesWithVars>(() => {
            return {
                ...(props.style ?? {}),
                '--nn-calendar-week-count': calendarWeekCount
            };
        }, [calendarWeekCount, props.style]);

        const navigationToolbar = useMemo(() => {
            return (
                <NavigationToolbar
                    onTreeUpdateComplete={handleTreeUpdateComplete}
                    onToggleRootFolderReorder={handleToggleRootReorder}
                    rootReorderActive={isRootReorderMode}
                    rootReorderDisabled={!canReorderRootItems}
                />
            );
        }, [canReorderRootItems, handleToggleRootReorder, handleTreeUpdateComplete, isRootReorderMode]);

        const showVaultTitleInHeader =
            !isMobile && (settings.vaultProfiles ?? []).length > 1 && (settings.vaultTitle ?? 'navigation') === 'header';
        const shouldShowVaultTitleInNavigationPane =
            !isMobile && (settings.vaultProfiles ?? []).length > 1 && (settings.vaultTitle ?? 'navigation') === 'navigation';

        const handleSectionContextMenu = useCallback(
            (event: React.MouseEvent<HTMLDivElement>, sectionId: NavigationSectionId, options?: { allowSeparator?: boolean }) => {
                showNavigationSectionContextMenu({
                    app,
                    event,
                    sectionId,
                    allowSeparator: options?.allowSeparator,
                    metadataService,
                    settings,
                    plugin,
                    pinToggleLabel: shortcuts.pinToggleLabel,
                    isShortcutsPinned: uiState.pinShortcuts,
                    onToggleShortcutsPin: shortcuts.handleShortcutSplitToggle,
                    onConfigurePropertyKeys: handleConfigurePropertyKeysFromSectionMenu,
                    shortcutActions: {
                        shortcutsCount: shortcuts.shortcutsCount,
                        tagShortcutKeysByPath: shortcuts.tagShortcutKeysByPath,
                        propertyShortcutKeysByNodeId: shortcuts.propertyShortcutKeysByNodeId,
                        addTagShortcut: shortcuts.addTagShortcut,
                        addPropertyShortcut: shortcuts.addPropertyShortcut,
                        removeShortcut: shortcuts.removeShortcut,
                        clearShortcuts: shortcuts.clearShortcuts
                    }
                });
            },
            [app, handleConfigurePropertyKeysFromSectionMenu, metadataService, plugin, settings, shortcuts, uiState.pinShortcuts]
        );

        const rowContext = useMemo<NavigationPaneRowContext>(
            () => ({
                app,
                settings,
                isMobile,
                expansionState,
                expansionDispatch,
                selectionState,
                indentGuideLevelsByKey,
                firstSectionId,
                firstInlineFolderPath,
                shouldPinShortcuts: uiState.pinShortcuts && settings.showShortcuts,
                showHiddenItems,
                shortcutsExpanded: shortcuts.shortcutsExpanded,
                recentNotesExpanded: shortcuts.recentNotesExpanded,
                folderCounts,
                tagCounts,
                propertyCounts,
                vaultChangeVersion,
                fileVisibility: activeProfile.fileVisibility,
                hiddenFolders: activeProfile.hiddenFolders,
                getFileDisplayName,
                getFileTimestamps,
                getFileWordCount,
                getSolidBackground,
                shortcuts,
                tree,
                searchHighlights,
                onSectionContextMenu: handleSectionContextMenu
            }),
            [
                app,
                expansionDispatch,
                expansionState,
                firstInlineFolderPath,
                firstSectionId,
                folderCounts,
                activeProfile.fileVisibility,
                activeProfile.hiddenFolders,
                getFileDisplayName,
                getFileTimestamps,
                getFileWordCount,
                getSolidBackground,
                handleSectionContextMenu,
                indentGuideLevelsByKey,
                isMobile,
                propertyCounts,
                searchHighlights,
                selectionState,
                settings,
                shortcuts,
                showHiddenItems,
                tagCounts,
                tree,
                uiState.pinShortcuts,
                vaultChangeVersion
            ]
        );

        const renderNavigationItem = useCallback(
            (item: CombinedNavigationItem) => <NavigationPaneItemRenderer item={item} context={rowContext} />,
            [rowContext]
        );

        const rootReorderContent = (
            <NavigationRootReorderPanel
                sectionItems={sectionReorderItems}
                folderItems={folderReorderItems}
                tagItems={tagReorderItems}
                propertyItems={propertyReorderItems}
                showRootFolderSection={showRootFolderSection}
                showRootTagSection={showRootTagSection}
                showRootPropertySection={showRootPropertySection}
                foldersSectionExpanded={foldersSectionExpanded}
                tagsSectionExpanded={tagsSectionExpanded}
                propertiesSectionExpanded={propertiesSectionExpanded}
                showRootFolderReset={settings.rootFolderOrder.length > 0}
                showRootTagReset={settings.rootTagOrder.length > 0}
                showRootPropertyReset={settings.rootPropertyOrder.length > 0}
                resetRootTagOrderLabel={resetRootTagOrderLabel}
                resetRootPropertyOrderLabel={resetRootPropertyOrderLabel}
                onResetRootFolderOrder={handleResetRootFolderOrder}
                onResetRootTagOrder={handleResetRootTagOrder}
                onResetRootPropertyOrder={handleResetRootPropertyOrder}
                onReorderSections={reorderSectionOrder}
                onReorderFolders={reorderRootFolderOrder}
                onReorderTags={reorderRootTagOrder}
                onReorderProperties={reorderRootPropertyOrder}
                canReorderSections={canReorderSections}
                canReorderFolders={canReorderRootFolders}
                canReorderTags={canReorderRootTags}
                canReorderProperties={canReorderRootProperties}
                isMobile={isMobile}
            />
        );

        return (
            <DndContext
                sensors={shortcuts.shouldUseShortcutDnd ? shortcuts.shortcutSensors : []}
                collisionDetection={shortcuts.shouldUseShortcutDnd ? closestCenter : undefined}
                modifiers={shortcuts.shouldUseShortcutDnd ? [verticalAxisOnly] : undefined}
                onDragStart={shortcuts.shouldUseShortcutDnd ? shortcuts.handleShortcutDragStart : undefined}
                onDragEnd={shortcuts.shouldUseShortcutDnd ? shortcuts.handleShortcutDragEnd : undefined}
                onDragCancel={shortcuts.shouldUseShortcutDnd ? shortcuts.handleShortcutDragCancel : undefined}
                autoScroll={shortcuts.shouldUseShortcutDnd ? false : undefined}
            >
                <SortableContext items={shortcuts.shouldUseShortcutDnd ? shortcuts.shortcutIds : []} strategy={verticalListSortingStrategy}>
                    <NavigationPaneLayout
                        navigationPaneRef={navigationPaneRef}
                        navigationPaneStyle={navigationPaneStyle}
                        shouldRenderCalendarOverlay={shouldRenderCalendarOverlay}
                        isShortcutSorting={shortcuts.isShortcutSorting}
                        isMobile={isMobile}
                        isPinnedShortcutsResizing={isPinnedShortcutsResizing}
                        onTreeUpdateComplete={handleTreeUpdateComplete}
                        onToggleRootReorder={handleToggleRootReorder}
                        rootReorderActive={isRootReorderMode}
                        rootReorderDisabled={!canReorderRootItems}
                        showVaultTitleInHeader={showVaultTitleInHeader}
                        shouldShowVaultTitleInNavigationPane={shouldShowVaultTitleInNavigationPane}
                        showAndroidToolbar={isMobile && isAndroid}
                        navigationToolbar={navigationToolbar}
                        pinNavigationBanner={settings.pinNavigationBanner}
                        navigationBannerContent={navigationBannerContent}
                        navigationSummaryContent={navigationSummaryContent}
                        shouldRenderPinnedShortcuts={shouldRenderPinnedShortcuts}
                        pinnedShortcutsContainerRef={pinnedShortcutsContainerRef}
                        pinnedShortcutsHasOverflow={pinnedShortcutsHasOverflow}
                        pinnedShortcutsMaxHeight={pinnedShortcutsMaxHeight}
                        allowEmptyShortcutDrop={shortcuts.allowEmptyShortcutDrop}
                        onShortcutRootDragOver={shortcuts.handleShortcutRootDragOver}
                        onShortcutRootDrop={shortcuts.handleShortcutRootDrop}
                        pinnedShortcutsScrollRefCallback={pinnedShortcutsScrollRefCallback}
                        pinnedNavigationItems={pinnedNavigationItems}
                        renderNavigationItem={renderNavigationItem}
                        onPinnedShortcutsResizePointerDown={handlePinnedShortcutsResizePointerDown}
                        scrollContainerRefCallback={scrollContainerRefCallback}
                        hasNavigationBannerConfigured={hasNavigationBannerConfigured}
                        navigationBannerRef={navigationBannerRef}
                        rootReorderContent={rootReorderContent}
                        isRootReorderMode={isRootReorderMode}
                        items={items}
                        rowVirtualizer={rowVirtualizer}
                        navigationScrollMargin={navigationScrollMargin}
                        shouldRenderBottomToolbarInsidePanel={isMobile && !isAndroid && shouldUseFloatingToolbars}
                        shouldRenderBottomToolbarOutsidePanel={isMobile && !isAndroid && !shouldUseFloatingToolbars}
                        calendarOverlay={
                            shouldRenderCalendarOverlay ? (
                                <div className="nn-navigation-calendar-overlay">
                                    <Calendar onWeekCountChange={setCalendarWeekCount} onAddDateFilter={onModifySearchWithDateFilter} />
                                </div>
                            ) : null
                        }
                    />
                </SortableContext>
            </DndContext>
        );
    })
);
