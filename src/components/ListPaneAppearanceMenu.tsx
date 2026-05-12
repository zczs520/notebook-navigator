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

import { Menu, TFolder } from 'obsidian';
import { strings } from '../i18n';
import { FolderAppearance, getDefaultListMode, resolveListMode } from '../hooks/useListPaneAppearance';
import type { NotePropertyType, ListDisplayMode } from '../settings/types';
import { NotebookNavigatorSettings } from '../settings';
import { ItemType } from '../types';
import { runAsyncAction } from '../utils/async';
import { ensureRecord, sanitizeRecord } from '../utils/recordUtils';
import { resolveUXIconForMenu } from '../utils/uxIcons';
import type { PropertySelectionNodeId } from '../utils/propertyTree';

interface AppearanceMenuProps {
    event: MouseEvent;
    settings: NotebookNavigatorSettings;
    selectedFolder: TFolder | null;
    selectedTag?: string | null;
    selectedProperty?: PropertySelectionNodeId | null;
    selectionType?: ItemType;
    updateSettings: (updater: (settings: NotebookNavigatorSettings) => void) => Promise<void>;
    descendantAction?: {
        menuTitle: string;
        onApply: () => void;
        disabled?: boolean;
    };
    defaultSettingsAction?: {
        menuTitle: string;
        onOpen: () => void;
        disabled?: boolean;
    };
}

interface AppearanceRecordAccessor {
    key: string;
    getRecord: (settings: NotebookNavigatorSettings) => Record<string, FolderAppearance> | undefined;
    setRecord: (settings: NotebookNavigatorSettings, next: Record<string, FolderAppearance>) => void;
}

function getNotePropertyIcon(type: NotePropertyType, settings: NotebookNavigatorSettings): string {
    return type === 'wordCount' ? resolveUXIconForMenu(settings.interfaceIcons, 'file-word-count', 'lucide-sigma') : 'lucide-minus';
}

