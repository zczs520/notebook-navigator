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

import { Setting } from 'obsidian';
import { strings } from '../../i18n';
import { DEFAULT_HEATMAP_LEVELS } from '../defaultSettings';
import type { HeatmapLevelSettings } from '../types';
import type { SettingsTabContext } from './SettingsTabContext';
import { createSettingGroupFactory } from '../settingGroups';

const HEX_COLOR_PATTERN = /^#[0-9a-f]{6}$/iu;

function sanitizeHeatmapNumber(value: string, fallback: number): number {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed)) {
        return fallback;
    }
    return Math.max(0, Math.min(999, parsed));
}

function sanitizeHeatmapColor(value: string, fallback: string): string {
    return HEX_COLOR_PATTERN.test(value) ? value : fallback;
}

function cloneDefaultHeatmapLevels(): HeatmapLevelSettings[] {
    return DEFAULT_HEATMAP_LEVELS.map(level => ({ ...level }));
}

/** Renders the note heatmap settings tab. */
export function renderHeatmapTab(context: SettingsTabContext): void {
    const { containerEl, plugin } = context;
    const createGroup = createSettingGroupFactory(containerEl);
    const heatmapGroup = createGroup(strings.settings.groups.heatmap.rules);

    const previewSetting = heatmapGroup.addSetting(setting => {
        setting.setName(strings.settings.items.heatmapPreview.name).setDesc('');
    });
    previewSetting.settingEl.addClass('nn-setting-info-container');
    previewSetting.descEl.empty();
    const previewEl = previewSetting.descEl.createDiv({ cls: 'nn-heatmap-settings-preview' });
    previewEl.createSpan({ text: strings.settings.items.heatmapPreview.less });
    const previewColorsEl = previewEl.createDiv({ cls: 'nn-heatmap-settings-preview-colors' });
    previewEl.createSpan({ text: strings.settings.items.heatmapPreview.more });

    const inputs: Array<{ minInput: HTMLInputElement; maxInput: HTMLInputElement; colorInput: HTMLInputElement }> = [];

    const renderPreview = (): void => {
        previewColorsEl.empty();
        plugin.settings.heatmapLevels.forEach(level => {
            previewColorsEl.createSpan({
                cls: 'nn-heatmap-settings-swatch',
                attr: { style: `background:${sanitizeHeatmapColor(level.color, DEFAULT_HEATMAP_LEVELS[0].color)}` }
            });
        });
    };

    const refreshInputs = (): void => {
        inputs.forEach((entry, index) => {
            const level = plugin.settings.heatmapLevels[index] ?? DEFAULT_HEATMAP_LEVELS[index];
            entry.minInput.value = String(level.min);
            entry.maxInput.value = String(level.max);
            entry.colorInput.value = sanitizeHeatmapColor(level.color, DEFAULT_HEATMAP_LEVELS[index].color);
        });
        renderPreview();
    };

    const saveLevel = async (index: number, patch: Partial<HeatmapLevelSettings>): Promise<void> => {
        const fallback = DEFAULT_HEATMAP_LEVELS[index];
        const current = plugin.settings.heatmapLevels[index] ?? fallback;
        const nextLevel = {
            min: patch.min ?? current.min,
            max: patch.max ?? current.max,
            color: patch.color ?? current.color
        };
        if (nextLevel.max <= nextLevel.min) {
            if (nextLevel.min >= 999) {
                nextLevel.min = 998;
                nextLevel.max = 999;
            } else {
                nextLevel.max = nextLevel.min + 1;
            }
        }

        const nextLevels = plugin.settings.heatmapLevels.map(level => ({ ...level }));
        nextLevels[index] = nextLevel;
        plugin.settings.heatmapLevels = nextLevels;
        refreshInputs();
        await plugin.saveSettingsAndUpdate();
    };

    DEFAULT_HEATMAP_LEVELS.forEach((defaultLevel, index) => {
        const levelLabel = strings.settings.items.heatmapLevel.name.replace('{level}', String(index + 1));
        const setting = heatmapGroup.addSetting(item => {
            item.setName(levelLabel).setDesc(strings.settings.items.heatmapLevel.desc);
        });
        setting.controlEl.addClass('nn-heatmap-level-control');

        const minInput = setting.controlEl.createEl('input', {
            type: 'number',
            attr: {
                min: '0',
                max: '998',
                step: '1',
                'aria-label': strings.settings.items.heatmapLevel.minLabel
            }
        });
        const separatorEl = setting.controlEl.createSpan({ text: strings.settings.items.heatmapLevel.rangeSeparator });
        const maxInput = setting.controlEl.createEl('input', {
            type: 'number',
            attr: {
                min: '1',
                max: '999',
                step: '1',
                'aria-label': strings.settings.items.heatmapLevel.maxLabel
            }
        });
        setting.controlEl.createSpan({ text: strings.settings.items.heatmapLevel.equalsLabel });
        const colorInput = setting.controlEl.createEl('input', {
            type: 'color',
            attr: {
                'aria-label': strings.settings.items.heatmapLevel.colorLabel
            }
        });

        minInput.addEventListener('change', () => {
            void saveLevel(index, { min: sanitizeHeatmapNumber(minInput.value, defaultLevel.min) });
        });
        maxInput.addEventListener('change', () => {
            void saveLevel(index, { max: sanitizeHeatmapNumber(maxInput.value, defaultLevel.max) });
        });
        colorInput.addEventListener('input', () => {
            void saveLevel(index, { color: sanitizeHeatmapColor(colorInput.value, defaultLevel.color) });
        });

        separatorEl.addClass('nn-heatmap-level-separator');
        inputs.push({ minInput, maxInput, colorInput });
    });

    heatmapGroup.addSetting(setting => {
        setting
            .setName(strings.settings.items.heatmapReset.name)
            .setDesc(strings.settings.items.heatmapReset.desc)
            .addButton(button =>
                button.setButtonText(strings.settings.items.heatmapReset.buttonText).onClick(async () => {
                    plugin.settings.heatmapLevels = cloneDefaultHeatmapLevels();
                    refreshInputs();
                    await plugin.saveSettingsAndUpdate();
                })
            );
    });

    refreshInputs();
}
