/**
 * Public API of the app-builder module.
 *
 * Consumers (pages, tests) import from here rather than from individual
 * files so internal refactoring does not ripple outward.
 */

export { AppBuilderCanvas } from "./AppBuilderCanvas.js";
export { ComponentPalette } from "./ComponentPalette.js";
export { ComponentWrapper } from "./ComponentWrapper.js";
export { ComponentConfigPanel } from "./ComponentConfigPanel.js";
export { ComponentPreview } from "./ComponentPreview.js";
export { DropZone } from "./DropZone.js";

export { useBuilderStore } from "./builder.store.js";

export {
  layoutToReactCode,
  reactCodeToLayout,
  dataBindingToHookSnippet,
} from "./code-generator.js";

export {
  createEmptyLayout,
  addRow,
  removeRow,
  moveRow,
  addColumn,
  removeColumn,
  placeComponent,
  removeComponent,
  updateComponentProps,
  updateComponentStyles,
  moveComponent,
  findComponent,
  findComponentByColumn,
  countComponents,
} from "./layout-helpers.js";

export {
  PALETTE_ENTRIES,
  PALETTE_CATEGORIES,
  getPaletteEntry,
} from "./palette-registry.js";

export type {
  AppLayout,
  LayoutRow,
  LayoutColumn,
  PlacedComponent,
  DataBinding,
  PaletteEntry,
  PropDescriptor,
  PropInputType,
  BuilderMode,
  DragState,
  DropTarget,
  ComponentCategory,
  ComponentConnection,
  SourceEvent,
  TargetAction,
} from "./types.js";