export function showListPaneAppearanceMenu({
    event,
    settings,
    selectedFolder,
    selectedTag,
    selectedProperty,
    selectionType,
    updateSettings,
    descendantAction,
    defaultSettingsAction
}: AppearanceMenuProps) {
    const defaultMode: ListDisplayMode = getDefaultListMode(settings);
    const resolveAppearanceAccessor = (): AppearanceRecordAccessor | null => {
        if (selectionType === ItemType.TAG && selectedTag) {
            return {
                key: selectedTag,
                getRecord: targetSettings => targetSettings.tagAppearances,
                setRecord: (targetSettings, next) => {
                    targetSettings.tagAppearances = next;
                }
            };
        }
        if (selectionType === ItemType.FOLDER && selectedFolder) {
            return {
                key: selectedFolder.path,
                getRecord: targetSettings => targetSettings.folderAppearances,
                setRecord: (targetSettings, next) => {
                    targetSettings.folderAppearances = next;
                }
            };
        }
        if (selectionType === ItemType.PROPERTY && selectedProperty) {
            return {
                key: selectedProperty,
                getRecord: targetSettings => targetSettings.propertyAppearances,
                setRecord: (targetSettings, next) => {
                    targetSettings.propertyAppearances = next;
                }
            };
        }
        return null;
    };
    const appearanceAccessor = resolveAppearanceAccessor();

    const updateAppearance = (updates: Partial<FolderAppearance>) => {
        const normalizeAppearance = (appearance: FolderAppearance) => {
            const normalized = { ...appearance };
            (Object.keys(normalized) as (keyof FolderAppearance)[]).forEach(key => {
                if (normalized[key] === undefined) {
                    delete normalized[key];
                }
            });
            if (normalized.mode === defaultMode) {
                delete normalized.mode;
            }
            return normalized;
        };

        if (!appearanceAccessor) {
            return;
        }

        runAsyncAction(() =>
            updateSettings(s => {
                const next = sanitizeRecord(ensureRecord(appearanceAccessor.getRecord(s)));
                const currentAppearance = next[appearanceAccessor.key] || {};
                const normalizedAppearance = normalizeAppearance({ ...currentAppearance, ...updates });
                if (Object.keys(normalizedAppearance).length === 0) {
                    delete next[appearanceAccessor.key];
                } else {
                    next[appearanceAccessor.key] = normalizedAppearance;
                }

                appearanceAccessor.setRecord(s, next);
            })
        );
    };

    const menu = new Menu();

    // Get custom appearance settings for the selected folder/tag
    // Will be undefined if no custom appearance has been set
    const appearance = appearanceAccessor ? appearanceAccessor.getRecord(settings)?.[appearanceAccessor.key] : undefined;
    const effectiveMode = resolveListMode({ appearance, defaultMode });

    const isStandard = effectiveMode === 'standard';
    const isCompact = effectiveMode === 'compact';
    const isGallery = effectiveMode === 'gallery';
    const isFeed = effectiveMode === 'feed';

    menu.addItem(item => {
        item.setTitle(strings.folderAppearance.appearance).setIcon('lucide-palette').setDisabled(true);
    });

    // Standard preset
    menu.addItem(item => {
        const label =
            defaultMode === 'standard'
                ? `${strings.folderAppearance.standardPreset} ${strings.folderAppearance.defaultSuffix}`
                : strings.folderAppearance.standardPreset;
        item.setTitle(label)
            .setIcon('lucide-list')
            .setChecked(isStandard)
            .onClick(() => {
                updateAppearance({ mode: 'standard' });
            });
    });

    // Compact preset
    menu.addItem(item => {
        const label =
            defaultMode === 'compact'
                ? `${strings.folderAppearance.compactPreset} ${strings.folderAppearance.defaultSuffix}`
                : strings.folderAppearance.compactPreset;
        item.setTitle(label)
            .setIcon('lucide-align-left')
            .setChecked(isCompact)
            .onClick(() => {
                updateAppearance({ mode: 'compact', previewRows: undefined });
            });
    });

    // Gallery preset
    menu.addItem(item => {
        const label =
            defaultMode === 'gallery'
                ? `${strings.folderAppearance.galleryPreset} ${strings.folderAppearance.defaultSuffix}`
                : strings.folderAppearance.galleryPreset;
        item.setTitle(label)
            .setIcon('lucide-layout-grid')
            .setChecked(isGallery)
            .onClick(() => {
                updateAppearance({ mode: 'gallery', previewRows: undefined });
            });
    });

    menu.addItem(item => {
        const label =
            defaultMode === 'feed'
                ? `${strings.folderAppearance.feedPreset} ${strings.folderAppearance.defaultSuffix}`
                : strings.folderAppearance.feedPreset;
        item.setTitle(label)
            .setIcon('lucide-rows-3')
            .setChecked(isFeed)
            .onClick(() => {
                updateAppearance({ mode: 'feed', previewRows: undefined });
            });
    });

    menu.addSeparator();

    // Title rows header
    menu.addItem(item => {
        item.setTitle(strings.folderAppearance.titleRows).setIcon('lucide-text').setDisabled(true);
    });

    // Default title rows option
    menu.addItem(item => {
        const hasCustomTitleRows = appearance?.titleRows !== undefined;
        const isDefaultTitle = !hasCustomTitleRows;
        item.setTitle(`    ${strings.folderAppearance.defaultTitleOption(settings.fileNameRows)}`)
            .setIcon('lucide-text')
            .setChecked(isDefaultTitle)
            .onClick(() => {
                updateAppearance({ titleRows: undefined });
            });
    });

    // Title row options
    [1, 2, 3].forEach(rows => {
        menu.addItem(item => {
            const isChecked = appearance?.titleRows === rows;
            item.setTitle(`    ${strings.folderAppearance.titleRowOption(rows)}`)
                .setIcon('lucide-text')
                .setChecked(isChecked)
                .onClick(() => {
                    updateAppearance({ titleRows: rows });
                });
        });
    });

    if (settings.showFilePreview && !isCompact) {
        menu.addSeparator();

        // Preview rows header
        menu.addItem(item => {
            item.setTitle(strings.folderAppearance.previewRows).setIcon('lucide-file-text').setDisabled(true);
        });

        // Default preview rows option
        menu.addItem(item => {
            const hasCustomPreviewRows = appearance?.previewRows !== undefined;
            const isDefaultPreview = !hasCustomPreviewRows;
            item.setTitle(`    ${strings.folderAppearance.defaultPreviewOption(settings.previewRows)}`)
                .setIcon('lucide-file-text')
                .setChecked(isDefaultPreview)
                .onClick(() => {
                    updateAppearance({ previewRows: undefined });
                });
        });

        // Preview row options
        [1, 2, 3, 4, 5].forEach(rows => {
            menu.addItem(item => {
                const hasCustomPreviewRows = appearance?.previewRows !== undefined;
                const isChecked = hasCustomPreviewRows && appearance?.previewRows === rows;
                item.setTitle(`    ${strings.folderAppearance.previewRowOption(rows)}`)
                    .setIcon('lucide-file-text')
                    .setChecked(isChecked)
                    .onClick(() => {
                        updateAppearance({ previewRows: rows });
                    });
            });
        });
    }

    const isFolderSelection = selectionType === ItemType.FOLDER && Boolean(selectedFolder);
    const isTagSelection = selectionType === ItemType.TAG && Boolean(selectedTag);
    const isPropertySelection = selectionType === ItemType.PROPERTY && Boolean(selectedProperty);

    // Add note property section for folders, tags, and properties
    if (isFolderSelection || isTagSelection || isPropertySelection) {
        const getNotePropertyTypeLabel = (type: NotePropertyType): string => {
            switch (type) {
                case 'wordCount':
                    return strings.settings.items.notePropertyType.options.wordCount;
                case 'none':
                default:
                    return strings.settings.items.notePropertyType.options.none;
            }
        };

        menu.addSeparator();

        // Note property header
        menu.addItem(item => {
            item.setTitle(strings.settings.items.notePropertyType.name)
                .setIcon(resolveUXIconForMenu(settings.interfaceIcons, 'file-word-count', 'lucide-sigma'))
                .setDisabled(true);
        });

        // Default note property option (clears custom override)
        const defaultNotePropertyLabel = getNotePropertyTypeLabel(settings.notePropertyType);
        const currentNotePropertyType = appearance?.notePropertyType;
        const hasNotePropertyType = currentNotePropertyType !== undefined;
        menu.addItem(item => {
            item.setTitle(`    ${strings.folderAppearance.defaultLabel} (${defaultNotePropertyLabel})`)
                .setIcon(getNotePropertyIcon(settings.notePropertyType, settings))
                .setChecked(!hasNotePropertyType)
                .onClick(() => {
                    updateAppearance({ notePropertyType: undefined });
                });
        });

        // Note property options
        const notePropertyOptions: NotePropertyType[] = ['none', 'wordCount'];
        notePropertyOptions.forEach(option => {
            menu.addItem(item => {
                const isChecked = hasNotePropertyType && currentNotePropertyType === option;
                const label = getNotePropertyTypeLabel(option);
                item.setTitle(`    ${label}`)
                    .setIcon(getNotePropertyIcon(option, settings))
                    .setChecked(isChecked)
                    .onClick(() => {
                        updateAppearance({ notePropertyType: option });
                    });
            });
        });
    }

    if (descendantAction) {
        menu.addSeparator();
        menu.addItem(item => {
            item.setTitle(descendantAction.menuTitle)
                .setIcon('lucide-squares-unite')
                .setDisabled(Boolean(descendantAction.disabled))
                .onClick(() => {
                    descendantAction.onApply();
                });
        });
    }

    if (defaultSettingsAction) {
        menu.addSeparator();
        menu.addItem(item => {
            item.setTitle(defaultSettingsAction.menuTitle)
                .setIcon('lucide-settings')
                .setDisabled(Boolean(defaultSettingsAction.disabled))
                .onClick(() => {
                    defaultSettingsAction.onOpen();
                });
        });
    }

    menu.showAtMouseEvent(event);
}
